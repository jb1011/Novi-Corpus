// One line-icon set (design 4.4): 24 unit grid, drawn with a 1.7 stroke, no fill.
// Shared by the tabs, the sidebar groups, the cards and the diagrams, so the site
// and the drawings read as one hand. Paths copied from the approved mockups.
const invoice = '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6M9 16h3"/>';

export const ICONS = {
	personcheck: '<circle cx="10" cy="8" r="4"/><path d="M3 21c0-4 3-7 7-7 1.5 0 2.8.4 3.9 1M15 19l2 2 4-4"/>',
	wallet: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M16 15h2"/>',
	send: '<path d="M21 3L3 10l7 3 3 7zM10 13l11-10"/>',
	sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z"/>',
	building: '<path d="M3 21h18M5 21V8l7-5 7 5v13M9 21v-5h6v5M9 11h.01M15 11h.01"/>',
	person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
	link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.4 1.4M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.4-1.4"/>',
	bot: '<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 4v4"/><circle cx="12" cy="3.5" r="1"/><path d="M9 13h.01M15 13h.01M9.5 17h5"/>',
	seal: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
	key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l9-9M17 6l3 3M14 9l2 2"/>',
	store: '<path d="M4 10v10h16V10M3 10l2-6h14l2 6M3 10h18M9 20v-6h6v6"/>',
	handshake: '<path d="M3 12l4-4 5 3 5-3 4 4-9 7z"/><path d="M8 13l3 2M11 11l3 2"/>',
	invoice,
	receipt: invoice,
	coins: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
	pen: '<path d="M4 20l4-1 11-11-3-3L5 16zM14 6l3 3"/>',
	search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>',
	scales: '<path d="M12 3v18M5 7h14M8 21h8M5 7l-3 6a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0z"/>',
	scroll: '<path d="M7 3h11a2 2 0 0 1 2 2v12M7 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10M10 9l-2 2 2 2M14 9l2 2-2 2"/>',
	gauge: '<path d="M4 17a8 8 0 1 1 16 0M12 17l4-5"/><circle cx="12" cy="17" r="1"/>',
	plug: '<path d="M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5"/>',
	file: '<path d="M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h4"/>',
	door: '<path d="M5 21V4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v17M3 21h18M15 12h.01"/>',
	idcard: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="11" r="2"/><path d="M6 16c.6-1.4 1.6-2 2.5-2s1.9.6 2.5 2M14 10h4M14 14h3"/>',
	clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
	listcheck: '<path d="M10 6h10M10 12h10M10 18h10M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17"/>',
	pause: '<circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/>',
	inbox: '<path d="M3 13h5l1 3h6l1-3h5M5 5h14l2 8v6H3v-6z"/>',
	flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3M7 15h10"/>',
	lifebuoy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><path d="M5.6 5.6l3.6 3.6M14.8 14.8l3.6 3.6M18.4 5.6l-3.6 3.6M9.2 14.8l-3.6 3.6"/>',
	compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
	code: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12"/>',
	arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
	quote: '<path d="M7 7h4v4c0 3-1.5 5-4 6M15 7h4v4c0 3-1.5 5-4 6"/>',
	info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
};

/** @typedef {keyof typeof ICONS} IconName */
