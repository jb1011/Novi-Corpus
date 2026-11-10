/**
 * The Kleros check: what the stage's service answers to the three reads a filing believes
 * (tools/list, the instructions string, court_get on the stage's own chain and court), and every
 * problem it names. The fake answers for a rehearsal; the HTTP client answers over a recording
 * `fetch` for the two real deployments. Nothing here writes, and a test proves the check never
 * calls a write tool.
 */
import { readFileSync } from "node:fs";
import type { Address } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  KLEROS_DEPLOYMENTS,
  type KlerosDeploymentName,
  deploymentFor,
} from "../../src/adapters/kleros/deployments";
import type { CourtClock } from "../../src/adapters/kleros/disputeService";
import { FakeDisputeService } from "../../src/adapters/kleros/fakeDisputeService";
import { HttpDisputeService } from "../../src/adapters/kleros/httpDisputeService";
import type { Config, KlerosConfig } from "../../src/config/env";
import { type KlerosStage, buildKlerosService } from "../../src/pilot/composition";
import {
  MIN_EVIDENCE_PERIOD_SECONDS,
  UNAUTHORIZED_PROBLEM,
  checkKleros,
} from "../../src/pilot/klerosCheck";

const API_URL = "https://dispute-service.example.test/mcp";
const TESTNET_KEY = "test-key-testnet";
const LIVE_KEY = "test-key-live";
const ALL_TOOLS = ["dispute_create", "evidence_pin", "evidence_submit", "dispute_get", "court_get"];
/** The sentence a key's instructions use to say what its filing sends, as Kleros words it. */
const sends = (court: number, jurors: number, chain: string) =>
  `The court, juror count and template are fixed for you, and this call sends them:\ncourt ${court}, ${jurors} jurors, on ${chain}.`;
const INSTRUCTIONS: Record<KlerosDeploymentName, string> = {
  testnet: `Pass arbitrum-one or arbitrum-sepolia-testnet as chain.\n${sends(8, 5, "arbitrum-sepolia-testnet")}`,
  live: `Pass arbitrum-one or arbitrum-sepolia-testnet as chain.\n${sends(34, 5, "arbitrum-one")}`,
};
/** The instructions the Kleros testnet key answered on 10 November 2026, kept as received. */
const REAL_TESTNET_INSTRUCTIONS = (
  JSON.parse(
    readFileSync(new URL("../fixtures/kleros/instructions-testnet.json", import.meta.url), "utf8"),
  ) as { instructions: string }
).instructions;
const REAL_TESTNET_SENDS = sends(8, 5, "arbitrum-sepolia-testnet");

interface Seen {
  method: string;
  tool?: string;
  args?: Record<string, unknown>;
  authorization: string | null;
}

type Answer = (args: Record<string, unknown>) => Response | unknown;

/** The documented 200: one SSE frame carrying the JSON-RPC result. */
const frame = (id: unknown, result: unknown) =>
  new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
const toolResult = (payload: unknown) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
});
const refusal = (text: string) => ({ content: [{ type: "text", text }], isError: true });
const status = (code: number) =>
  new Response(JSON.stringify({ error: `status ${code}` }), {
    status: code,
    headers: { "content-type": "application/json" },
  });

