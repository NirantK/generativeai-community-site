import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
const draft = {
  profile: {
    name: "Test Builder",
    email: "builder@example.com",
    emailVerified: true,
  },
  consent: "admissions-v1",
  status: "draft",
  application: null,
  delivery: { status: "pending" },
  missingRequirements: [],
  tokenActive: false,
};
test("LinkedIn is the only sign-in option", async ({ page }, info) => {
  await page.route("**/api/v1/application", (route) =>
    route.fulfill({ status: 401, json: { error: { message: "Sign in" } } }),
  );
  await page.goto("/apply");
  await expect(
    page.getByRole("link", { name: "Sign in with LinkedIn", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Sign in with LinkedIn", exact: true }),
  ).toHaveAttribute("href", "/auth/linkedin");
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(
    results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `.shots/admissions-signin-${info.project.name}.png`,
    fullPage: true,
  });
});
test("verified applicant submits a short application and sees saved status", async ({
  page,
}, info) => {
  let submitted = false;
  await page.route("**/api/v1/application", async (route) => {
    if (route.request().method() === "POST") {
      expect(route.request().headers()["idempotency-key"]).toBeTruthy();
      expect(route.request().postDataJSON().role).toBe("Student");
      submitted = true;
    }
    await route.fulfill({
      json: submitted
        ? { ...draft, status: "review", application: { role: "Student" } }
        : draft,
    });
  });
  await page.goto("/apply");
  await expect(page.getByText("Signed in as Test Builder")).toBeVisible();
  const fields = {
    role: "Student",

    project:
      "I built an AI library search tool to retrieve and summarize documents.",
    contribution: "I built the ingestion and retrieval evaluation pipeline.",

    motivation: "I want to learn from other builders and share my findings.",
  };
  for (const [name, value] of Object.entries(fields))
    await page.locator(`[name=${name}]`).fill(value);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `.shots/admissions-form-${info.project.name}.png`,
    fullPage: true,
  });
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .analyze();
  expect(
    results.violations.filter((v) =>
      ["serious", "critical"].includes(v.impact ?? ""),
    ),
  ).toEqual([]);
  await page
    .getByRole("button", { name: "Submit application", exact: true })
    .click();
  await expect(
    page.getByText("Your application is awaiting a human review."),
  ).toBeVisible();
  expect(submitted).toBe(true);
});
test("token is shown once and removed on revocation", async ({ page }) => {
  await page.route("**/api/v1/application", (r) => r.fulfill({ json: draft }));
  await page.route("**/api/application-token", (r) =>
    r.fulfill({
      json:
        r.request().method() === "POST"
          ? { token: "test-only-token", expiresAt: Date.now() + 86400000 }
          : { revoked: true },
    }),
  );
  await page.goto("/apply");
  await expect(page.locator("#agent-section")).toHaveAttribute("open", "");
  await page
    .getByRole("button", { name: "Generate application token" })
    .click();
  await expect(page.locator("#token-value")).toHaveText("test-only-token");
  await page.getByRole("button", { name: "Revoke token", exact: true }).click();
  await expect(page.locator("#token-output")).toBeHidden();
});
test("outage is not misrepresented as signed out", async ({ page }) => {
  await page.route("**/api/v1/application", (r) =>
    r.fulfill({
      status: 503,
      json: { error: { message: "Applications temporarily unavailable." } },
    }),
  );
  await page.goto("/apply");
  await expect(page.getByRole("status")).toContainText(
    "temporarily unavailable",
  );
  await expect(page.locator("#signed-out")).toBeHidden();
});
test("new pages fit the viewport and documentation names Cloudflare sender", async ({
  page,
}) => {
  for (const path of ["/api-instructions", "/privacy-policy"]) {
    await page.goto(path);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
  }
  await expect(
    page.getByText("noreply@genaicommunity.ai", { exact: true }).first(),
  ).toBeVisible();
});

