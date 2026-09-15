// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';
import cloudflare from '@astrojs/cloudflare';

const site = process.env.SITE_URL || 'https://genaicommunity.ai';

// https://astro.build/config
export default defineConfig({
  site,
  compressHTML: true,
  trailingSlash: 'never',
  output: 'static',
  adapter: cloudflare({ imageService: 'passthrough' }),
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [mdx(), sitemap()],
});
