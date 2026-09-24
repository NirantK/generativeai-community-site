import { z } from "zod";
import { ApiError, body, json } from "./security";

export const models = {
  "mys/laya-typed-decisions-GGUF": {
    description: "Typed choices, scores, and yes/no decisions for operational workflows.",
    sourceUrl: "https://huggingface.co/mys/laya-typed-decisions-GGUF",
    upstreamUrl: "https://huggingface.co/convaiinnovations/laya-typed-decisions",
    runtimeUrl: "https://github.com/monatis/ggmlc/tree/v0.9.2/examples/laya",
    license: "Apache-2.0",
    endpoint: "https://scaledfocus--genaicommunity-laya-typed-decisions-gguf-laya.us-east.modal.direct/v1/decide",
    gpu: "T4",
  },
  "mys/laya-multilingual-GGUF": {
    description: "Multilingual typed choices, scores, and yes/no decisions using the full F16 checkpoint.",
    sourceUrl: "https://huggingface.co/mys/laya-multilingual-GGUF",
    upstreamUrl: "https://huggingface.co/convaiinnovations/laya-multilingual",
    runtimeUrl: "https://github.com/monatis/ggmlc/tree/v0.9.2/examples/laya",
    license: "Apache-2.0",
    endpoint: "https://scaledfocus--genaicommunity-laya-multilingual-gguf-laya.us-east.modal.direct/v1/decide",
    gpu: "T4",
  },
  "HopitAI/hopper": {
    description: "Calibrated one-pass typed decisions using Hopper's pinned fast-kernel BF16 runtime.",
    sourceUrl: "https://huggingface.co/HopitAI/hopper",
    upstreamUrl: "https://github.com/hopit-ai/hopper/tree/v1.1.0",
    runtimeUrl: "https://github.com/hopit-ai/hopper/tree/v1.1.0",
    license: "Apache-2.0",
    endpoint: "https://scaledfocus--genaicommunity-hopper-hopper.us-east.modal.direct/v1/decide",
    gpu: "A10",
  },
} as const;

const requestSchema = z.object({
  model: z.string().min(1).max(100),
  state: z.unknown(),
  questions: z.record(z.string().min(1).max(100), z.object({
    type: z.enum(["choice", "score", "noul"]),
    instructions: z.string().min(1).max(2000),
    criteria: z.union([z.record(z.string(), z.string().nullable()), z.array(z.string())]).optional(),
  }).passthrough()),
}).strict();

function selectedModel(name: string) {
  if (!Object.hasOwn(models, name))
    throw new ApiError(404, "model_not_found", "This model is not available.");
  return models[name as keyof typeof models];
}

async function totals(env: Env, accountId: string, model: string) {
  const result = await env.INDEX.prepare(
    "SELECT COUNT(*) AS request_count, COALESCE(SUM(gpu_microseconds),0) AS gpu_microseconds FROM model_usage WHERE account_id=? AND model=?",
  ).bind(accountId, model).first<{ request_count: number; gpu_microseconds: number }>();
  return {
    requestCount: result?.request_count ?? 0,
    gpuSeconds: (result?.gpu_microseconds ?? 0) / 1_000_000,
  };
}

