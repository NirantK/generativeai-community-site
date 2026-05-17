import { drizzle } from 'drizzle-orm/d1';
import type { D1Database } from '@cloudflare/workers-types';
import * as schema from './schema';

export const db = (binding: D1Database) => drizzle(binding, { schema });
