export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { jobs } from '../../../lib/db/schema';
import { z } from 'zod';

const schema = z.object({
  id: z.string(),
  status: z.enum(['posted', 'failed']),
});

export const POST: APIRoute = async ({ request }) => {
  if (request.headers.get('x-outbox-key') !== env.OUTBOX_API_KEY) {
    return new Response('unauthorized', { status: 401 });
  }
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return new Response('bad request', { status: 400 });

  await db(env.DB)
    .update(jobs)
    .set({
      waStatus: parsed.data.status,
      waPostedAt: parsed.data.status === 'posted' ? Date.now() : null,
    })
    .where(eq(jobs.id, parsed.data.id));

  return new Response('ok', { status: 200 });
};