async function infer(req: Request, env: Env, accountId: string) {
  const input = requestSchema.parse(await body(req));
  const model = selectedModel(input.model);
  if (input.state === null || input.state === undefined || Object.keys(input.questions).length < 1 || Object.keys(input.questions).length > 16)
    throw new ApiError(422, "validation", "Supply a state and 1–16 typed questions.");
  if (input.model === "HopitAI/hopper") {
    if (Object.keys(input.questions).length !== 1)
      throw new ApiError(422, "validation", "Hopper accepts exactly one question per request.");
    const question = Object.values(input.questions)[0];
    if (question.type === "score" && (!Array.isArray(question.criteria) || question.criteria.length < 2 || question.criteria.length > 26))
      throw new ApiError(422, "validation", "Hopper scores require an array of 2–26 level descriptions.");
    if (question.type === "choice" && (!question.criteria || Array.isArray(question.criteria) || Object.keys(question.criteria).length < 2 || Object.keys(question.criteria).length > 26))
      throw new ApiError(422, "validation", "Hopper choices require a map of 2–26 option descriptions.");
    if (question.type === "noul" && Array.isArray(question.criteria))
      throw new ApiError(422, "validation", "Hopper yes/no criteria must be a map when supplied.");
  }
  if (!env.MODAL_PROXY_TOKEN)
    throw new ApiError(503, "model_unavailable", "Model access is temporarily unavailable.");

  const payload = JSON.stringify({ state: input.state, questions: input.questions });
  let upstream: Response | undefined;
  // Modal can return 503 while a scaled-to-zero T4 starts. Those responses
  // have no GPU measurement and are safe to retry before the model is called.
  // Hopper's first A10 activation includes fast-kernel compilation and can
  // take longer than a Laya startup. Only unmetered platform 503s are retried.
  const startupAttempts = input.model === "HopitAI/hopper" ? 75 : 30;
  for (let attempt = 0; attempt < startupAttempts; attempt++) {
    try {
      upstream = await fetch(model.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.MODAL_PROXY_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: AbortSignal.timeout(95_000),
      });
    } catch {
      throw new ApiError(503, "model_unavailable", "The model could not be reached. Try again.");
    }
    if (upstream.status !== 503 || upstream.headers.has("X-GPU-Seconds")) break;
    await upstream.body?.cancel();
    if (attempt === startupAttempts - 1) throw new ApiError(503, "model_starting", "The model is still starting. Try again shortly.");
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!upstream) throw new ApiError(503, "model_unavailable", "The model could not be reached.");
  const measured = Number(upstream.headers.get("X-GPU-Seconds"));
  if (!upstream.headers.has("X-GPU-Seconds") || !Number.isFinite(measured) || measured < 0 || measured > 95)
    throw new ApiError(502, "meter_unavailable", "The model did not report a valid GPU duration.");
  const microseconds = Math.round(measured * 1_000_000);
  let result: unknown = null;
  let validJson = true;
  try { result = await upstream.json(); }
  catch { validJson = false; }
  const id = crypto.randomUUID();
  await env.INDEX.prepare(
    "INSERT INTO model_usage(id,account_id,model,gpu_microseconds,http_status,created_at) VALUES(?,?,?,?,?,?)",
  ).bind(id, accountId, input.model, microseconds, upstream.status, Date.now()).run();
  const total = await totals(env, accountId, input.model);
  return json({
    id, model: input.model, result,
    usage: { gpu: model.gpu, unit: `${model.gpu} seconds`, measurement: "inference", gpuSeconds: microseconds / 1_000_000, totalGpuSeconds: total.gpuSeconds, requestCount: total.requestCount },
    ...(!validJson ? { error: { code: "model_response", message: "The model returned an invalid response." } } : {}),
  }, !validJson ? 502 : upstream.ok ? 200 : upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502);
}

export async function modelApi(req: Request, env: Env, accountId: string, path: string): Promise<Response> {
  if (path === "/api/v1/models" && req.method === "GET")
    return json({ models: Object.entries(models).map(([name, model]) => ({ name, description: model.description, gpu: model.gpu, sourceUrl: model.sourceUrl, upstreamUrl: model.upstreamUrl, runtimeUrl: model.runtimeUrl, license: model.license })) });
  if (path === "/api/v1/models/usage" && req.method === "GET") {
    const name = new URL(req.url).searchParams.get("model");
    if (!name) throw new ApiError(400, "model_required", "Supply a model name.");
    const model = selectedModel(name);
    return json({ model: name, usage: { gpu: model.gpu, unit: `${model.gpu} seconds`, measurement: "inference", ...await totals(env, accountId, name) } });
  }
  if (path === "/api/v1/models/infer" && req.method === "POST") return infer(req, env, accountId);
  throw new ApiError(404, "not_found", "Model endpoint not found.");
}
