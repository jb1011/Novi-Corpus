#!/usr/bin/env node
// Redirect check (design 7, gate item 5).
//
//   node tools/check-redirects.mjs                 vercel.json matches src/redirects.mjs (no network)
//   node tools/check-redirects.mjs --write         rewrites the redirects of vercel.json from src/redirects.mjs
//   node tools/check-redirects.mjs <base URL>      requests every old HonKit URL and asserts it lands on a 200:
//                                                  on Vercel a 308 straight to the page; elsewhere (astro preview)
//                                                  the static redirect page written by the build.
//
// Example: node tools/check-redirects.mjs https://<preview>.vercel.app
import fs from 'node:fs';
import { OLD_PAGES } from '../src/redirects.mjs';

const VERCEL_JSON = new URL('../vercel.json', import.meta.url);

/** The redirects vercel.json must carry: one per old page, then the generic .html rules. */
export function expectedRedirects() {
	return [
		...Object.entries(OLD_PAGES).map(([from, to]) => ({ source: `${from}.html`, destination: to, permanent: true })),
		{ source: '/index.html', destination: '/', permanent: true },
		{ source: '/:path(.*)/index.html', destination: '/:path/', permanent: true },
		{ source: '/:path(.*).html', destination: '/:path/', permanent: true },
	];
}

const arg = process.argv[2];
const config = JSON.parse(fs.readFileSync(VERCEL_JSON, 'utf8'));

if (arg === '--write') {
	config.redirects = expectedRedirects();
	fs.writeFileSync(VERCEL_JSON, JSON.stringify(config, null, 2) + '\n');
	console.log(`vercel.json: ${config.redirects.length} redirects written`);
	process.exit(0);
}

const same = JSON.stringify(config.redirects) === JSON.stringify(expectedRedirects());
console.log(same ? 'vercel.json redirects match src/redirects.mjs' : 'vercel.json redirects DO NOT match src/redirects.mjs (run with --write)');
if (!same) process.exit(1);
if (!arg) process.exit(0);

// Live check against a deployment or a local preview.
const base = arg.replace(/\/$/, '');
const urls = [...Object.keys(OLD_PAGES).map((p) => `${p}.html`), '/index.html', '/live/index.html'];
let failed = 0;
for (const path of urls) {
	const res = await fetch(base + path, { redirect: 'manual' });
	let hop = `${res.status}`;
	let target;
	if (res.status === 308 || res.status === 301) {
		target = res.headers.get('location');
	} else if (res.status === 200) {
		const m = (await res.text()).match(/http-equiv="refresh" content="0;url=([^"]+)"/);
		if (m) { target = m[1]; hop = '200 (refresh page)'; }
	}
	if (!target && res.status === 200 && path.endsWith('/index.html')) {
		// A real file: Vercel answers it with a 308 to the directory; a plain static server serves it.
		console.log(`ok   ${path} -> 200 (served as is; Vercel sends a 308 to the directory)`);
		continue;
	}
	if (!target) { console.log(`FAIL ${path}: ${hop}, no redirect`); failed++; continue; }
	const final = new URL(target, base + path);
	const external = final.origin !== new URL(base).origin;
	const end = external ? await fetch(final, { method: 'HEAD' }) : await fetch(final);
	const ok = end.status === 200;
	if (!ok) failed++;
	console.log(`${ok ? 'ok  ' : 'FAIL'} ${path} -> ${hop} -> ${final.pathname}${final.hash} ${external ? `(${final.host}) ` : ''}${end.status}`);
}
console.log(failed ? `${failed} failed` : `all ${urls.length} old URLs redirect to a 200`);
process.exit(failed ? 1 : 0);