/** A fetch that answers the service's three reads (and nothing else) and records every request. */
function klerosFetch(
  o: {
    tools?: string[];
    /** null: initialize answers a result without an instructions string. */
    instructions?: string | null;
    court?: Answer;
    every?: () => Response | undefined;
  } = {},
  deployment: KlerosDeploymentName = "testnet",
) {
  const seen: Seen[] = [];
  const fetchStub = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {
      id: unknown;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    const tool = body.method === "tools/call" ? body.params?.name : undefined;
    seen.push({
      method: body.method,
      tool,
      args: body.params?.arguments,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    const forced = o.every?.();
    if (forced) return forced;
    if (body.method === "initialize")
      return frame(
        body.id,
        o.instructions === null
          ? { protocolVersion: "2025-06-18", capabilities: {} }
          : {
              protocolVersion: "2025-06-18",
              instructions: o.instructions ?? INSTRUCTIONS[deployment],
            },
      );
    if (body.method === "tools/list")
      return frame(body.id, { tools: (o.tools ?? ALL_TOOLS).map((name) => ({ name })) });
    if (tool === "court_get") {
      const args = body.params?.arguments ?? {};
      const answer = o.court
        ? o.court(args)
        : toolResult({
            id: args.id,
            timesPerPeriod: ["900", "2700", "1800", "2700"],
            hiddenVotes: true,
          });
      return answer instanceof Response ? answer : frame(body.id, answer);
    }
    throw new Error(`the check sent ${body.method} ${tool ?? ""}: it reads only`);
  };
  return { fetch: fetchStub as typeof fetch, seen };
}

function httpStage(
  mode: KlerosDeploymentName,
  fetchImpl: typeof fetch,
  o: { courtId?: number } = {},
): KlerosStage {
  return {
    mode,
    service: new HttpDisputeService({
      apiUrl: API_URL,
      apiKey: mode === "testnet" ? TESTNET_KEY : LIVE_KEY,
      deployment: mode,
      fetch: fetchImpl,
      sleep: async () => {},
    }),
    deployment: deploymentFor(mode, o.courtId),
    cap: mode === "testnet" ? 10 : 5,
    flag: mode === "testnet" ? "--testnet" : "--live",
  };
}

function fakeStage(court?: Partial<CourtClock>): KlerosStage & { service: FakeDisputeService } {
  return {
    mode: "rehearsal",
    service: new FakeDisputeService({ script: "pay", court }),
    deployment: null,
    cap: null,
    flag: null,
  };
}

const writeCalls = (seen: Seen[]) =>
  seen.filter((s) => ["dispute_create", "evidence_pin", "evidence_submit"].includes(s.tool ?? ""));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the clean case", () => {
  test("a rehearsal: the fake lists the write tools, answers its own instructions and court 8's clock", async () => {
    const stage = fakeStage();
    const r = await checkKleros(stage);
    expect(r.problems).toEqual([]);
    expect(r.deployment).toBeNull();
    expect(r.tools).toEqual(
      expect.arrayContaining(["dispute_create", "evidence_pin", "evidence_submit"]),
    );
    expect(r.instructions).toBe(await new FakeDisputeService({ script: "pay" }).instructions());
    expect(r.court?.courtId).toBe(KLEROS_DEPLOYMENTS.testnet.courtId);
    expect(r.court?.timesPerPeriod).toEqual([900, 2700, 1800, 2700]);
    // Reads only, and the court read on the rehearsal's own chain.
    expect(stage.service.calls.map((c) => c.tool)).toEqual([
      "tools/list",
      "initialize",
      "court_get",
    ]);
    expect(stage.service.calls[2]?.args).toEqual({ chain: "fake", courtId: 8 });
  });

  test.each(["testnet", "live"] as const)(
    "%s: the stage's own chain and court are read, with the stage's key, and nothing else",
    async (mode) => {
      const { fetch, seen } = klerosFetch({}, mode);
      const r = await checkKleros(httpStage(mode, fetch));
      expect(r.problems).toEqual([]);
      expect(r.deployment).toEqual(deploymentFor(mode));
      expect(r.instructions).toBe(INSTRUCTIONS[mode]);
      expect(r.court?.courtId).toBe(KLEROS_DEPLOYMENTS[mode].courtId);
      expect(seen.map((s) => s.tool ?? s.method)).toEqual([
        "tools/list",
        "initialize",
        "court_get",
      ]);
      expect(seen[2]?.args).toEqual({
        chain: KLEROS_DEPLOYMENTS[mode].chain,
        id: String(KLEROS_DEPLOYMENTS[mode].courtId),
      });
      const key = mode === "testnet" ? TESTNET_KEY : LIVE_KEY;
      expect(new Set(seen.map((s) => s.authorization))).toEqual(new Set([`Bearer ${key}`]));
    },
  );

  test("the instructions the testnet key really answers pass, though their general text names every chain", async () => {
    expect(REAL_TESTNET_INSTRUCTIONS).toContain(REAL_TESTNET_SENDS);
    expect(REAL_TESTNET_INSTRUCTIONS).toMatch(/\barbitrum-one\b/);
    const { fetch } = klerosFetch({ instructions: REAL_TESTNET_INSTRUCTIONS });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toEqual([]);
    expect(r.instructions).toBe(REAL_TESTNET_INSTRUCTIONS);
  });

  test("the live key's instructions, worded as the testnet key's are, pass on the live stage", async () => {
    const live = REAL_TESTNET_INSTRUCTIONS.replace(
      REAL_TESTNET_SENDS,
      sends(34, 5, "arbitrum-one"),
    );
    const { fetch } = klerosFetch({ instructions: live }, "live");
    expect((await checkKleros(httpStage("live", fetch))).problems).toEqual([]);
  });

  test("the sentence is read with any spacing, a singular juror and no full stop", async () => {
    for (const text of [
      "this call sends them: court 8, 5 jurors, on arbitrum-sepolia-testnet",
      "This call sends them:   court 8 ,  5 jurors , on arbitrum-sepolia-testnet.\nMore text.",
    ]) {
      const { fetch } = klerosFetch({ instructions: text });
      expect((await checkKleros(httpStage("testnet", fetch))).problems).toEqual([]);
    }
    const { fetch } = klerosFetch({
      instructions: "this call sends them: court 8, 1 juror, on arbitrum-sepolia-testnet.",
    });
    expect((await checkKleros(httpStage("testnet", fetch))).problems).toEqual([
      expect.stringContaining("1 juror"),
    ]);
  });
});

