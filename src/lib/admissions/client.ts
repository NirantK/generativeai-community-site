export type Snapshot = {
  profile: { name: string; email: string; emailVerified: boolean };
  consent: string | null;
  consentCurrent: boolean;
  tokenActive: boolean;
  status: string;
  decisionReason?: string | null;
  appeal?: { eligible: boolean; status: string };
  delivery: { status: string };
  receipt?: { status: string };
  application: Record<string, string> | null;
  enrichment: { status: string; source: "email" | "linkedin" | null; data: { name: string; title: string | null; location: string | null; company: string | null; school: string | null; degree: string | null } | null };
};
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
function notice(message: string, error = false) {
  el("message").textContent = message;
  el("message").classList.toggle("error", error);
}
export async function api<T = Snapshot>(
  path: string,
  method = "GET",
  data?: unknown,
  key?: string,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
    signal,
  });
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error(
      "Applications are temporarily unavailable. Please try again later.",
    );
  }
  const result = (await response.json()) as T & {
    error?: {
      message?: string;
      details?: { fieldErrors?: Record<string, string[]> };
    };
  };
  if (!response.ok) {
    const details = result.error?.details?.fieldErrors;
    const fields = details
      ? Object.entries(details)
          .map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`)
          .join(" ")
      : "";
    throw Object.assign(
      new Error(
        `${result.error?.message ?? "Please try again."} ${fields}`.trim(),
      ),
      { status: response.status },
    );
  }
  return result;
}
export function initApplication() {
  if (["#agent-token", "#api-management"].includes(location.hash)) {location.replace("/token");return;}
  let submissionKey = crypto.randomUUID();
  let appealKey = crypto.randomUUID();
  let enrichmentPoll: number | undefined;
  let landed = false;
  async function refresh() {
    try {
      const s: Snapshot = await api("/api/v1/application");
      el("signed-out").hidden = true;
      el("signed-in").hidden = false;
      void fetch("/api/admin/access").then(r => { el("admin-link").hidden = !r.ok; }).catch(() => { el("admin-link").hidden = true; });
      void api<{invitation: unknown}>("/api/admin-invitation").then(r => { el("admin-invitation").hidden = !r.invitation; }).catch(() => { el("admin-invitation").hidden = true; });
      el("appeal-section").hidden = !s.appeal?.eligible;
      el("past-chats-link").hidden = s.status !== "approved";
      el("member-agent-link").hidden = s.status !== "approved";
      el("identity").textContent = `Signed in as ${s.profile.name}`;
      el("email-status").textContent = s.profile.email
        ? `LinkedIn email: ${s.profile.email}`
        : "LinkedIn did not provide an email. Add an email to your LinkedIn account and sign in again.";
      el("refresh-linkedin").hidden = s.profile.emailVerified;
      if (enrichmentPoll) window.clearTimeout(enrichmentPoll);
      const enrichment = s.enrichment ?? { status: "idle", source: null, data: null };
      el("enrichment-section").hidden = enrichment.status === "idle";
      el("enrichment-status").textContent = enrichment.status === "pending"
        ? "Looking up your professional profile…"
        : enrichment.status === "matched" ? "We found this professional profile:"
        : enrichment.status === "no_match" ? "We did not find a matching professional profile. You can still apply."
        : "Profile lookup is unavailable. You can still apply.";
      el("enrichment-details").textContent = enrichment.data
        ? [["Name", enrichment.data.name], ["Role", enrichment.data.title],
           ["Company", enrichment.data.company], ["Location", enrichment.data.location],
           ["School", enrichment.data.school], ["Degree", enrichment.data.degree]]
            .filter(([, value]) => !!value).map(([label, value]) => `${label}: ${value}`).join(" · ") : "";
      if (enrichment.status === "pending") enrichmentPoll = window.setTimeout(() => void refresh(), 3000);
      el("consent-section").hidden = s.status === "approved" || s.consentCurrent;
      el("form-section").hidden = !!s.application;
      el("status-section").hidden = !s.application;
      const canSubmit = s.profile.emailVerified && s.consentCurrent;
      el<HTMLButtonElement>(
        "application-form",
      ).querySelector<HTMLButtonElement>("button[type=submit]")!.disabled =
        !canSubmit;
      if (s.application) {
        const copy: Record<string, string> = {
          submitted: "Your application is being assessed. Check back shortly.",
          review: "Your application is awaiting a human review.",
          approved:
            s.delivery.status === "accepted"
              ? "You’re approved. Your WhatsApp invitation has been sent to your email provider. Check your inbox and spam folder."
              : "You’re approved. Your invitation email is still pending.",
          declined: "Your application was not approved this time.",
        };
        el("status-title").textContent =
          s.status === "approved" ? "You’re approved" : s.status === "declined" ? "Application declined" : s.appeal?.status === "pending" ? "Appeal under review" : "Application received";
        el("status-copy").textContent =
          s.appeal?.status === "pending" ? "Your appeal is awaiting administrator review." : s.status === "declined" ? `${copy.declined} ${s.decisionReason ?? ""} ${s.appeal?.eligible ? "You can submit evidence for an appeal below or through your agent." : "Appeals are available only for applications originally submitted through an agent."}` : copy[s.status] ?? "Check back for an update.";
        notice(
          s.receipt?.status === "accepted"
            ? "Your application is saved. A copy has been sent to your LinkedIn email provider."
            : "Your application is saved. Your email copy is pending.",
        );
      } else
        notice(
          canSubmit
            ? "Complete the form below, or open API management to let your agent apply."
            : "Save consent to continue. If LinkedIn did not confirm your email, refresh your LinkedIn sign-in.",
        );
      if (!landed) {
        landed = true;
        const target = location.hash ? document.getElementById(location.hash.slice(1)) : s.application ? el("status-section") : !s.consentCurrent ? el("consent-section") : el("form-section");
        target?.scrollIntoView({block:"start"});
      }
    } catch (e) {
      if ((e as { status?: number }).status === 401) {
        el("signed-out").hidden = false;
        el("signed-in").hidden = true;
        const signin = new URL(location.href).searchParams.get("signin");
        notice(
          signin === "failed"
            ? "LinkedIn sign-in didn’t finish. Please try again below."
            : signin === "cancelled"
              ? "LinkedIn sign-in was cancelled. You can try again when ready."
              : "Sign in to start your application.",
          signin === "failed",
        );
      } else notice((e as Error).message, true);
    }
  }
  function action(id: string, fn: () => Promise<void>) {
    el(id).addEventListener("click", async () => {
      const b = el<HTMLButtonElement>(id);
      b.disabled = true;
      try {
        await fn();
      } catch (e) {
        notice((e as Error).message, true);
      } finally {
        b.disabled = false;
      }
    });
  }
  function form(id: string, fn: (data: FormData) => Promise<void>) {
    el<HTMLFormElement>(id).addEventListener("submit", async (e) => {
      e.preventDefault();
      const button = el(id).querySelector<HTMLButtonElement>(
        "button[type=submit]",
      )!;
      button.disabled = true;
      try {
        await fn(new FormData(el<HTMLFormElement>(id)));
      } catch (e) {
        notice((e as Error).message, true);
        el("message").scrollIntoView({ block: "nearest" });
      } finally {
        button.disabled = false;
      }
    });
  }
  form("consent-form", async () => {
    await api("/api/application-consent", "POST", { consent: true });
    await refresh();
  });
  form("appeal-form", async d => {
    const evidence = Object.fromEntries([...d.entries()].filter(([,value]) => String(value).trim()).map(([key,value]) => [key,String(value).trim()]));
    await api("/api/v1/appeal", "POST", evidence, appealKey);
    appealKey = crypto.randomUUID();
    await refresh();
    notice("Appeal saved for administrator review.");
  });
  el<HTMLInputElement>("linkedinUrl").addEventListener("change", async () => {
    const linkedinUrl = el<HTMLInputElement>("linkedinUrl").value.trim();
    if (!linkedinUrl) return;
    try {
      await api("/api/application-enrichment", "POST", { linkedinUrl });
      await refresh();
    } catch (e) { notice((e as Error).message, true); }
  });
  form("application-form", async (d) => {
    await api(
      "/api/v1/application",
      "POST",
      Object.fromEntries(d),
      submissionKey,
    );
    await refresh();
  });
  action("accept-admin", async () => {
    await api("/api/admin-invitation", "POST");
    location.href = "/app";
  });
  action("logout", async () => {
    await api("/auth/logout", "POST");
    document.dispatchEvent(new Event("community-signed-out"));
    location.assign("/apply");
  });
  action("refresh", refresh);
  void refresh();
}
