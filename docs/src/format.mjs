// Dates in words (design 2.5 rule 14): "6 November 2026".
const LONG = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
// Short form for lists: "6 Nov".
const SHORT = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** @param {Date} d */
export const formatDate = (d) => LONG.format(d);
/** @param {Date} d */
export const formatShortDate = (d) => SHORT.format(d);
/** @param {Date} d */
export const isoDate = (d) => d.toISOString().slice(0, 10);
