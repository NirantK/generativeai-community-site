import {it,expect,vi} from "vitest";
import {onRequest} from "../../functions/admin/[[path]]";
import {onRequest as appPage} from "../../functions/app/[[path]]";
it("guards every workspace view and chooses the role-appropriate landing page",async()=>{
 for(const path of ["/app/","/app/applications/","/app/message-review/","/app/roles/","/app/search/"]) for(const administrator of [true,false]) for(const status of [200,401,503]){
  const next=vi.fn(async()=>new Response("private workspace"));
  const response=await appPage({request:new Request(`https://genaicommunity.ai${path}`),env:{ADMISSIONS:{fetch:async request=>{expect(new URL(request.url).pathname).toBe("/api/app/access");return Response.json({administrator},{status});}}},next});
  const allowed=status===200&&path!=="/app/"&&(administrator||path==="/app/search/");
  expect(next).toHaveBeenCalledTimes(allowed?1:0);
  expect(response.status).toBe(status===401?302:status===503?503:path==="/app/"?302:allowed?200:403);
  expect(response.headers.get("Cache-Control")).toContain("no-store");
  if(status===200&&path==="/app/")expect(response.headers.get("Location")).toBe(administrator?"/app/applications":"/app/search");
 }
});
it("redirects old admin bookmarks only after authorization",async()=>{
 for(const [path,destination] of [["/admin/","/app"],["/admin/applications/","/app/applications"],["/admin/message-reviews/","/app/message-review"],["/admin/chats/","/app/search"]])for(const status of [200,401,403,503]){
  const next=vi.fn();const response=await onRequest({request:new Request(`https://genaicommunity.ai${path}`),env:{ADMISSIONS:{fetch:async()=>new Response(null,{status})}},next});
  expect(next).not.toHaveBeenCalled();expect(response.status).toBe(status===200||status===401?302:status);
  if(status===200)expect(response.headers.get("Location")).toBe(destination);
 }
});

import {onRequest as memberPage} from "../../functions/past-chats/[[path]]";
it("serves a useful Past Chats shell while keeping archive data gated",async()=>{
  for (const status of [401,403]) {
    const next=vi.fn(async()=>new Response("member archive"));
    const response=await memberPage({request:new Request("https://genaicommunity.ai/past-chats"),env:{ADMISSIONS:{fetch:async(request)=>{expect(new URL(request.url).pathname).toBe("/api/v1/chats/access");return new Response(null,{status});}}},next});
    expect(response.status).toBe(200);expect(next).toHaveBeenCalledTimes(1);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(await response.text()).toContain("member archive");
  }
  const next=vi.fn(async()=>new Response("member archive"));
  const unavailable=await memberPage({request:new Request("https://genaicommunity.ai/past-chats"),env:{ADMISSIONS:{fetch:async()=>new Response(null,{status:503})}},next});
  expect(unavailable.status).toBe(503);expect(next).not.toHaveBeenCalled();
});
