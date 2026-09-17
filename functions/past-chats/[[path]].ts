interface Context {
  request: Request;
  env: { ADMISSIONS?: { fetch(request: Request): Promise<Response> } };
  next(): Promise<Response>;
}
export async function onRequest({ request, env, next }: Context): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Robots-Tag": "noindex" };
  if (!env.ADMISSIONS) return new Response("Past Chats is temporarily unavailable.", { status: 503, headers });
  const url = new URL(request.url); url.pathname = "/api/v1/chats/access"; url.search = "";
  const access = await env.ADMISSIONS.fetch(new Request(url, { headers: request.headers }));
  // Keep the page shell public so visitors get a useful explanation and a
  // clear application path. The Worker API remains membership-gated and never
  // returns archive data to unauthenticated or unapproved visitors.
  if (!access.ok && access.status !== 401 && access.status !== 403)
    return new Response("Past Chats is temporarily unavailable.", { status: 503, headers });
  const asset = await next();
  const response = new Response(asset.body, asset);
  for (const [key,value] of Object.entries(headers)) response.headers.set(key,value);
  return response;
}
