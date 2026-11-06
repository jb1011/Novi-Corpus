// The five product sections of the docs (design 2.8 and 3.2), in tab order.
// One source for the top tabs, the sidebar topics, the badge line and the cards.
//
// `badge` is the section badge, in the exact words of design 2.5 rule 9.
// Overview and Developers carry no badge.
// `icon` names a glyph of src/components/icons.mjs; `slIcon` is the closest
// Starlight built-in icon, kept in the topic config for the plugin's own list.

/** @typedef {'overview' | 'minimal-novi' | 'novi-managed' | 'novi-2' | 'developers'} SectionId */

/**
 * THE MAINNET SWITCH (design 2.6, the step-1 condition).
 *
 * `false` until the mainnet deploy ceremony: the Minimal Novi badge then reads
 * "Arc mainnet (beta), opens in mid-November" everywhere it appears (the tabs, the badge
 * line, the cards, diagram D6, llms.txt), and every page that states something as live on
 * mainnet carries that condition through `<Mainnet live>` / `<Mainnet pending>`.
 * Flip it to `true` in the step-2 PR, the day the beta opens; nothing else changes by hand.
 * tools/claims-check.mjs refuses a hard-coded "Live on Arc mainnet" while it is `false`.
 */
export const MAINNET_LIVE = false;

export const SECTION_IDS = /** @type {const} */ (['overview', 'minimal-novi', 'novi-managed', 'novi-2', 'developers']);

export const SECTIONS = {
	overview: { label: 'Overview', link: '/', icon: 'compass', slIcon: 'information' },
	'minimal-novi': {
		label: 'Minimal Novi',
		link: '/live/',
		icon: 'building',
		slIcon: 'approve-check-circle',
		badge: MAINNET_LIVE ? 'Live on Arc mainnet (beta)' : 'Arc mainnet (beta), opens in mid-November',
		short: MAINNET_LIVE ? 'live' : 'opens in mid-November',
		variant: 'success',
	},
	'novi-managed': {
		label: 'Novi Managed',
		link: '/testnet/',
		icon: 'wallet',
		slIcon: 'setting',
		badge: 'Coming later',
		short: 'coming later',
		variant: 'caution',
	},
	'novi-2': {
		label: 'Novi 2.0',
		link: '/next/',
		icon: 'sparkle',
		slIcon: 'star',
		badge: 'In design',
		short: 'in design',
		variant: 'tip',
	},
	developers: { label: 'Developers', link: '/developers/', icon: 'code', slIcon: 'laptop' },
};

/** Sidebar group icons (design 3.2), by group label. */
export const GROUP_ICONS = {
	Policies: 'scales',
	Help: 'lifebuoy',
	'Get a legal body': 'door',
	'How it works': 'link',
	'Check an agent': 'search',
	'Try it on Arc testnet': 'flask',
};

/** "Describes" line of the badge line (design 2.5 rule 16). */
export const NETWORKS = {
	'arc-mainnet': 'Describes Arc mainnet',
	'arc-testnet': 'Describes Arc testnet',
};

/** The page tree of design 3.2: one sidebar per section. */
const TREE = {
	overview: [
		{ label: 'Novi Corpus docs', link: '/' },
		{ label: 'Agents as actors: what a legal body unlocks', slug: 'start/what-it-unlocks' },
		{ label: 'Use cases', slug: 'start/use-cases' },
		{ label: 'Status', slug: 'start/status' },
		{ label: 'Key terms', slug: 'start/key-terms' },
		{ label: 'FAQ', slug: 'start/faq' },
		{ label: "What's new", slug: 'help/changelog' },
		{
			label: 'Policies',
			items: [
				{ label: 'Terms of use', slug: 'policies/terms' },
				{ label: 'Privacy notice', slug: 'policies/privacy' },
				{ label: 'Lawful requests for information', slug: 'policies/lawful-requests' },
				{ label: 'Relying on a Novi Corpus statement', slug: 'policies/relying-party' },
				{ label: 'Notices', slug: 'policies/notices' },
			],
		},
		{ label: 'Help', items: [{ label: 'Support and contact', slug: 'help/support' }] },
	],
	'minimal-novi': [
		{ label: 'Minimal Novi', slug: 'live' },
		{
			label: 'Get a legal body',
			items: [
				{ label: 'Bring your own company', slug: 'live/bring-your-own-company' },
				{ label: 'Bring your own agent', slug: 'live/bring-your-own-agent' },
				{ label: 'Who can join the beta', slug: 'live/beta-access' },
				{ label: 'Pricing', slug: 'live/pricing' },
			],
		},
		{
			label: 'How it works',
			items: [
				{ label: 'The guardian', slug: 'live/guardian' },
				{ label: 'What a Wyoming DAO LLC is', slug: 'start/wyoming-dao-llc' },
				{ label: 'The agreement and the declaration', slug: 'live/legal-texts' },
				{ label: 'Agent identity, link and pointer', slug: 'live/identity-and-link' },
				{ label: 'Change, revoke or dissolve', slug: 'live/lifecycle' },
			],
		},
		{
			label: 'Check an agent',
			items: [
				{ label: "Check an agent's legal body", slug: 'check/check-an-agent' },
				{ label: 'Verify a statement yourself', slug: 'check/verify' },
				{ label: 'Attestors and pinned addresses', slug: 'check/attestors' },
				// Kept at its old address until T1 (design 3.4), then split into the pages above.
				{ label: 'Legal-body statements', slug: 'identity/legal-body-statement' },
			],
		},
	],
	'novi-managed': [
		{ label: 'Novi Managed', slug: 'testnet' },
		{
			label: 'Try it on Arc testnet',
			items: [
				{ label: 'The account: caps, allowlist, pause', slug: 'testnet/treasury-product' },
				{ label: 'Payments and jobs', slug: 'testnet/payments-and-jobs' },
				{ label: 'MCP tools', slug: 'testnet/mcp' },
				{ label: 'ENS names', slug: 'testnet/ens' },
				{ label: 'REST API', slug: 'testnet/rest-api' },
				{ label: 'AgentBook and trust dials', slug: 'testnet/agentbook' },
				{ label: 'Pilots', slug: 'testnet/pilots' },
			],
		},
	],
	'novi-2': [
		{ label: 'Novi 2.0', slug: 'next' },
		{ label: 'Agents as actors', slug: 'next/agents-as-actors' },
		{ label: 'The agent asks, the human finishes in one link', slug: 'next/agent-first' },
		{ label: 'Code as the agreement: the DAO LLC features', slug: 'next/dao-llc-features' },
		{ label: 'Roadmap', slug: 'next/roadmap' },
	],
	developers: [
		{ label: 'Developers', slug: 'developers' },
		{ label: 'Lookup API', slug: 'developers/lookup-api' },
		{ label: 'Statement fields (EIP-712)', slug: 'developers/statement-fields' },
		{ label: 'Contracts and security', slug: 'developers/contracts' },
		{ label: 'Networks and addresses', slug: 'developers/networks' },
		{ label: 'For agents: MCP and llms.txt', slug: 'developers/for-agents' },
	],
};

/** The `starlight-sidebar-topics` config: one topic per section. */
export const TOPICS = SECTION_IDS.map((id) => {
	const s = SECTIONS[id];
	return {
		id,
		label: s.label,
		link: s.link,
		icon: s.slIcon,
		...(s.badge ? { badge: { text: s.badge, variant: s.variant } } : {}),
		items: TREE[id],
	};
});

/** Section of a topic link, for the tabs (the plugin's route data has no id). */
export function sectionByLink(link) {
	return SECTION_IDS.find((id) => SECTIONS[id].link === link);
}
