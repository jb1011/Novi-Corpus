/**
 * The choice of paths, rendered as the server renders it.
 *
 * One card per path the deployment offers, each with the lines its facts allow and no other: a
 * price only where the server charges and names the fee, "no payment" only on testnet, a time
 * from the server's estimate. A form card whose places are taken stays on screen, cannot be
 * picked, and links to the early-access list. The sentence about what every path needs is said
 * once, under the cards, and the one Continue waits for a pick.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PathChoice } from "@/components/start/PathChoice";
import { START_COPY } from "@/lib/start/copy";
import type { PathCard, PathFacts, PathId } from "@/lib/start/paths";

const S = START_COPY.cards;

const THREE: PathCard[] = [
  { id: "form", state: "offered" },
  { id: "declare", state: "offered" },
  { id: "full", state: "offered" },
];

const SANDBOX: PathFacts = {
  environment: "sandbox",
  filingWorkingDays: 5,
  formationPaymentRequired: false,
  formationFeeUsdc: 399,
  stepCount: 8,
};

const PRODUCTION_PAID: PathFacts = {
  environment: "production",
  filingWorkingDays: 5,
  formationPaymentRequired: true,
  formationFeeUsdc: 399,
  stepCount: 8,
};

const outputs: string[] = [];

function render(p: {
  cards?: readonly PathCard[];
  initial?: PathId | null;
  facts?: PathFacts;
  busy?: boolean;
  back?: { href: string; label: string };
}): string {
  const html = renderToString(
    createElement(PathChoice, {
      cards: p.cards ?? THREE,
      initial: p.initial ?? null,
      facts: p.facts ?? SANDBOX,
      busy: p.busy,
      back: p.back,
      onContinue: () => {},
    }),
  );
  outputs.push(html);
  // The apostrophes a person reads ("My agent's company"), as they read them; tags unchanged.
  return html.replace(/&#x27;/g, "'");
}

/** The opening tag of the radio for one path. */
function radio(html: string, id: PathId): string | null {
  return html.match(new RegExp(`<input[^>]*value="${id}"[^>]*>`))?.[0] ?? null;
}

/** The opening tag of the one Continue button. */
function continueButton(html: string): string {
  const buttons = html.match(/<button[^>]*>/g) ?? [];
  expect(buttons).toHaveLength(1);
  return buttons[0] ?? "";
}

const occurrences = (html: string, text: string) => html.split(text).length - 1;

/** The attributes themselves, never a class such as Tailwind's `disabled:` variant. */
const DISABLED = /\sdisabled=""/;
const CHECKED = /\schecked=""/;

describe("the choice on testnet", () => {
  test("three offered cards: the three titles, no payment on testnet, and the wizard's step count", () => {
    const html = render({});
    expect(html).toContain(S.form.title);
    expect(html).toContain(S.declare.title);
    expect(html).toContain(S.full.title);
    expect(html).toContain("No payment on testnet");
    expect(html).toContain("8 steps.");
    expect(html).toContain(S.full.tag);
    expect(html).toContain(S.form.timeSandbox);
    expect(html).toContain(S.declare.needsSandbox);
    expect(html).not.toContain(S.declare.needsProduction);
    expect(html).not.toContain("USDC, paid before filing");
  });

  test("the money sentence never says free", () => {
    const html = render({});
    expect(html).not.toContain("Free on testnet");
    expect(html).not.toMatch(/\bfree\b/i);
  });

  test("one selectable card per offered path, with radio semantics", () => {
    const html = render({ initial: "declare" });
    for (const id of ["form", "declare", "full"] as const) {
      const tag = radio(html, id);
      expect(tag).not.toBeNull();
      expect(tag).toContain('type="radio"');
      expect(tag).not.toMatch(DISABLED);
    }
    expect(radio(html, "declare")).toMatch(CHECKED);
    expect(radio(html, "form")).not.toMatch(CHECKED);
    expect(occurrences(html, 'name="path"')).toBe(3);
  });

  test("what every path needs is said once, under the cards", () => {
    const html = render({});
    expect(occurrences(html, START_COPY.needs)).toBe(1);
    expect(html.indexOf(START_COPY.needs)).toBeGreaterThan(html.indexOf(S.full.title));
  });
});

