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