test("administrator can read evidence and record a decision", async ({
  page,
}) => {
  await page.route("**/api/admin/invitations", r => r.fulfill({json:{invitations:[]}}));
  await page.route("**/api/admin/bug-reports", (r) =>
    r.fulfill({
      json: {
        reports: [
          {
            id: "test-report",
            name: "Test Builder",
            created_at: Date.now(),
            report: "<script>untrusted bug report</script>",
          },
        ],
      },
    }),
  );
  const id = "a".repeat(64);
  let decided = false;
  await page.route("**/api/admin/applications", (r) =>
    r.fulfill({
      json: {
        applications: [
          { id, name: "Test Builder", status: "review", delivery: "pending" },
        ],
      },
    }),
  );
  await page.route(`**/api/admin/applications/${id}`, (r) =>
    r.fulfill({
      json: {
        profile: draft.profile,
        application: {
          role: "Student",

          project: "AI library assistant",
          contribution: "Built retrieval evaluation",

          motivation: "Learn from others",
        },
        status: decided ? "approved" : "review",
        assessment: {
          reasons: "Concrete AI project",
          evidence: ["Built retrieval evaluation"],
        },
        delivery: { status: "pending" },
        history: [],
        decision: null,
        policy: "practitioners-v1",
        model: "test",
      },
    }),
  );
  await page.route(`**/api/admin/applications/${id}/decision`, (r) => {
    expect(r.request().postDataJSON().action).toBe("approve");
    decided = true;
    return r.fulfill({ json: { status: "approved" } });
  });
  await page.goto("/admin");
  await page
    .getByRole("button", { name: "Review application", exact: true })
    .click();
  await expect(
    page.getByText("Concrete AI project", { exact: true }),
  ).toBeVisible();
  await page
    .getByLabel("Decision reason")
    .fill("Clear personal contribution to an AI project.");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Decision recorded.");
  expect(decided).toBe(true);
});

// A Pages/proxy outage may return HTML rather than the API's JSON error envelope.
test("HTML gateway failures show a useful message", async ({ page }) => {
  await page.route("**/api/v1/application", (route) =>
    route.fulfill({
      status: 502,
      contentType: "text/html",
      body: "<!doctype html><h1>Bad gateway</h1>",
    }),
  );
  await page.goto("/apply");
  await expect(page.getByRole("status")).toContainText(
    "Applications are temporarily unavailable",
  );
  await expect(page.getByRole("status")).not.toContainText("Unexpected token");
});

test("failed and cancelled sign-ins offer a retry", async ({ page }) => {
  await page.route("**/api/v1/application", (route) =>
    route.fulfill({
      status: 401,
      json: { error: { message: "Sign in" } },
    }),
  );
  for (const [reason, message] of [
    ["failed", "LinkedIn sign-in didn’t finish"],
    ["cancelled", "LinkedIn sign-in was cancelled"],
  ]) {
    await page.goto(`/apply?signin=${reason}`);
    await expect(page.getByRole("status")).toContainText(message);
    await expect(
      page.getByRole("link", { name: "Sign in with LinkedIn", exact: true }),
    ).toBeVisible();
  }
});

test("agent application is first and open by default with LinkedIn email and no verification form", async ({
  page,
}) => {
  await page.route("**/api/v1/application", (r) => r.fulfill({ json: draft }));
  await page.goto("/apply");
  await expect(page.locator("#agent-section")).toHaveAttribute("open", "");
  await expect(
    page.getByText("LinkedIn email: builder@example.com", { exact: true }),
  ).toBeVisible();
  await expect(
    page.locator("#email-form, #verify-form, #change-email"),
  ).toHaveCount(0);
  expect(
    await page
      .locator("#agent-section")
      .evaluate(
        (el) =>
          !!(
            el.compareDocumentPosition(
              document.getElementById("form-section")!,
            ) & Node.DOCUMENT_POSITION_FOLLOWING
          ),
      ),
  ).toBe(true);
});

