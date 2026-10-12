import {api,type Snapshot} from "./client";
const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
function notice(text:string,error=false){el("message").textContent=text;el("message").classList.toggle("error",error);}
export function initTokens(){
 let issuingToken=false,canIssueToken=false;
 async function refresh(){
  try{const state=await api<Snapshot>("/api/v1/application");
   el("signed-out").hidden=true;el("signed-in").hidden=false;
   el("refresh-linkedin").hidden=state.profile.emailVerified;
   el("identity").textContent=`Signed in as ${state.profile.name}`;
   el("consent-section").hidden=state.status==="approved"||state.consentCurrent;
   canIssueToken=state.profile.emailVerified&&(state.status==="approved"||state.consentCurrent);
   el<HTMLButtonElement>("issue-token").disabled=!canIssueToken||issuingToken;
   if(!issuingToken)el("issue-token").textContent=state.tokenActive?"Regenerate token":"Generate token";
   el("token-status").textContent=canIssueToken?state.tokenActive?"A token is active. Regenerate it to replace it.":"Generate a token, then give the snippet to your agent.":!state.profile.emailVerified?"LinkedIn did not confirm your email. Refresh LinkedIn sign-in before generating a token.":"Save consent to enable token generation.";
   notice("Manage your API access here. Your application is on its own page.");
  }catch(error){if((error as {status?:number}).status===401){el("signed-out").hidden=false;el("signed-in").hidden=true;notice("Sign in with LinkedIn to manage API tokens.");}else notice((error as Error).message,true);}
 }
 el("consent-form").addEventListener("submit",async event=>{event.preventDefault();const form=event.currentTarget as HTMLFormElement;if(!form.reportValidity())return;const button=form.querySelector<HTMLButtonElement>("button")!;button.disabled=true;try{await api("/api/application-consent","POST",{consent:true});await refresh();}catch(error){notice((error as Error).message,true);}finally{button.disabled=false;}});
 function action(id:string,fn:()=>Promise<void>){el(id).addEventListener("click",async()=>{const button=el<HTMLButtonElement>(id);button.disabled=true;try{await fn();}catch(error){notice((error as Error).message,true);}finally{button.disabled=false;}});}
  el("issue-token").addEventListener("click", async () => {
    if (issuingToken || !canIssueToken) return;
    issuingToken = true;
    const button = el<HTMLButtonElement>("issue-token");
    const status = el("token-status");
    button.disabled = true;
    status.classList.remove("error");
    status.textContent = "Creating your token…";
    const slowMessage = window.setTimeout(() => {
      status.textContent = "Still creating your token. Please keep this page open.";
    }, 8000);
    try {
      const result = await api<{ token: string }>(
        "/api/application-token", "POST", undefined, undefined,
        AbortSignal.timeout(60000),
      );
      el("token-output").hidden = false;
      el("token-snippet").textContent = `curl ${location.origin}/api/v1/application \\
  -H "Authorization: Bearer ${result.token}"`;
      button.textContent = "Regenerate token";
      status.textContent = "Token created. Copy it now; it is shown only once.";
      el("token-output").scrollIntoView({ block: "nearest" });
      notice("Token created. Previous tokens are no longer valid.");
    } catch (error) {
      const message = (error as Error).name === "TimeoutError"
        ? "Token creation timed out. It may have succeeded; generating again will replace any earlier token."
        : (error as Error).message;
      status.textContent = message;
      status.classList.add("error");
      notice(message, true);
    } finally {
      window.clearTimeout(slowMessage);
      issuingToken = false;
      button.disabled = !canIssueToken;
    }
  });
  action("copy-token", async () => {
    await navigator.clipboard.writeText(el("token-snippet").textContent ?? "");
    notice("Snippet copied.");
  });
 void refresh();
}
