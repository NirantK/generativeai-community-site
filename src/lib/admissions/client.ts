type Snapshot = {
  profile: { name: string; email: string; emailVerified: boolean };
  consent: string | null;
  status: string;
  delivery: { status: string };
  application: Record<string, string> | null;
};
const el = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;
function notice(message: string, error = false) {
  el("message").textContent = message;
  el("message").classList.toggle("error", error);
}
async function api<T = Snapshot>(
  path: string,
  method = "GET",
  data?: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      ...(data ? { "Content-Type": "application/json" } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!response.headers.get("content-type")?.includes("application/json")) {
    throw new Error("Applications are temporarily unavailable. Please try again later.");
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
  let submissionKey = crypto.randomUUID();
  async function refresh() {
    try {
      const s: Snapshot = await api("/api/v1/application");
      el("signed-out").hidden = true;
      el("signed-in").hidden = false;
      el("identity").textContent = `Signed in as ${s.profile.name}`;
      el<HTMLInputElement>("email").value = s.profile.email;
      el("email-status").textContent = s.profile.emailVerified
        ? `Verified: ${s.profile.email}`
        : "Verify your email before submitting.";
      el("email-form").hidden = s.profile.emailVerified || !!s.application;
      el("change-email").hidden = !s.profile.emailVerified || !!s.application;
      el("consent-section").hidden = !!s.consent;
      el("form-section").hidden = !!s.application;
      el("status-section").hidden = !s.application;
      const canSubmit = s.profile.emailVerified && !!s.consent;
      el<HTMLButtonElement>("issue-token").disabled = !canSubmit;
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
              : "You’re approved. Your invitation email is pending; we’re working on it.",
          declined: "Your application was not approved this time.",
        };
        el("status-title").textContent =
          s.status === "approved" ? "You’re approved" : "Application received";
        el("status-copy").textContent =
          copy[s.status] ?? "Check back for an update.";
        notice("Your application is saved.");
      } else
        notice(
          canSubmit
            ? "Complete the form, or use an AI agent below."
            : "Verify your email and save consent to continue.",
        );
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
  form("email-form", async (d) => {
    try {
      await api("/api/application-email", "POST", { email: d.get("email") });
    } finally {
      el("token-value").textContent = "";
      el("token-output").hidden = true;
      await refresh();
    }
    el("verify-form").hidden = false;
    notice("Check your inbox for an 8-digit code.");
  });
  form("verify-form", async (d) => {
    await api("/api/application-email/verify", "POST", { code: d.get("code") });
    el("verify-form").hidden = true;
    await refresh();
  });
  form("consent-form", async () => {
    await api("/api/application-consent", "POST", { consent: true });
    await refresh();
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
  action("change-email", async () => {
    el("email-form").hidden = false;
    el("change-email").hidden = true;
  });
  action("issue-token", async () => {
    const result = await api<{ token: string }>(
      "/api/application-token",
      "POST",
    );
    el("token-output").hidden = false;
    el("token-value").textContent = result.token;
    notice("Application token created. Copy it before leaving this page.");
  });
  action("revoke-token", async () => {
    await api("/api/application-token", "DELETE");
    el("token-value").textContent = "";
    el("token-output").hidden = true;
    notice("Agent access revoked.");
  });
  action("copy-token", async () => {
    await navigator.clipboard.writeText(el("token-value").textContent ?? "");
    notice("Token copied.");
  });
  action("logout", async () => {
    await api("/auth/logout", "POST");
    location.assign("/apply");
  });
  action("refresh", refresh);
  void refresh();
}