test("administrator invites a colleague by email and sees the pending invitation", async ({ page }) => {
  let invited=false;
  await page.route("**/api/admin/applications", r => r.fulfill({json:{applications:[]}}));
  await page.route("**/api/admin/bug-reports", r => r.fulfill({json:{reports:[]}}));
  await page.route("**/api/admin/invitations", r => {
    if(r.request().method()==="POST") {
      expect(r.request().postDataJSON()).toEqual({email:"colleague@example.com"});
      invited=true;
      return r.fulfill({status:201,json:{delivery:"accepted"}});
    }
    return r.fulfill({json:{invitations:invited?[{id:"test",email:"colleague@example.com",expires_at:Date.now()+86400000,accepted_at:null,revoked_at:null,delivery:"accepted"}]:[]}});
  });
  await page.goto("/admin");
  await page.getByLabel("New administrator email").fill("colleague@example.com");
  await page.getByRole("button",{name:"Send administrator invitation"}).click();
  await expect(page.getByRole("status")).toHaveText("Administrator invitation accepted by the email provider.");
  await expect(page.getByText(/colleague@example.com — Awaiting acceptance/)).toBeVisible();
});

test("agent applicants can appeal with evidence and see human-review status", async ({page}) => {
  let appealed=false;
  await page.route("**/api/v1/application",r=>r.fulfill({json:{...draft,application:{role:"Student"},status:appealed?"review":"declined",decisionReason:"Exceptional work evidence was not supplied.",appeal:{eligible:!appealed,status:appealed?"pending":"none"}}}));
  await page.route("**/api/v1/appeal",r=>{
    expect(r.request().headers()["idempotency-key"]).toBeTruthy();
    expect(r.request().postDataJSON()).toEqual({proofUrl:"https://example.com/my-project"});
    appealed=true;return r.fulfill({status:202,json:{status:"review"}});
  });
  await page.goto("/apply");
  await expect(page.getByRole("heading",{name:"Appeal your rejection"})).toBeVisible();
  await page.getByLabel("Link to your work (HTTPS)").fill("https://example.com/my-project");
  await page.getByRole("button",{name:"Submit appeal for admin review"}).click();
  await expect(page.getByText("Your appeal is awaiting administrator review.")).toBeVisible();
  await expect(page.getByRole("heading",{name:"Appeal your rejection"})).toBeHidden();
});

test("form applicants cannot see the appeal form after rejection", async ({page}) => {
  await page.route("**/api/v1/application",r=>r.fulfill({json:{...draft,application:{role:"Student"},status:"declined",appeal:{eligible:false,status:"none"}}}));
  await page.goto("/apply");
  await expect(page.getByText(/Appeals are available only for applications originally submitted through an agent/)).toBeVisible();
  await expect(page.getByRole("button",{name:"Submit appeal for admin review"})).toBeHidden();
});

test("admin review displays appeal evidence, reference status, and original rejection",async({page})=>{
  const id="b".repeat(64);
  await page.route("**/api/admin/invitations",r=>r.fulfill({json:{invitations:[]}}));
  await page.route("**/api/admin/bug-reports",r=>r.fulfill({json:{reports:[]}}));
  await page.route("**/api/admin/applications",r=>r.fulfill({json:{applications:[{id,name:"Appealing student",status:"review",appeal_status:"pending",delivery:"pending"}]}}));
  await page.route(`**/api/admin/applications/${id}`,r=>r.fulfill({json:{profile:draft.profile,application:{role:"Student"},status:"review",submissionChannel:"agent",delivery:{status:"pending"},history:[],appeals:[{submittedAt:Date.now(),previousDecision:{reason:"Original student rejection"},resolution:null,evidence:{explanation:"Original project details for a human reviewer",voucher:"<script>untrusted reference claim</script>"}}]}}));
  await page.goto("/admin");
  await expect(page.getByText(/APPEAL AWAITING REVIEW/)).toBeVisible();
  await page.getByRole("button",{name:"Review application",exact:true}).click();
  await expect(page.getByRole("heading",{name:"Appeal 1 — Awaiting decision"})).toBeVisible();
  await expect(page.getByText(/Community reference \(unverified\): <script>untrusted reference claim<\/script>/)).toBeVisible();
  await expect(page.getByRole("button",{name:"Retry AI assessment"})).toBeHidden();
});
