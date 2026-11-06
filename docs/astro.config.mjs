// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightSidebarTopics from 'starlight-sidebar-topics';
import { TOPICS } from './src/sections.mjs';
import { SITE_URL } from './src/site.mjs';

export default defineConfig({
	site: SITE_URL,
	trailingSlash: 'ignore',
	integrations: [
		starlight({
			title: 'Novi Corpus',
			description:
				'Documentation for Novi Corpus: a registered legal body for AI agents, the guardian who answers for it, and the public record anyone can check.',
			plugins: [starlightSidebarTopics(TOPICS)],
		}),
	],
});
