// @ts-check
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightSidebarTopics from 'starlight-sidebar-topics';
import starlightLlmsTxt from 'starlight-llms-txt';
import { SECTION_IDS, SECTIONS, TOPICS } from './src/sections.mjs';
import { DOCS_REPO_TREE, SITE_URL } from './src/site.mjs';
import { OLD_PAGES, astroRedirects, redirectPage } from './src/redirects.mjs';

/**
 * Writes `<old path>.html` redirect pages for every page the HonKit site served, so the old
 * `.html` links work on any static host and in `astro preview`. On Vercel the 308 rules of
 * vercel.json answer first; these pages are the fallback.
 * @type {import('astro').AstroIntegration}
 */
const honkitHtmlRedirects = {
	name: 'novi-honkit-html-redirects',
	hooks: {
		'astro:build:done': async ({ dir, logger }) => {
			const out = fileURLToPath(dir);
			for (const [from, to] of Object.entries(OLD_PAGES)) {
				const file = path.join(out, `${from}.html`);
				await fs.mkdir(path.dirname(file), { recursive: true });
				await fs.writeFile(file, redirectPage(to, SITE_URL));
			}
			logger.info(`${Object.keys(OLD_PAGES).length} HonKit .html redirect pages written`);
		},
	},
};

export default defineConfig({
	site: SITE_URL,
	trailingSlash: 'ignore',
	// The old extensionless paths (design 3.4). The .html forms: vercel.json and the integration above.
	redirects: astroRedirects(),
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
				'./src/styles/components.css',
				'./src/styles/diagrams.css',
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
			plugins: [
				starlightSidebarTopics(TOPICS, {
					// The contributor page of components is unlisted; it shows the Developers sidebar.
					topics: { developers: ['/contributing/**'] },
				}),
				starlightLlmsTxt({
					projectName: 'Novi Corpus',
					details: `The docs have five sections: ${SECTION_IDS.map((id) =>
						SECTIONS[id].badge ? `${SECTIONS[id].label} (badge: ${SECTIONS[id].badge})` : SECTIONS[id].label,
					).join('; ')}. A page's section and badge say where what it describes stands.`,
					optionalLinks: [
						{ label: 'Source of these docs', url: DOCS_REPO_TREE, description: 'the Markdown of every page' },
					],
				}),
			],
		}),
		honkitHtmlRedirects,
	],
});
