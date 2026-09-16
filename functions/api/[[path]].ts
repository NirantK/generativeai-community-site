interface Env {
  ADMISSIONS: { fetch(request: Request): Promise<Response> };
}
export const onRequest = ({ request, env }: { request: Request; env: Env }) => {
  if (!env.ADMISSIONS) return Response.json({ error: { code: 'admissions_unavailable', message: 'Applications are temporarily unavailable. Please try again later.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  return env.ADMISSIONS.fetch(request);
};