describe("a form card whose places are all taken", () => {
  const fullUp: PathCard[] = [
    { id: "form", state: "full_up" },
    { id: "declare", state: "offered" },
  ];

  test("stays on screen, says so, and links to the early-access list", () => {
    const html = render({ cards: fullUp, initial: "declare" });
    expect(html).toContain(S.form.title);
    expect(html).toContain("All places are taken.");
    expect(html).toContain('href="/founding-5"');
    expect(html).toContain(S.form.fullUpLink);
  });

  test("its radio cannot be picked", () => {
    const html = render({ cards: fullUp, initial: "declare" });
    expect(radio(html, "form")).toMatch(DISABLED);
    expect(radio(html, "form")).not.toMatch(CHECKED);
    expect(radio(html, "declare")).not.toMatch(DISABLED);
  });

  test("an offered form card has no full-up line", () => {
    const html = render({});
    expect(html).not.toContain(S.form.fullUp);
    expect(html).not.toContain('href="/founding-5"');
  });
});

describe("the choice on production", () => {
  test("a charging deployment names the fee and the filing estimate, never testnet", () => {
    const html = render({
      cards: [
        { id: "form", state: "offered" },
        { id: "declare", state: "offered" },
      ],
      facts: PRODUCTION_PAID,
    });
    expect(html).toContain("399 USDC, paid before filing");
    expect(html).toContain("About 5 working days");
    expect(html).toContain(S.declare.needsProduction);
    expect(html).not.toContain("Free on testnet");
    expect(html).not.toContain("No payment on testnet");
    expect(html).not.toContain(S.form.timeSandbox);
    expect(html).not.toContain(S.declare.needsSandbox);
  });

  test("a deployment that says nothing about payment or time shows no price and no time", () => {
    const html = render({
      facts: { ...PRODUCTION_PAID, formationPaymentRequired: false, filingWorkingDays: null },
    });
    expect(html).not.toContain("USDC, paid before filing");
    expect(html).not.toContain("No payment on testnet");
    expect(html).not.toContain("working days");
  });

  test("a charge without a fee to name shows no price at all", () => {
    const html = render({ facts: { ...PRODUCTION_PAID, formationFeeUsdc: null } });
    expect(html).not.toContain("USDC, paid before filing");
    expect(html).not.toContain("{fee}");
  });

  test("a charge on testnet is a price, never no payment", () => {
    const html = render({ facts: { ...SANDBOX, formationPaymentRequired: true } });
    expect(html).toContain("399 USDC, paid before filing");
    expect(occurrences(html, "No payment on testnet")).toBe(1); // the declare card's only
  });
});

describe("the one Continue", () => {
  test("waits for a pick", () => {
    expect(continueButton(render({ initial: null }))).toMatch(DISABLED);
  });

  test("is ready with a card picked", () => {
    expect(continueButton(render({ initial: "form" }))).not.toMatch(DISABLED);
  });

  test("waits while busy", () => {
    expect(continueButton(render({ initial: "form", busy: true }))).toMatch(DISABLED);
  });

  test("a pick that is not an offered card counts as none", () => {
    const html = render({
      cards: [
        { id: "form", state: "full_up" },
        { id: "declare", state: "offered" },
      ],
      initial: "form",
    });
    expect(continueButton(html)).toMatch(DISABLED);
  });
});

describe("the way back", () => {
  test("shown only when given", () => {
    const back = { href: "/agents", label: START_COPY.backToAgents };
    const html = render({ back });
    expect(html).toContain('href="/agents"');
    expect(html).toContain("Back to my agents");
    expect(render({})).not.toContain('href="/agents"');
  });
});

describe("every render", () => {
  test("carries no em dash and no unfilled placeholder", () => {
    render({});
    render({ facts: PRODUCTION_PAID });
    expect(outputs.length).toBeGreaterThan(5);
    for (const html of outputs) {
      expect(html).not.toContain("—");
      expect(html).not.toMatch(/\{(days|fee|count)\}/);
    }
  });
});