describe("the problems", () => {
  test("a missing write tool is named", async () => {
    const { fetch } = klerosFetch({ tools: ["dispute_create", "dispute_get", "court_get"] });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain("evidence_pin");
    expect(r.problems[0]).toContain("evidence_submit");
    expect(r.problems[0]).not.toContain("dispute_create");
  });

  test("the testnet key's real instructions on the live stage: its chain and its court are both named", async () => {
    const { fetch } = klerosFetch({ instructions: REAL_TESTNET_INSTRUCTIONS }, "live");
    const r = await checkKleros(httpStage("live", fetch));
    expect(r.problems).toHaveLength(2);
    expect(r.problems[0]).toContain("arbitrum-sepolia-testnet");
    expect(r.problems[0]).toContain("arbitrum-one");
    expect(r.problems[1]).toContain("court 8");
    expect(r.problems[1]).toContain("court 34");
  });

  test.each([
    ["the other chain", sends(8, 5, "arbitrum-one"), "arbitrum-one"],
    ["another court", sends(34, 5, "arbitrum-sepolia-testnet"), "court 34"],
    ["another juror count", sends(8, 3, "arbitrum-sepolia-testnet"), "3 jurors"],
  ])("a testnet key whose sentence names %s is a problem", async (_what, text, named) => {
    const { fetch } = klerosFetch({ instructions: text });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toContain(named);
  });

  test("on a real deployment, instructions that never say what the filing sends are a problem", async () => {
    for (const text of [
      "This key files on arbitrum-sepolia-testnet, court 8, with 5 jurors.",
      REAL_TESTNET_INSTRUCTIONS.replace(REAL_TESTNET_SENDS, "The court is fixed for you."),
    ]) {
      const { fetch } = klerosFetch({ instructions: text });
      const r = await checkKleros(httpStage("testnet", fetch));
      expect(r.problems).toEqual([expect.stringContaining("this call sends them")]);
    }
  });

  test("two sentences that disagree are a problem, even when one matches the stage", async () => {
    const { fetch } = klerosFetch({
      instructions: `${sends(8, 5, "arbitrum-sepolia-testnet")}\n${sends(34, 5, "arbitrum-one")}`,
    });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toEqual([expect.stringContaining("more than once")]);
  });

  test("a court id overridden in config is the one the instructions must name", async () => {
    const { fetch, seen } = klerosFetch({ instructions: INSTRUCTIONS.testnet });
    const r = await checkKleros(httpStage("testnet", fetch, { courtId: 9 }));
    expect(r.problems).toEqual([expect.stringMatching(/court 8.*court 9|court 9.*court 8/)]);
    expect(seen.at(-1)?.args).toEqual({ chain: "arbitrum-sepolia-testnet", id: "9" });
  });

  test("on a real deployment, no instructions string is a problem", async () => {
    const { fetch } = klerosFetch({ instructions: null });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.instructions).toBeNull();
    expect(r.problems).toEqual([expect.stringContaining("instructions")]);
  });

  test("a court that does not answer is a problem", async () => {
    for (const court of [
      () => refusal("COURT_NOT_FOUND: no court 8 on this chain"),
      () => status(500),
      () => toolResult({ id: "8", hiddenVotes: true }),
    ]) {
      const { fetch } = klerosFetch({ court });
      const r = await checkKleros(httpStage("testnet", fetch));
      expect(r.court).toBeNull();
      expect(r.problems).toEqual([expect.stringContaining("court_get")]);
    }
  });

  test(`an evidence period under ${MIN_EVIDENCE_PERIOD_SECONDS} s is a problem, and ${MIN_EVIDENCE_PERIOD_SECONDS} s is not`, async () => {
    const under = await checkKleros(fakeStage({ timesPerPeriod: [299, 2700, 1800, 2700] }));
    expect(under.problems).toEqual([expect.stringContaining("299 s")]);
    const at = await checkKleros(fakeStage({ timesPerPeriod: [300, 2700, 1800, 2700] }));
    expect(at.problems).toEqual([]);
  });

  test("a problem carries the service's words with no em dash", async () => {
    const dash = String.fromCodePoint(0x2014);
    const { fetch } = klerosFetch({
      court: () => refusal(`COURT_NOT_FOUND: no court 8 ${dash} try another chain`),
    });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toEqual([expect.stringContaining("COURT_NOT_FOUND: no court 8")]);
    expect(r.problems.join("").includes(dash)).toBe(false);
  });

  test("a problem names a file, never its absolute path; an IPFS address stays whole", async () => {
    const { fetch } = klerosFetch({
      court: () =>
        refusal(
          "COURT_NOT_FOUND: see /var/lib/kleros/courts/8.json, or the policy /ipfs/bafypolicy",
        ),
    });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toEqual([
      expect.stringContaining("see 8.json, or the policy /ipfs/bafypolicy"),
    ]);
    expect(r.problems.join("")).not.toContain("/var/lib");
  });

  test("a rehearsal stage that does not hold the fake reads nothing", async () => {
    const { fetch, seen } = klerosFetch();
    const stage: KlerosStage = {
      ...httpStage("testnet", fetch),
      mode: "rehearsal",
      deployment: null,
    };
    const r = await checkKleros(stage);
    expect(r.problems).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  test("a rehearsal whose service answers other instructions than the fake's is a problem", async () => {
    class Impostor extends FakeDisputeService {
      override async instructions(): Promise<string | null> {
        return "arbitrum-sepolia-testnet, court 8";
      }
    }
    const stage: KlerosStage = { ...fakeStage(), service: new Impostor({ script: "pay" }) };
    expect((await checkKleros(stage)).problems).toEqual([expect.stringContaining("fake")]);
  });

  test("a refused key is one problem, named without the key", async () => {
    const { fetch } = klerosFetch({ every: () => status(401) });
    const r = await checkKleros(httpStage("testnet", fetch));
    expect(r.problems).toContain(UNAUTHORIZED_PROBLEM);
    expect(r.problems.filter((p) => p === UNAUTHORIZED_PROBLEM)).toHaveLength(1);
    const printed = JSON.stringify(r);
    expect(printed).not.toContain(TESTNET_KEY);
    expect(printed).not.toContain(LIVE_KEY);
  });
});

describe("the real-reads client of a rehearsal", () => {
  function rehearsalCfg(): Config {
    const kleros: KlerosConfig = {
      apiKeyTestnet: TESTNET_KEY,
      apiKeyLive: LIVE_KEY,
      apiUrl: API_URL,
      courtIdTestnet: 8,
      courtIdLive: 34,
      aliasClient: "client",
      aliasProvider: "provider",
      expectedOptions: {},
      policyUri: "/ipfs/test-policy",
    };
    return {
      pilot: {
        buyerPrivateKey: generatePrivateKey(),
        sellerPrivateKey: generatePrivateKey(),
        refereePrivateKey: generatePrivateKey(),
        mode: "rehearsal",
        testnetCasesCap: 10,
        liveCasesCap: 5,
        lookupBase: "https://api.example.com",
      },
      kleros,
    } as unknown as Config;
  }

  test.each(["testnet", "live"] as const)(
    "%s: the check reads the named deployment, and its writes throw before any fetch",
    async (name) => {
      const { fetch, seen } = klerosFetch({}, name);
      vi.stubGlobal("fetch", fetch);
      const stage = buildKlerosService(rehearsalCfg(), { realReads: name });
      const r = await checkKleros(stage);
      expect(r.problems).toEqual([]);
      expect(r.deployment?.chain).toBe(KLEROS_DEPLOYMENTS[name].chain);
      expect(seen).toHaveLength(3);

      const before = seen.length;
      const client = "0x1111111111111111111111111111111111111111" as Address;
      await expect(
        stage.service.pin({ bytes: new Uint8Array([1]), extension: "csv" }),
      ).rejects.toThrow(/nothing was sent/);
      await expect(stage.service.createDispute({ aliases: { client } })).rejects.toThrow(
        /nothing was sent/,
      );
      await expect(
        stage.service.submitEvidence({ coreDisputeId: "1", name: "n", description: "d" }),
      ).rejects.toThrow(/nothing was sent/);
      expect(seen).toHaveLength(before);
      expect(writeCalls(seen)).toEqual([]);
    },
  );
});
