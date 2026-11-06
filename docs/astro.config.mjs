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
			favicon: '/favicon-dark.png',
			head: [
				{ tag: 'link', attrs: { rel: 'icon', href: '/favicon-light.png', media: '(prefers-color-scheme: light)' } },
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#090909' } },
			],
			// Our own 404 page (src/pages/404.astro), outside the docs collection.
			disable404Route: true,
			customCss: [
				'@fontsource/archivo/latin-400.css',
				'@fontsource/archivo/latin-500.css',
				'@fontsource/archivo/latin-600.css',
				'./src/styles/tokens.css',
				'./src/styles/theme.css',
			],
			components: {
				Header: './src/components/overrides/Header.astro',
				SiteTitle: './src/components/overrides/SiteTitle.astro',
				Sidebar: './src/components/overrides/Sidebar.astro',
				PageTitle: './src/components/overrides/PageTitle.astro',
				MarkdownContent: './src/components/overrides/MarkdownContent.astro',
				Footer: './src/components/overrides/Footer.astro',
				ThemeProvider: './src/components/overrides/ThemeProvider.astro',
				ThemeSelect: './src/components/overrides/ThemeSelect.astro',
			},
			plugins: [starlightSidebarTopics(TOPICS)],
		}),
	],
});
