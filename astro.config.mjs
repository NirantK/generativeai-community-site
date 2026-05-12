// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

const site = process.env.SITE_URL || 'https://generativeai-community-site.pages.dev';

// https://astro.build/config
export default defineConfig({
  site,
  trailingSlash: 'never',
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [mdx(), sitemap()],
});
