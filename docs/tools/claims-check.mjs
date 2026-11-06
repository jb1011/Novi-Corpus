#!/usr/bin/env node
// Claims check (design 2.5, 2.7.2 rule 10, and item 1 of the gate in section 7).
//
//   node tools/claims-check.mjs            check every page and diagram; exit 1 on any error
//   node tools/claims-check.mjs --counts   also print the word count of every plain page
//
// Runs before every build (`prebuild` in package.json) and in `npm run check`.
//
// Scans src/content/docs/**/*.{md,mdx} and the text of src/assets/diagrams/*.svg.
//
// ERRORS (the build fails):
//   - front matter: `title`, `description`, `section`, `register` and `reviewed` on every page;
//   - the words above the claims ceiling (2.5 rules 1 to 3), the partner and pilot names (rule 8),
//     the legacy hosts, "audit" within three words of Olympix (rule 7);
//   - sentences about what is built or not built (2.5 rule 4);
//   - em and en dashes (2.5 rule 13);
//   - a bare "LLC" in prose that is neither "DAO LLC" nor "Wyoming LLC" (2.5 rule 5);
//   - the names of the review cast (2.7.4) on any public page;
//   - "Live on Arc mainnet" written by hand while MAINNET_LIVE is false (design 2.6: the badge
//     comes from src/sections.mjs, and the D6 drawing keeps its live form in a switched group);
//   - M1, the headline: its full form on start/what-it-unlocks and its short form on the landing.
//
// WARNINGS (printed; the Fable audit clears them): on `register: plain` pages, a page over its
// word budget (2.7.2 rule 1) and technical words outside the "For developers" box (2.7.3).
//
// Code: fenced blocks and inline code spans never count as prose for the "LLC" rule. A page may
// also exempt its quoted code from every other rule with a page-level comment, for code that
// must quote a word verbatim:   <!-- claims-check: allow-in-code -->   (in MDX: {/* ... */}).
// Nothing exempts prose.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAINNET_LIVE, SECTION_IDS } from '../src/sections.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CONTENT = path.join(ROOT, 'src/content/docs');
const DIAGRAMS = path.join(ROOT, 'src/assets/diagrams');
const SHOW_COUNTS = process.argv.includes('--counts');

/** Our filing provider is named only once its contract is signed (design decision 2). */
const FILING_PROVIDER_NAMED = false;

/** The headline (design 2.2, M1), verbatim. */
const M1_SHORT =
	"Most AI agents are helpers: they act through their owner's accounts, and nobody can hold them to anything. Novi Corpus makes them actors: each represents a company, a Wyoming DAO LLC, that can be invoiced and held to account, with one person who answers for it.";
const M1_FULL =
	"Today most AI agents are helpers. An agent acts through its owner's accounts and in its owner's name, and nobody can hold it to anything: whoever deals with it deals with a key. Novi Corpus makes agents actors. An agent with a Novi Corpus legal body represents a company, a Wyoming DAO LLC, which can sign, contract, invoice, hire and be hired, pay and be paid, and be held liable, with one person who answers for it, checked as one real person.";
const M1_PAGES = { index: M1_SHORT, 'start/what-it-unlocks': M1_FULL };

/** Word budgets of plain pages (2.7.2 rule 1): about 250, the landing about 400. */
const BUDGET = { default: 250, index: 400 };

