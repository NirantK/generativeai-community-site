import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    role: text('role').notNull(),
    company: text('company').notNull(),
    location: text('location').notNull(),
    comp: text('comp'),
    applyWeb: text('apply_web').notNull(),
    applyApi: text('apply_api'),
    contactEmail: text('contact_email').notNull(),
    blurb: text('blurb').notNull(),
    userId: text('user_id'),
    status: text('status').notNull().default('pending_payment'),
    postedAt: integer('posted_at'),
    stripeSessionId: text('stripe_session_id'),
    waStatus: text('wa_status').notNull().default('pending'),
    waPostedAt: integer('wa_posted_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    liveIdx: index('idx_jobs_live').on(t.status, t.postedAt),
    userIdx: index('idx_jobs_user').on(t.userId),
    stripeUniq: uniqueIndex('uniq_jobs_stripe_session').on(t.stripeSessionId),
  })
);

export const payments = sqliteTable('payments', {
  id: text('id').primaryKey(),
  jobId: text('job_id'),
  amountCents: integer('amount_cents').notNull(),
  currency: text('currency').notNull(),
  email: text('email').notNull(),
  createdAt: integer('created_at').notNull(),
  rawEvent: text('raw_event').notNull(),
});

export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
