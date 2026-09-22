import { z } from "zod";
import { ApiError, body, json } from "./security";

export const models = {
  "laya-typed-decisions": {
    description: "Typed choices, scores, and yes/no decisions for operational workflows.",
    endpoint: "https://scaledfocus--genaicommunity-laya-typed-decisions-gguf-laya.us-east.modal.direct/v1/decide",
    gpu: "T4",
  },
} as const;

const requestSchema = z.object({
  model: z.string().min(1).max(100),
  state: z.unknown(),
  questions: z.record(z.string().min(1).max(100), z.object({
    type: z.enum(["choice", "score", "noul"]),
    instructions: z.string().min(1).max(2000),
    criteria: z.record(z.string(), z.string().nullable()).optional(),
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
  if (!env.MODAL_PROXY_TOKEN)
    throw new ApiError(503, "model_unavailable", "Model access is temporarily unavailable.");

  const payload = JSON.stringify({ state: input.state, questions: input.questions });
  let upstream: Response | undefined;
  // Modal can return 503 while a scaled-to-zero T4 starts. Those responses
  // have no GPU measurement and are safe to retry before the model is called.
  for (let attempt = 0; attempt < 30; attempt++) {
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
    if (attempt === 29) throw new ApiError(503, "model_starting", "The model is still starting. Try again shortly.");
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
    usage: { gpuSeconds: microseconds / 1_000_000, totalGpuSeconds: total.gpuSeconds, requestCount: total.requestCount },
    ...(!validJson ? { error: { code: "model_response", message: "The model returned an invalid response." } } : {}),
  }, !validJson ? 502 : upstream.ok ? 200 : upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502);
}

export async function modelApi(req: Request, env: Env, accountId: string, path: string): Promise<Response> {
  if (path === "/api/v1/models" && req.method === "GET")
    return json({ models: Object.entries(models).map(([name, model]) => ({ name, description: model.description, gpu: model.gpu })) });
  if (path === "/api/v1/models/usage" && req.method === "GET") {
    const name = new URL(req.url).searchParams.get("model");
    if (!name) throw new ApiError(400, "model_required", "Supply a model name.");
    selectedModel(name);
    return json({ model: name, usage: await totals(env, accountId, name) });
  }
  if (path === "/api/v1/models/infer" && req.method === "POST") return infer(req, env, accountId);
  throw new ApiError(404, "not_found", "Model endpoint not found.");
}
