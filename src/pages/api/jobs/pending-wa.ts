export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { and, eq, asc } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { jobs } from '../../../lib/db/schema';
import { renderForWhatsApp } from '../../../lib/wa-template';

export const GET: APIRoute = async ({ request }) => {
  if (request.headers.get('x-outbox-key') !== env.OUTBOX_API_KEY) {
    return new Response('unauthorized', { status: 401 });
  }
  const rows = await db(env.DB)
    .select()
    .from(jobs)
    .where(and(eq(jobs.status, 'live'), eq(jobs.waStatus, 'pending')))
    .orderBy(asc(jobs.postedAt))
    .limit(20);

  return new Response(
    JSON.stringify(rows.map((j) => ({ id: j.id, message: renderForWhatsApp(j) }))),
    { headers: { 'content-type': 'application/json' } }
  );
};
