import {it,expect,vi} from "vitest";
import {onRequest} from "../../functions/admin/[[path]]";
it("serves the administrator page only after a successful server-side authorization", async () => {
  for (const status of [200,401,403,503]) {
    const next=vi.fn(async()=>new Response("private dashboard"));
    const response=await onRequest({request:new Request("https://genaicommunity.ai/admin/"),env:{ADMISSIONS:{fetch:async()=>new Response(null,{status})}},next});
    expect(next).toHaveBeenCalledTimes(status===200?1:0);
    expect(response.status).toBe(status===401?302:status);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    if(status!==200) expect(await response.text()).not.toContain("private dashboard");
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
