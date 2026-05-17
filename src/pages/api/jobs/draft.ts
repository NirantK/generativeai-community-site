export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { nanoid } from 'nanoid';
import { db } from '../../../lib/db/client';
import { jobs } from '../../../lib/db/schema';
import { jobDraftSchema } from '../../../lib/jobs/validation';
import { stripe } from '../../../lib/stripe';

export const POST: APIRoute = async ({ request }) => {
  const body = await request.json();
  const parsed = jobDraftSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(JSON.stringify({ error: parsed.error.flatten() }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }

  const id = nanoid(12);
  const sk = stripe(env.STRIPE_SECRET);
  const session = await sk.checkout.sessions.create({
    mode: 'payment',
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    success_url: `${env.SITE_URL}/jobs/success?id=${id}`,
    cancel_url: `${env.SITE_URL}/jobs/post?cancelled=1`,
    metadata: { jobId: id },
  });

  await db(env.DB)
    .insert(jobs)
    .values({
      id,
      ...parsed.data,
      stripeSessionId: session.id,
      createdAt: Date.now(),
    });

  return new Response(JSON.stringify({ url: session.url }), {
    headers: { 'content-type': 'application/json' },
  });
};
