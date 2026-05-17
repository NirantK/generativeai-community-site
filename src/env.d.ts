/// <reference types="astro/client" />
type Runtime = import('@astrojs/cloudflare').Runtime<Env>;
interface Env {
  DB: import('@cloudflare/workers-types').D1Database;
  STRIPE_SECRET: string;
  STRIPE_WEBHOOK_SECRET: string;
  STRIPE_PRICE_ID: string;
  BETTER_AUTH_SECRET: string;
  BETTER_AUTH_URL: string;
  RESEND_API_KEY: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  OUTBOX_API_KEY: string;
  SITE_URL: string;
}
declare namespace App {
  interface Locals {
    runtime: Runtime;
  }
}
