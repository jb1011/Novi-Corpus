/**
 * The grant form of the test page, rendered as the server renders it.
 *
 * What is pinned: the notice comes first, as served; a form opens with nothing ticked, nothing
 * typed and nothing chosen, and no control carries a placeholder; the settings offered for the
 * four acts of `heavyActs` are the served ones, in the served order; the three fixed rules stand
 * beside their lines in the server's words; a problem the server answered shows under its line;
 * and the form says nothing of its own about what a choice means.
 *
 * The amounts in these tests are made up: they are not proposals.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { GrantForm } from "@/components/charterTest/GrantForm";
import {
  emptyGrantFormState,
  type GrantFormState,
  type ServedGrantForm,
} from "@/lib/charterTest/grantForm";
import type { FieldProblem } from "@/lib/charterTest/refusal";

const NOTICE =
  "Notice: this document is a fixed form. It is not a substitute for the advice of an attorney. Novi Corpus is not a law firm and does not give legal advice (section 12).";

const FORM: ServedGrantForm = {
  text: { id: "legal-body-operating-agreement", version: "2026-11-draft-5", status: "draft" },
  schema: "novi.legal-body-grant/1",
  amountMax: 1_000_000_000,
  heavyActModes: {
    employ: ["not_allowed", "guardian_signature"],
    borrow: ["not_allowed", "guardian_signature", "alone"],
    guarantee: ["not_allowed", "guardian_signature", "alone"],
    transferProperty: ["not_allowed", "guardian_signature"],
  },
  notice: NOTICE,
};

function render(
  state: GrantFormState,
  over: { form?: ServedGrantForm; problems?: FieldProblem[] } = {},
): string {
  return renderToStaticMarkup(
    createElement(GrantForm, {
      form: over.form ?? FORM,
      state,
      onChange: () => {},
      problems: over.problems ?? [],
    }),
  );
}

/** Every opening tag of `name` in the markup. */
const tags = (html: string, name: string): string[] => html.match(new RegExp(`<${name}\\b[^>]*>`, "g")) ?? [];
/** The markup of the control labelled `label`, up to its closing tag for a select. */
function select(html: string, label: string): string {
  const start = html.indexOf(`<select aria-label="${label}"`);
  if (start < 0) throw new Error(`no select labelled ${label}`);
  return html.slice(start, html.indexOf("</select>", start));
}
const optionsOf = (selectHtml: string): string[] =>
  [...selectHtml.matchAll(/<option value="([^"]*)"/g)].map((m) => m[1]);
const selectedOf = (selectHtml: string): string[] =>
  [...selectHtml.matchAll(/<option value="([^"]*)" selected=""/g)].map((m) => m[1]);
/** The text of the markup, without its tags. */
const textOf = (html: string): string => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

describe("a form as it opens", () => {
  const html = render(emptyGrantFormState());

  test("the notice comes first, as served", () => {
    expect(textOf(html).trimStart().startsWith(NOTICE)).toBe(true);
  });

  test("a form with no notice shows none", () => {
    const without = render(emptyGrantFormState(), { form: { ...FORM, notice: null } });
    expect(without).not.toContain("Notice:");
  });

  test("nothing is ticked", () => {
    expect(tags(html, "input").filter((t) => t.includes('type="checkbox"'))).toHaveLength(7);
    expect(tags(html, "input").filter((t) => t.includes('type="radio"'))).toHaveLength(2);
    expect(html).not.toContain("checked");
  });

  test("nothing is typed, and no control has a placeholder", () => {
    const texts = tags(html, "input").filter((t) => t.includes('type="text"'));
    // Six lines with an amount per act, three of them with one per thirty days, four acts of
    // heavyActs, and the end's date.
    expect(texts).toHaveLength(6 + 3 + 4 + 1);
    for (const input of texts) expect(input).toContain('value=""');
    expect(html).not.toContain("placeholder");
  });

  test("the settings with no 'not allowed' start not chosen", () => {
    const above = ["provideServices", "acceptEngagement", "issueInvoice", "buy", "pay", "engageContractor"];
    for (const key of above) {
      const s = select(html, `acts.${key}.above`);
      expect(optionsOf(s)).toEqual(["", "guardian_signature", "not_allowed"]);
      expect(selectedOf(s)).toEqual([""]);
    }
    expect(html).not.toContain('aria-label="acts.receivePayment.above"');
    const counterparties = select(html, "counterparties");
    expect(optionsOf(counterparties)).toEqual(["", "anyone", "active_legal_body"]);
    expect(selectedOf(counterparties)).toEqual([""]);
  });

  test("each act of heavyActs offers the served settings, in the served order, and opens at not_allowed", () => {
    expect(optionsOf(select(html, "heavyActs.employ.mode"))).toEqual(["not_allowed", "guardian_signature"]);
    expect(optionsOf(select(html, "heavyActs.borrow.mode"))).toEqual(["not_allowed", "guardian_signature", "alone"]);
    expect(optionsOf(select(html, "heavyActs.guarantee.mode"))).toEqual(["not_allowed", "guardian_signature", "alone"]);
    expect(optionsOf(select(html, "heavyActs.transferProperty.mode"))).toEqual(["not_allowed", "guardian_signature"]);
    for (const act of ["employ", "borrow", "guarantee", "transferProperty"])
      expect(selectedOf(select(html, `heavyActs.${act}.mode`))).toEqual(["not_allowed"]);
  });

  test("another served order is the order shown", () => {
    const other = render(emptyGrantFormState(), {
      form: { ...FORM, heavyActModes: { ...FORM.heavyActModes, borrow: ["alone", "not_allowed"] } },
    });
    expect(optionsOf(select(other, "heavyActs.borrow.mode"))).toEqual(["alone", "not_allowed"]);
    expect(selectedOf(select(other, "heavyActs.borrow.mode"))).toEqual(["not_allowed"]);
  });

  test("the three fixed rules stand beside their lines, in the server's words", () => {
    const text = textOf(html);
    expect(text).toContain("Rule: acts.receivePayment.allowed must be true when invoices are allowed");
    for (const key of ["buy", "pay", "engageContractor"])
      expect(text).toContain(`Rule: acts.${key}.per30Days must be at least the amount per act`);
    expect(text).toContain("Rule: endsOn must be after today (UTC)");
    expect(text.match(/Rule: /g)).toHaveLength(5);
  });

  test("the served bound and text are shown as served", () => {
    const text = textOf(html);
    expect(text).toContain("novi.legal-body-grant/1");
    expect(text).toContain("legal-body-operating-agreement 2026-11-draft-5 (draft)");
    expect(text).toContain("1000000000");
  });

  test("every line is named by its key", () => {
    const text = textOf(html);
    for (const key of ["provideServices", "acceptEngagement", "issueInvoice", "receivePayment", "buy", "pay", "engageContractor"])
      expect(text).toContain(`acts.${key}`);
    for (const act of ["employ", "borrow", "guarantee", "transferProperty"])
      expect(text).toContain(`heavyActs.${act}`);
  });

  test("the form's own words say nothing of what a choice means", () => {
    // Everything the form says beside the notice, the served values, the keys and the rules.
    const own = textOf(html).replace(NOTICE, "");
    for (const word of [
      "recommend",
      "suggest",
      "typical",
      "default",
      "safe",
      "binds",
      "liable",
      "enforce",
      "until revoked",
      "manager",
    ])
      expect(own.toLowerCase()).not.toContain(word);
    expect(own).not.toContain(String.fromCharCode(0x2014));
  });
});

