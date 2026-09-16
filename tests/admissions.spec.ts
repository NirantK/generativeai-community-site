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
    linkedinUrl: "https://www.linkedin.com/in/builder",
    role: "Student",
    organization: "Independent",
    education: "No formal education",
    project:
      "I built an AI library search tool to retrieve and summarize documents.",
    contribution: "I built the ingestion and retrieval evaluation pipeline.",
    outcome: "Users found relevant documents faster.",
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
  await page.getByText("Apply using an AI agent", { exact: true }).click();
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
          organization: "Independent",
          education: "Self taught",
          project: "AI library assistant",
          contribution: "Built retrieval evaluation",
          outcome: "Improved search",
          motivation: "Learn from others",
          linkedinUrl: "https://www.linkedin.com/in/builder",
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
