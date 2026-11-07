// Every page the HonKit site served (design 3.4), by its old path without ".html",
// and where it lives now. One source for:
//   - astro.config.mjs `redirects` (the extensionless old paths),
//   - the static `<old>.html` redirect pages written after the build (any static host, `astro preview`),
//   - docs/vercel.json (308 redirects; checked by tools/check-redirects.mjs).
// Destinations of pages not written yet point at their section until the page exists (design 3.4).

import { REPO_URL } from './site.mjs';

export const REPO_README = `${REPO_URL}#readme`;

export const OLD_PAGES = {
	'/README': '/',
	'/introduction/status': '/start/status/',
	'/introduction/how-it-works': '/live/',
	'/product/legal-body': '/live/',
	'/product/treasury': '/testnet/treasury-product/',
	'/product/custody': '/testnet/treasury-product/',
	'/product/onboarding': '/testnet/treasury-product/',
	'/product/guardian': '/live/guardian/',
	'/product/formation': '/live/bring-your-own-agent/',
	'/identity/world': '/live/guardian/',
	'/identity/ens': '/testnet/ens/',
	'/identity/legal-body-statement': '/identity/legal-body-statement/', // kept in place until T1
	'/identity/registries': '/live/identity-and-link/',
	'/agents/connect': '/testnet/mcp/',
	'/agents/mcp': '/testnet/mcp/',
	'/agents/payments': '/testnet/payments-and-jobs/',
	'/agents/jobs': '/testnet/payments-and-jobs/',
	'/developers/architecture': REPO_README,
	'/developers/rest-api': '/testnet/rest-api/',
	'/developers/contracts': '/developers/contracts/', // same page, new URL form
	'/reference/networks': '/developers/networks/',
	'/reference/stack': REPO_README,
	'/reference/support': '/help/support/',
};

/** Astro `redirects`: old extensionless paths that are not also a live page. */
export function astroRedirects() {
	return Object.fromEntries(
		Object.entries(OLD_PAGES).filter(([from, to]) => `${from}/` !== to && from !== '/README'),
	);
}

/** A minimal redirect page, like the ones Astro writes for `redirects` in a static build. */
export function redirectPage(to, site) {
	const abs = /^https?:/.test(to) ? to : new URL(to, site).href;
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Redirecting to: ${to}</title><meta http-equiv="refresh" content="0;url=${to}"><meta name="robots" content="noindex"><link rel="canonical" href="${abs}"></head><body><a href="${to}">This page moved to ${to}</a></body></html>\n`;
}
