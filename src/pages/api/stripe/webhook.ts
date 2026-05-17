export const prerender = false;
import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { db } from '../../../lib/db/client';
import { jobs, payments } from '../../../lib/db/schema';
import { stripe } from '../../../lib/stripe';

export const POST: APIRoute = async ({ request }) => {
  const sig = request.headers.get('stripe-signature');
  if (!sig) return new Response('missing signature', { status: 400 });

  const raw = await request.text();
  const sk = stripe(env.STRIPE_SECRET);

  let event;
  try {
    event = await sk.webhooks.constructEventAsync(raw, sig, env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return new Response(`bad signature: ${(err as Error).message}`, { status: 400 });
  }

  if (event.type !== 'checkout.session.completed') {
    return new Response('ignored', { status: 200 });
  }

  const session = event.data.object;
  const jobId = session.metadata?.jobId;
  if (!jobId) return new Response('missing metadata.jobId', { status: 400 });

  const d = db(env.DB);
  const now = Date.now();

  await d
    .update(jobs)
    .set({ status: 'live', postedAt: now, waStatus: 'pending' })
    .where(eq(jobs.stripeSessionId, session.id));

  await d
    .insert(payments)
    .values({
      id: session.id,
      jobId,
      amountCents: session.amount_total ?? 0,
      currency: session.currency ?? 'usd',
      email: session.customer_details?.email ?? '',
      createdAt: now,
      rawEvent: JSON.stringify(event),
    })
    .onConflictDoNothing();

  return new Response('ok', { status: 200 });
};