/** [pattern, why, applies(pageId)?] */
const BANNED = [
	// 2.5 rule 1: the claims ceiling is "a registered legal body".
	[/\bverified compan(y|ies)\b/i, 'above the claims ceiling (2.5 rule 1)'],
	[/\bKYC\b/i, 'above the claims ceiling (2.5 rule 1)'],
	[/\blicensed\b/i, 'above the claims ceiling (2.5 rule 1)'],
	[/\bgood standing\b/i, 'above the claims ceiling (2.5 rule 1)'],
	[/\bhuman[\s-]?back(ed|ing)\b/i, 'above the claims ceiling (2.5 rule 1)'],
	[/\bguarantee(s|d)?\b/i, 'above the claims ceiling (2.5 rule 1)'],
	[/\ba real company\b/i, 'above the claims ceiling (2.5 rule 1)'],
	[/\bcourt[\s-]enforced\b/i, 'above the claims ceiling (2.5 rule 1)'],
	// 2.5 rules 2 to 4 and 2.8.
	[/\bnon[\s-]?custodial\b/i, 'never "non-custodial": say Novi Corpus holds no money, keys or identity (2.5 rule 2)'],
	[/\bautonomous\b/i, 'never "autonomous": the company is the legal person (2.5 rule 4)'],
	[/\bpersonally liable\b/i, 'the guardian "answers for it", never "personally liable" (2.8)'],
	[/\ba company of its own\b/i, 'the agent "represents a company", never "a company of its own" (v0.4)'],
	[/\bour agents\b/i, '"agents with a Novi Corpus legal body", never "our agents" (2.5 rule 3)'],
	// 2.5 rule 4: no sentence about what is built or not built.
	[/\bnot built\b/i, 'a sentence about build state (2.5 rule 4)'],
	[/\bas built\b/i, 'a sentence about build state (2.5 rule 4)'],
	[/\bnothing (of this )?is built\b/i, 'a sentence about build state (2.5 rule 4)'],
	[/\bsigns nothing\b/i, 'a sentence about build state (2.5 rule 4)'],
	[/\b(gives?|grants?) (the agent )?no permission\b/i, 'a sentence about build state (2.5 rule 4)'],
	[/\bno permission\b/i, 'a sentence about build state (gate, section 7)'],
	[/\bdoes not go to mainnet\b/i, 'a sentence about build state (2.5 rule 4)'],
	[/\bdesigned next\b/i, 'status is the section badge, not a phrase (gate, section 7)'],
	[/\bArc testnet only\b/i, 'status is the section badge, not a phrase (gate, section 7)'],
	// Names and vocabulary.
	[/\bNovi Corpus 2\.0\b/, 'the public name is "Novi 2.0" (2.4)'],
	[/\bCrossmint\b/i, 'no partner name (2.5 rule 8)'],
	[/\bAevum\b/i, 'no pilot name (2.5 rule 8)'],
	[/\bPredge\b/i, 'no partner name (2.5 rule 8)'],
	[/\bStripe\b/i, 'Stripe only in the policies (2.5 rule 8)', (id) => !id.startsWith('policies/')],
	[/\bdoola\b/i, '"our filing provider" until its contract is signed (2.5 rule 8)', () => !FILING_PROVIDER_NAMED],
	[/\bTurnkey\b/i, 'Turnkey only on the Novi Managed (testnet) pages', (id) => !id.startsWith('testnet/')],
	[/\bOlympix\W+(?:\w+\W+){0,3}audit/i, 'Olympix ran a scan, never an "audit" (2.5 rule 7)'],
	[/\baudit\w*\W+(?:\w+\W+){0,3}Olympix\b/i, 'Olympix ran a scan, never an "audit" (2.5 rule 7)'],
	// Legacy hosts and the old repository name.
	[/project-alpha-pi\.vercel\.app/i, 'a legacy host'],
	[/jb1011\/Project-Alpha(?![\w-])/i, 'the old repository name: jb1011/Novi-Corpus'],
	// Dashes (2.5 rule 13).
	[/—/, 'an em dash (2.5 rule 13): use a comma, a colon or a full stop'],
	[/–/, 'an en dash (2.5 rule 13): use a comma, a colon or a full stop'],
];

/** The review cast (2.7.4): never on a public page. */
const CAST = /\b(Dana|Pim|Theo|Kilnside|Lux|Mara|Ravi|Northbank)\b/;

/** Technical words that a plain page keeps inside its "For developers" box (2.7.3, 2.7.2 rule 5). */
const JARGON = [
	/\b0x[0-9a-f]{4,}/i,
	/\bERC-\d+/,
	/\bEIP-\d+/,
	/\bW\.S\./,
	/\bLegalManager\b/,
	/\battestor\b/i,
	/\bon[\s-]chain\b/i,
	/\b(agreement|manifest) hash\b/i,
	/\bECDSA\b/,
	/\bexpiresAt\b/,
	/\bguardian(Human|Identity)Verified\b/,
	/\brelying party\b/i,
	/\bcounterpart(y|ies)\b/i,
];

// ---------------------------------------------------------------------------

/** All files under dir with one of the extensions. */
function walk(dir, exts) {
	const out = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p, exts));
		else if (exts.includes(path.extname(e.name))) out.push(p);
	}
	return out.sort();
}

