export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { jobs } from '../../../lib/db/schema';

export const GET: APIRoute = async ({ request }) => {
  if (request.headers.get('x-outbox-key') !== env.OUTBOX_API_KEY) {
    return new Response('unauthorized', { status: 401 });
  }
  const cutoff = Date.now() - 86400000;
  const result = await db(env.DB)
    .delete(jobs)
    .where(and(eq(jobs.status, 'pending_payment'), lt(jobs.createdAt, cutoff)));
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { 'content-type': 'application/json' },
  });
};
