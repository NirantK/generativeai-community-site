/** Same-origin API ingress, using the existing private admissions service. */
export default {
  async fetch(request: Request, env: ApiGatewayEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.origin !== env.SITE_URL || !url.pathname.startsWith('/api/v1/')) {
      return new Response('Not found', { status: 404 });
    }
    // Forward the original request: auth, CSRF, rate limits, and idempotency
    // remain owned by AdmissionsGateway, exactly as for the Pages handler.
    return env.ADMISSIONS.fetch(request);
  },
};