/** A tiny front matter reader: top-level `key: value` pairs only (enough for the checks). */
function frontMatter(src) {
	const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
	if (!m) return { data: null, body: src, offset: 0 };
	const data = {};
	for (const line of m[1].split('\n')) {
		const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (kv) data[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
	}
	return { data, body: src.slice(m[0].length), offset: m[0].split('\n').length - 1 };
}

/** Blank out a match but keep its newlines, so line numbers stay right. */
const blank = (s) => s.replace(/[^\n]/g, ' ');

/** The page without code: fenced blocks and inline code spans blanked. */
function withoutCode(body) {
	return body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank).replace(/`[^`\n]+`/g, blank);
}

/** Blank comments, import lines and the "For developers" box. */
function withoutMeta(body) {
	return body
		.replace(/<!--[\s\S]*?-->/g, blank)
		.replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
		.replace(/^import .*$/gm, blank);
}
function withoutDevBox(body) {
	return body.replace(/<Aside\s+variant=["']dev["'][\s\S]*?<\/Aside>/g, blank);
}

/** Line number (1-based, in the file) of an index in the body. */
const lineOf = (text, index, offset) => text.slice(0, index).split('\n').length + offset;

/** Visible words of a plain page, roughly: prose, card titles, link labels, captions; not the
 *  diagram's text version, not code, not comments, not the "For developers" box. */
function visibleWords(body, title, description) {
	let t = withoutDevBox(withoutMeta(withoutCode(body)));
	const kept = [];
	t = t.replace(/\b(title|caption|label|more)\s*[:=]\s*(["'])((?:(?!\2).)*)\2/g, (_, _k, _q, v) => {
		kept.push(v);
		return ' ';
	});
	t = t.replace(/\btext=\{?[\s\S]*?(\/>)/g, ' $1'); // the diagram's text version
	t = t.replace(/<[^>]*>/g, ' ').replace(/[{}[\]()#*_|>`]/g, ' ').replace(/\bhref\b.*$/gm, ' ');
	const words = (s) => (s.match(/[A-Za-z0-9][\w'.,:;!?/-]*/g) ?? []).length;
	return words(`${title} ${description}`) + words(t) + kept.reduce((n, v) => n + words(v), 0);
}

const errors = [];
const warnings = [];
const counts = [];
const err = (file, line, msg) => errors.push(`${file}:${line}  ${msg}`);
const warn = (file, line, msg) => warnings.push(`${file}:${line}  ${msg}`);

// Pages ----------------------------------------------------------------------

for (const file of walk(CONTENT, ['.md', '.mdx'])) {
	const rel = path.relative(ROOT, file);
	const id = path
		.relative(CONTENT, file)
		.replace(/\.mdx?$/, '')
		.replace(/(^|\/)index$/, '$1')
		.replace(/\/$/, '') || 'index';
	const src = fs.readFileSync(file, 'utf8');
	const { data, body, offset } = frontMatter(src);

	// Front matter.
	if (!data) {
		err(rel, 1, 'no front matter');
		continue;
	}
	for (const key of ['title', 'description', 'section', 'register', 'reviewed']) {
		if (!data[key]) err(rel, 1, `front matter: missing \`${key}\``);
	}
	if (data.section && !SECTION_IDS.includes(data.section)) err(rel, 1, `front matter: unknown section "${data.section}"`);
	if (data.register && !['plain', 'technical'].includes(data.register)) err(rel, 1, `front matter: register must be plain or technical`);
	if (data.reviewed && !/^\d{4}-\d{2}-\d{2}$/.test(data.reviewed)) err(rel, 1, 'front matter: `reviewed` must be YYYY-MM-DD');

	const allowInCode = /claims-check:\s*allow-in-code/.test(src);
	const prose = withoutMeta(withoutCode(body));
	// Banned words and dashes: prose, front matter values, and code unless the page opts out.
	const scanned = allowInCode ? prose : withoutMeta(body);
	const fmText = Object.values(data).join('\n');
	for (const [re, why, applies] of BANNED) {
		if (applies && !applies(id)) continue;
		const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
		for (const m of scanned.matchAll(g)) err(rel, lineOf(scanned, m.index, offset), `"${m[0].trim()}": ${why}`);
		for (const m of fmText.matchAll(g)) err(rel, 1, `front matter "${m[0].trim()}": ${why}`);
	}
	// The cast, anywhere in the page.
	for (const m of withoutMeta(body).matchAll(new RegExp(CAST.source, 'g')))
		err(rel, lineOf(body, m.index, offset), `"${m[0]}": a review-cast name on a public page (2.7.4)`);
	// A bare LLC, in prose and front matter.
	for (const text of [prose, fmText]) {
		for (const m of text.matchAll(/\bLLCs?\b/g)) {
			const before = text.slice(Math.max(0, m.index - 12), m.index);
			if (!/\b(DAO|Wyoming)\s+$/.test(before))
				err(rel, text === prose ? lineOf(prose, m.index, offset) : 1, 'a bare "LLC": write "Wyoming DAO LLC", "Wyoming LLC" or "company" (2.5 rule 5)');
		}
	}
	// The mainnet switch.
	if (!MAINNET_LIVE) {
		for (const m of (prose + '\n' + fmText).matchAll(/Live on Arc mainnet/gi))
			err(rel, lineOf(prose, Math.min(m.index, prose.length), offset), '"Live on Arc mainnet" by hand while MAINNET_LIVE is false (2.6): use <SectionBadge> or <Mainnet live>');
	}
	// The headline.
	if (M1_PAGES[id]) {
		const flat = prose.replace(/\s+/g, ' ');
		if (!flat.includes(M1_PAGES[id])) err(rel, 1, `the headline (M1, ${id === 'index' ? 'short' : 'full'} form) is missing or not verbatim (2.2)`);
	}
	// Plain pages: budget and jargon (warnings).
	if (data.register === 'plain') {
		const n = visibleWords(body, data.title ?? '', data.description ?? '');
		const budget = BUDGET[id] ?? BUDGET.default;
		counts.push([id, n, budget]);
		if (n > budget) warn(rel, 1, `about ${n} visible words, over the budget of ${budget} (2.7.2 rule 1)`);
		const outside = withoutDevBox(prose);
		for (const re of JARGON) {
			for (const m of outside.matchAll(new RegExp(re.source, re.flags + 'g')))
				warn(rel, lineOf(outside, m.index, offset), `"${m[0]}" on a plain page, outside the "For developers" box (2.7.3)`);
		}
	}
}

// Diagrams --------------------------------------------------------------------

for (const file of walk(DIAGRAMS, ['.svg'])) {
	const rel = path.relative(ROOT, file);
	const src = fs.readFileSync(file, 'utf8');
	// The words a reader sees: <text>, <title>, <desc>; the switched live group kept apart.
	const liveGroup = /<g data-mainnet="live">[\s\S]*?<\/g>/g;
	const pick = (s) =>
		[...s.matchAll(/<(text|title|desc)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((m) =>
			m[2].replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, '&'),
		);
	const words = pick(src).join('\n');
	const outsideLive = pick(src.replace(liveGroup, '')).join('\n');
	for (const [re, why, applies] of BANNED) {
		if (applies && !applies('diagram')) continue;
		const m = new RegExp(re.source, re.flags).exec(words);
		if (m) err(rel, 1, `"${m[0].trim()}": ${why}`);
	}
	if (CAST.test(words)) err(rel, 1, 'a review-cast name in a diagram (2.7.4)');
	for (const m of words.matchAll(/\bLLCs?\b/g)) {
		if (!/\b(DAO|Wyoming)\s+$/.test(words.slice(Math.max(0, m.index - 12), m.index)))
			err(rel, 1, 'a bare "LLC" in a diagram (2.5 rule 5)');
	}
	if (!MAINNET_LIVE && /Live on Arc mainnet/i.test(outsideLive))
		err(rel, 1, '"Live on Arc mainnet" outside a <g data-mainnet="live"> group while MAINNET_LIVE is false (2.6)');
}

// Report ----------------------------------------------------------------------

if (SHOW_COUNTS) {
	console.log('Plain pages, visible words (approximate) / budget:');
	for (const [id, n, b] of counts) console.log(`  ${String(n).padStart(4)} / ${b}  ${id}`);
}
for (const w of warnings) console.log(`warning  ${w}`);
for (const e of errors) console.error(`error    ${e}`);
console.log(
	`claims-check: ${errors.length} error(s), ${warnings.length} warning(s); MAINNET_LIVE=${MAINNET_LIVE}, FILING_PROVIDER_NAMED=${FILING_PROVIDER_NAMED}`,
);
process.exit(errors.length ? 1 : 0);
