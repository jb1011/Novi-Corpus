/**
 * The home page's ways in, rendered as the server renders them.
 *
 * One card per path `landingPaths` names: an offered card leads to `/start` with its path, a form
 * card whose places are taken says so and leads to the early-access list, and the full product's
 * card carries its testnet tag. Before the config is there the section keeps its heading and an
 * empty area, so nothing jumps and no card is claimed; an unreadable config shows the two
 * legal-body paths; the Testnet tag stands on an explicit sandbox answer and on nothing else.
 * No button on the home page opens the wizard directly any more: every one leads to `/start`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ getPublicConfig: vi.fn() }));
vi.mock("@/lib/api/client", () => api);

import { AgentCTA } from "@/components/landing/AgentCTA";
import { Hero } from "@/components/landing/Hero";
import { Nav } from "@/components/landing/Nav";
import { PathsSection, PathsView } from "@/components/landing/PathsSection";
import { landingCards, showsTestnetTag, type LandingConfig } from "@/components/landing/useLandingConfig";
import { GET_STARTED_CTA, ONBOARDING_STEP_COUNT, PATHS_HEADING, TESTNET_TAG } from "@/components/landing/copy";
import PersonhoodPage from "@/app/personhood/page";
import type { PublicConfig } from "@/lib/api/types";
import { START_COPY } from "@/lib/start/copy";
import { landingPaths, type PathCard } from "@/lib/start/paths";

const C = START_COPY.cards;

/** The apostrophes a person reads ("My agent's company"), as they read them; tags unchanged. */
const html = (element: Parameters<typeof renderToString>[0]) =>
  renderToString(element).replace(/&#x27;/g, "'");

const view = (cards: readonly PathCard[]) => html(createElement(PathsView, { cards }));

const THREE: PathCard[] = [
  { id: "form", state: "offered" },
  { id: "declare", state: "offered" },
  { id: "full", state: "offered" },
];

/** A legal-body config with the fields a case changes. */
const lb = (over: object) =>
  ({ available: true, declarations: true, environment: "sandbox", formedDoor: "offered", ...over }) as never;
const base: PublicConfig = { walletProviderDefault: "circle", circleCustodyAvailable: true };
const TESTNET: PublicConfig = { ...base, fullProductAvailable: true, legalBodies: lb({}) };
const MAINNET_BEFORE_INVITATIONS: PublicConfig = {
  ...base,
  fullProductAvailable: false,
  legalBodies: lb({ environment: "production", formedDoor: "hidden" }),
};

describe("the cards", () => {
  test("before a config: the two legal-body paths, each to the start with its path", () => {
    const out = view(landingPaths(null));
    expect(out).toContain(C.form.title);
    expect(out).toContain(C.declare.title);
    expect(out).toContain(C.form.body);
    expect(out).toContain(C.declare.body);
    expect(out).toContain('href="/start?path=form"');
    expect(out).toContain('href="/start?path=declare"');
    expect(out).not.toContain(C.full.title);
    expect(out).not.toContain('href="/start?path=full"');
  });

  test("testnet: the full product's card, to the start, with its tag and its step count", () => {
    const out = view(THREE);
    expect(out).toContain('href="/start?path=full"');
    expect(out).toContain(C.full.title);
    expect(out).toContain(C.full.tag);
    expect(out).toContain(`${ONBOARDING_STEP_COUNT} steps.`);
    expect(out).not.toContain("{count}");
  });

  test("places all taken: the form card says so and leads to the early-access list", () => {
    const out = view([{ id: "form", state: "full_up" }, { id: "declare", state: "offered" }]);
    expect(out).toContain(C.form.title);
    expect(out).toContain(C.form.fullUp);
    expect(out).toContain(C.form.fullUpLink);
    expect(out).toContain('href="/founding-5"');
    expect(out).not.toContain('href="/start?path=form"');
    expect(out).toContain('href="/start?path=declare"');
  });

  test("the section is the one the buttons scroll to", () => {
    const out = view(THREE);
    expect(out).toContain('id="paths"');
    expect(out).toContain(PATHS_HEADING);
  });
});

describe("what the section shows for each answer", () => {
  const loading: LandingConfig = { status: "loading", config: null };
  const error: LandingConfig = { status: "error", config: null };
  const ready = (config: PublicConfig): LandingConfig => ({ status: "ready", config });

  test("loading: no card at all", () => {
    expect(landingCards(loading)).toBeNull();
  });
  test("unreadable: the two legal-body paths", () => {
    expect(landingCards(error)).toEqual(landingPaths(null));
  });
  test("ready: exactly what the config offers", () => {
    expect(landingCards(ready(TESTNET))).toEqual(THREE);
    expect(landingCards(ready(MAINNET_BEFORE_INVITATIONS))).toEqual([{ id: "declare", state: "offered" }]);
  });
  test("the Testnet tag: only a ready config that says sandbox", () => {
    expect(showsTestnetTag(loading)).toBe(false);
    expect(showsTestnetTag(error)).toBe(false);
    expect(showsTestnetTag(ready(MAINNET_BEFORE_INVITATIONS))).toBe(false);
    expect(showsTestnetTag(ready(base))).toBe(false);
    expect(showsTestnetTag(ready(TESTNET))).toBe(true);
  });

  test("the server render is the loading one: the heading, no card, no link to a path", () => {
    const out = html(createElement(PathsSection));
    expect(out).toContain('id="paths"');
    expect(out).toContain(PATHS_HEADING);
    for (const card of [C.form, C.declare, C.full]) expect(out).not.toContain(card.title);
    expect(out).not.toContain("/start?path=");
    expect(out).not.toContain('href="/founding-5"');
  });
});

describe("the buttons", () => {
  test("the nav leads to the start, and says nothing of testnet before the config", () => {
    const out = html(createElement(Nav));
    expect(out).toContain('href="/start"');
    expect(out).not.toContain(TESTNET_TAG);
  });
  test("the hero and the closing lead to the start and to the ways in", () => {
    for (const component of [Hero, AgentCTA]) {
      const out = html(createElement(component));
      expect(out).toContain('href="/start"');
      expect(out).toContain('href="#paths"');
    }
  });
  test("the personhood page leads to the start, and says so: the start is not the wizard", () => {
    const out = html(createElement(PersonhoodPage));
    expect(out).toMatch(new RegExp(`<a[^>]*href="/start"[^>]*>${GET_STARTED_CTA}</a>`));
    expect(out).not.toContain("Start onboarding");
  });
  test("the hero's record card names no treasury", () => {
    expect(html(createElement(Hero)).toLowerCase()).not.toContain("treasury");
  });
});

describe("no home page file opens the wizard directly", () => {
  const src = (path: string) => fileURLToPath(new URL(`../src/${path}`, import.meta.url));
  const landing = readdirSync(src("components/landing")).map((name) => `components/landing/${name}`);
  const files = ["app/page.tsx", "app/personhood/page.tsx", ...landing];

  test("the walk reads the landing folder", () => {
    expect(landing).toContain("components/landing/Hero.tsx");
    expect(landing).toContain("components/landing/PathsSection.tsx");
  });

  test.each(files)("%s", (file) => {
    expect(readFileSync(src(file), "utf8")).not.toContain('href="/onboarding"');
  });
});

describe("one request per page load", () => {
  beforeEach(() => {
    vi.resetModules();
    api.getPublicConfig.mockReset();
  });

  test("every caller shares the one answer", async () => {
    api.getPublicConfig.mockResolvedValue(TESTNET);
    const { loadLandingConfig } = await import("@/components/landing/useLandingConfig");
    const first = loadLandingConfig();
    const second = loadLandingConfig();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual(TESTNET);
    await expect(loadLandingConfig()).resolves.toEqual(TESTNET);
    expect(api.getPublicConfig).toHaveBeenCalledTimes(1);
  });

  test("a failed answer is shared too, and the next page asks again", async () => {
    api.getPublicConfig.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce(TESTNET);
    const { loadLandingConfig } = await import("@/components/landing/useLandingConfig");
    const first = loadLandingConfig();
    expect(loadLandingConfig()).toBe(first);
    await expect(first).rejects.toThrow("down");
    await expect(loadLandingConfig()).resolves.toEqual(TESTNET);
    expect(api.getPublicConfig).toHaveBeenCalledTimes(2);
  });
});
