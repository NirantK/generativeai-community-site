// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';
import mdx from '@astrojs/mdx';
import sitemap from '@astrojs/sitemap';

const site = process.env.SITE_URL || 'https://genaicommunity.ai';

// https://astro.build/config
export default defineConfig({
  site,
  compressHTML: true,
  trailingSlash: 'never',
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [mdx(), sitemap({filter: (page) => !/\/(admin|past-chats)(\/|$)/.test(new URL(page).pathname)})],
});
