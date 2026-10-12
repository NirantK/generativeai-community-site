interface Context {
  request: Request;
  env: { ADMISSIONS?: { fetch(request: Request): Promise<Response> } };
  next(): Promise<Response>;
}
export async function onRequest({ request, env, next }: Context): Promise<Response> {
  const headers = { "Cache-Control": "private, no-store", "Vary": "Cookie", "X-Robots-Tag": "noindex" };
  if (!env.ADMISSIONS) return new Response("Administration is temporarily unavailable.", { status: 503, headers });
  const url = new URL(request.url); url.pathname = "/api/admin/access"; url.search = "";
  const access = await env.ADMISSIONS.fetch(new Request(url, { headers: request.headers }));
  if (access.status === 401) return new Response(null, { status: 302, headers: { ...headers, Location: "/apply" } });
  if (!access.ok) return new Response(access.status === 403 ? "Administrator access required." : "Administration is temporarily unavailable.", { status: access.status === 403 ? 403 : 503, headers });
  const path = new URL(request.url).pathname.replace(/\/$/, "");
  const destinations: Record<string,string> = {"/admin":"/app", "/admin/applications":"/app/applications", "/admin/message-reviews":"/app/message-review", "/admin/chats":"/app/search"};
  if (destinations[path]) return new Response(null, {status:302,headers:{...headers,Location:destinations[path]}});
  return new Response("Not found",{status:404,headers});
}
