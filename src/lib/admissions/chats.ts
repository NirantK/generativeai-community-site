type Chat = {id:string;groupTitle?:string;author:string;postedAt:number;text:string};
type Group = {id:string;title:string;published:number;messageCount:number;firstMessageAt:number|null;lastMessageAt:number|null;importedAt:number;coverageNote:string};
export function initChatArchive() {
  const el=(id:string)=>document.getElementById(id)!;
  const administrator=el("chat-archive").dataset.administrator === "true";
  const base=administrator ? "/api/admin/chats" : "/api/v1/chats";
  let cursor:string|null=null, query=new URLSearchParams(), generation=0;
  async function api<T>(path:string,method="GET",data?:unknown):Promise<T> {
    const response=await fetch(base+path,{method,headers:data?{"Content-Type":"application/json"}:{},body:data?JSON.stringify(data):undefined});
    if(!response.headers.get("content-type")?.includes("application/json")) throw new Error("Archive temporarily unavailable. Please try again.");
    const result=await response.json();
    if(!response.ok) throw new Error(result.error?.message ?? "Could not load the archive.");
    return result;
  }
  function status(message:string) {el("chat-status").textContent=message;}
  function article(message:Chat, context=false) {
    const item=document.createElement("article");item.className="review-item";
    const meta=document.createElement("p");meta.className="chat-meta";
    meta.textContent=`${message.groupTitle ? message.groupTitle+" · " : ""}${message.author} · ${new Date(message.postedAt).toLocaleString()}`;
    const text=document.createElement("p");text.className="chat-text";text.textContent=message.text;
    item.append(meta,text);
    if(!context) {
      const open=document.createElement("button");open.textContent="Read in context";
      open.onclick=async()=>{
        open.disabled=true;
        const contextGeneration=generation;
        try {
          const result=await api<{message:Chat;before:Chat[];after:Chat[]}>(`/messages/${message.id}`);
          if(contextGeneration!==generation)return;
          el("chat-context-messages").replaceChildren(...[...result.before,result.message,...result.after].map(m=>article(m,true)));
          el("chat-context").hidden=false;el("chat-context").scrollIntoView({block:"start"});
        } catch(error) {status((error as Error).message);} finally {open.disabled=false;}
      };
      item.append(open);
    }
    if(administrator) {
      const hide=document.createElement("button");hide.textContent="Hide message";
      hide.onclick=async()=>{hide.disabled=true;try {await api(`/messages/${message.id}`,"DELETE");item.remove();el("chat-context").hidden=true;status("Message hidden from members and search.");} catch(error){status((error as Error).message);hide.disabled=false;}};
      item.append(hide);
    }
    return item;
  }
  async function search(append=false) {
    const current=++generation;
    const parameters=new URLSearchParams(query);if(append&&cursor)parameters.set("cursor",cursor);
    (el("chat-more") as HTMLButtonElement).disabled=true;
    try {
      const result=await api<{messages:Chat[];nextCursor:string|null}>("/search?"+parameters.toString());
      if(current!==generation)return;
      if(!append)el("chat-results").replaceChildren();
      el("chat-results").append(...result.messages.map(m=>article(m)));
      cursor=result.nextCursor;el("chat-more").hidden=!cursor;
      status(el("chat-results").children.length ? `${el("chat-results").children.length} messages shown${cursor ? ". More results are available." : "."}` : "No messages found. Try different words or filters.");
    } catch(error) {if(current===generation){el("chat-results").replaceChildren();el("chat-context").hidden=true;el("chat-more").hidden=true;status((error as Error).message);}}
    finally {if(current===generation)(el("chat-more") as HTMLButtonElement).disabled=false;}
  }
  el("chat-search").addEventListener("submit",event=>{event.preventDefault();query=new URLSearchParams();for(const [key,value] of new FormData(el("chat-search") as HTMLFormElement)){if(String(value).trim())query.set(key,String(value).trim());}cursor=null;el("chat-context").hidden=true;void search();});
  el("chat-more").onclick=()=>void search(true);
  void (async()=>{
    try {
      const {groups}=await api<{groups:Group[]}>("/groups");
      for(const group of groups) {
        const option=document.createElement("option");option.value=group.id;option.textContent=`${group.title} (${group.messageCount})`;el("chat-group").append(option);
        if(administrator) {
          const row=document.createElement("p");row.textContent=`${group.title} · ${group.messageCount} messages · ${group.coverageNote} · Imported ${new Date(group.importedAt).toLocaleString()} `;
          const toggle=document.createElement("button");toggle.textContent=group.published?"Unpublish group":"Publish group";
          toggle.onclick=async()=>{toggle.disabled=true;try {await api(`/groups/${group.id}`,"POST",{published:!group.published});group.published=group.published?0:1;toggle.textContent=group.published?"Unpublish group":"Publish group";status("Group visibility updated.");}catch(error){status((error as Error).message);}finally{toggle.disabled=false;}};
          row.append(toggle);el("chat-moderation").append(row);
        }
      }
      if(!groups.length){status("No chat history has been published yet.");return;}
      await search();
    }catch(error){status((error as Error).message);}
  })();
}
