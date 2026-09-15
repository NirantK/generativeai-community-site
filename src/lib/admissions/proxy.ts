import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
export const proxy: APIRoute = async ({ request }) => {
  try {
    return await env.ADMISSIONS.fetch(request);
  } catch {
    return new Response(
      JSON.stringify({
        error: {
          code: "service_unavailable",
          message:
            "Applications are temporarily unavailable. Please try again shortly.",
        },
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      },
    );
  }
};
