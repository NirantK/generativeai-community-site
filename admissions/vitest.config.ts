import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./admissions/wrangler.jsonc" },
      remoteBindings: false,
      miniflare: {
        bindings: {
          SITE_URL: "https://genaicommunity.ai",
          EMAIL_ENABLED: "false",
          AUTO_APPROVALS_ENABLED: "false",
          ADMIN_EMAILS: "admin-sub",
          CRUSTDATA_API_KEY: "",
        },
      },
    }),
  ],
  test: {
    include: ["admissions/tests/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
  },
});