describe("a form with choices", () => {
  const state = emptyGrantFormState();
  state.acts.buy = { allowed: true, perAct: "43", per30Days: "0977", above: "guardian_signature" };
  state.heavyActs.borrow = { mode: "alone", perAct: "389" };
  state.counterparties = "anyone";
  state.ends = "date";
  state.endsOn = "2031-03-09";
  const html = render(state);

  test("what was typed is shown as typed", () => {
    expect(html).toContain('aria-label="acts.buy.perAct"');
    expect(html).toMatch(/<input[^>]*aria-label="acts\.buy\.perAct"[^>]*value="43"/);
    expect(html).toMatch(/<input[^>]*aria-label="acts\.buy\.per30Days"[^>]*value="0977"/);
    expect(html).toMatch(/<input[^>]*aria-label="heavyActs\.borrow\.perAct"[^>]*value="389"/);
    expect(html).toMatch(/<input[^>]*aria-label="endsOn date"[^>]*value="2031-03-09"/);
  });

  test("what was chosen is shown as chosen, and nothing else is", () => {
    expect(selectedOf(select(html, "acts.buy.above"))).toEqual(["guardian_signature"]);
    expect(selectedOf(select(html, "acts.pay.above"))).toEqual([""]);
    expect(selectedOf(select(html, "heavyActs.borrow.mode"))).toEqual(["alone"]);
    expect(selectedOf(select(html, "counterparties"))).toEqual(["anyone"]);
    const checked = tags(html, "input").filter((t) => t.includes("checked"));
    expect(checked).toHaveLength(2);
    expect(checked[0]).toContain('aria-label="acts.buy.allowed"');
    expect(checked[1]).toContain('aria-label="endsOn: a date"');
  });

  test("the amounts of a line that is not allowed cannot be typed", () => {
    expect(html).toMatch(/<input[^>]*aria-label="acts\.pay\.perAct"[^>]*disabled=""/);
    expect(html).not.toMatch(/<input[^>]*aria-label="acts\.buy\.perAct"[^>]*disabled=""/);
    expect(html).toMatch(/<input[^>]*aria-label="heavyActs\.guarantee\.perAct"[^>]*disabled=""/);
    expect(html).not.toMatch(/<input[^>]*aria-label="heavyActs\.borrow\.perAct"[^>]*disabled=""/);
  });
});

describe("the server's problems", () => {
  const problems: FieldProblem[] = [
    { field: "acts.buy.per30Days", problem: "must be at least the amount per act" },
    { field: "acts.receivePayment.allowed", problem: "must be true when invoices are allowed" },
    { field: "heavyActs.employ.mode", problem: "must be not_allowed or guardian_signature" },
    { field: "counterparties", problem: "is required" },
    { field: "endsOn", problem: "must be after today (UTC)" },
    { field: "grant", problem: "must allow at least one act" },
  ];
  const html = render(emptyGrantFormState(), { problems });
  const text = textOf(html);

  test("each shows under the line it names, field then problem, as served", () => {
    expect(text).toContain("acts.buy.per30Days: must be at least the amount per act");
    expect(text).toContain("acts.receivePayment.allowed: must be true when invoices are allowed");
    expect(text).toContain("heavyActs.employ.mode: must be not_allowed or guardian_signature");
    expect(text).toContain("counterparties: is required");
    expect(text).toContain("endsOn: must be after today (UTC)");
  });

  test("a problem of the whole grant is not one of a line: the page lists it", () => {
    expect(text).not.toContain("grant: must allow at least one act");
  });

  test("a problem of one line does not show under another whose name starts the same", () => {
    const one = render(emptyGrantFormState(), {
      problems: [{ field: "acts.payroll.perAct", problem: "is not a field of a grant" }],
    });
    expect(textOf(one)).not.toContain("acts.payroll.perAct");
  });
});
