import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { docsLoader, i18nLoader } from '@astrojs/starlight/loaders';
import { docsSchema, i18nSchema } from '@astrojs/starlight/schema';
import { topicSchema } from 'starlight-sidebar-topics/schema';
import { SECTION_IDS } from './sections.mjs';

const section = z.enum(SECTION_IDS);

// Front matter of every page (design 4.4 badge line, 2.5 rule 16, 2.7 registers).
export const collections = {
	// Starlight UI strings; empty unless src/content/i18n/ exists (declared to keep the build quiet).
	i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			extend: topicSchema.extend({
				/** The product section the page belongs to; its badge is printed under the title. */
				section,
				/** Plain (concept) or technical (engineer) page, design 2.7. */
				register: z.enum(['plain', 'technical']),
				/** Prints "Describes Arc mainnet" or "Describes Arc testnet" in the badge line. */
				network: z.enum(['arc-mainnet', 'arc-testnet']).optional(),
				/** Last content review, printed as "Last reviewed 6 November 2026". */
				reviewed: z.coerce.date().optional(),
				/** "What's new" entries, on `help/changelog.md` only (newest first). */
				entries: z
					.array(
						z.object({
							date: z.coerce.date(),
							section,
							text: z.string(),
							href: z.string().optional(),
						}),
					)
					.optional(),
			}),
		}),
	}),
};
