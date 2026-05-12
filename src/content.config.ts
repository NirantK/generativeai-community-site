import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const community = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/community' }),
  schema: z.object({
    title: z.string(),
    description: z.string().optional(),
    date: z.coerce.date().optional(),
    lastmod: z.coerce.date().optional(),
    draft: z.boolean().optional(),
    images: z.array(z.string()).optional(),
    weight: z.number().optional(),
    toc: z.boolean().optional(),
    lead: z.string().optional(),
  }),
});

export const collections = { community };
