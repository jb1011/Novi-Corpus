/**
 * The pilot's rehearsal from the first command to the last, on anvil, through each command's own
 * wiring: `pilot:job --yes`, `pilot:contest`, `pilot:dispute --script refund --yes`,
 * `pilot:poll --watch --script refund` and `pilot:settle --yes`. Every command opens its own
 * context over the same SQLite file, as separate processes would; the chain is the real
 * `buildPilotChain` over anvil's clients, the Kleros side is the scripted fake, and only the two
 * lookups are answered by a stubbed fetch. The watch's sleep is skipped so the four reads of the
 * script take no wall time.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import {
  http,
  type Address,
  type PublicClient,
  type WalletClient,
  createPublicClient,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  pad,
  parseEventLogs,
} from "viem";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { mockErc8183JobAbi, mockIdentityRegistryAbi } from "../../src/abis/generated";
import { anvilChain } from "../../src/chains";
import { registerPilotCommands } from "../../src/cli/pilot";
import { registerPilotSettlementCommands } from "../../src/cli/pilotSettlement";
import type { Config } from "../../src/config/env";
import { migrate, openDatabase } from "../../src/persistence/db";
import { FileDocumentStore } from "../../src/persistence/documentStore";
import { SqlitePilotCaseRepository } from "../../src/pilot/casesRepository";
import type { PilotContext } from "../../src/pilot/context";
import { jobSubmittedEventAbi } from "../../src/pilot/jobEvents";
import { reasonFor } from "../../src/pilot/settlement";
import { type MockJobEnv, deployMockJob } from "../helpers/anvilJob";
import { loadArtifact } from "../helpers/artifacts";
import { answerFor } from "../helpers/pilotCaseFixtures";

const LOOKUP_BASE = "https://lookup.example.com";
const BUDGET = 2_000_000n;

let env: MockJobEnv;
let registry: Address;
const agentIds = { buyer: "", seller: "" };

async function deployRegistry(wallet: WalletClient, pub: PublicClient): Promise<Address> {
  const { abi, bytecode } = loadArtifact("MockIdentityRegistry");
  const hash = await wallet.deployContract({
    abi,
    bytecode,
    args: [],
    account: wallet.account!,
    chain: wallet.chain,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (!receipt.contractAddress) throw new Error("MockIdentityRegistry deploy produced no address");
  return getAddress(receipt.contractAddress);
}

async function register(wallet: WalletClient): Promise<string> {
  const { request, result } = await env.publicClient.simulateContract({
    address: registry,
    abi: mockIdentityRegistryAbi,
    functionName: "register",
    args: [""],
    account: wallet.account!,
  });
  const hash = await wallet.writeContract(request);
  await env.publicClient.waitForTransactionReceipt({ hash });
  return result.toString();
}

beforeAll(async () => {
  env = await deployMockJob();
  registry = await deployRegistry(env.clientWallet, env.publicClient);
  agentIds.buyer = await register(env.clientWallet);
  agentIds.seller = await register(env.providerWallet);
  await env.mintUsdc(env.clientAddr, 5_000_000n);
});

afterAll(() => env?.stop());
afterEach(() => vi.unstubAllGlobals());

/** The two lookups answer an active legal body; anything else reaches the real fetch. */
function stubLookups(): void {
  const realFetch = globalThis.fetch;
  const names: Record<string, string> = {
    [agentIds.buyer]: "Buyer Agent DAO LLC",
    [agentIds.seller]: "Seller Agent DAO LLC",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url instanceof Request ? url.url : url);
      if (!href.startsWith(`${LOOKUP_BASE}/`)) return realFetch(url, init);
      const id = href.split("/").at(-1) as string;
      return new Response(JSON.stringify(answerFor(id, names[id] as string)), { status: 200 });
    }),
  );
}

/**
 * The local mock job contract emits `Submitted(jobId, deliverable)`, while the filing reads the
 * deployed contract's `JobSubmitted(jobId, provider, deliverable)` from the submit's receipt.
 * This client is anvil's with one addition: a receipt that holds the mock's event also holds the
 * deployed contract's event for the same job and file, so the filing's receipt check runs for real.
 */
function withDeployedSubmittedEvent(client: PublicClient): PublicClient {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop !== "getTransactionReceipt") return Reflect.get(target, prop, receiver);
      return async (args: { hash: `0x${string}` }) => {
        const receipt = await target.getTransactionReceipt(args);
        const [mock] = parseEventLogs({
          abi: mockErc8183JobAbi,
          eventName: "Submitted",
          logs: receipt.logs,
        });
        if (!mock) return receipt;
        const deployed = {
          ...mock,
          topics: encodeEventTopics({
            abi: jobSubmittedEventAbi,
            eventName: "JobSubmitted",
            args: { jobId: mock.args.jobId, provider: receipt.from },
          }),
          data: encodeAbiParameters([{ type: "bytes32" }], [pad(mock.args.deliverable)]),
        };
        return { ...receipt, logs: [...receipt.logs, deployed] };
      };
    },
  });
}

/** The fields of a command's output that this test reads. */
interface Printed {
  case?: { caseId: string; status: string };
  status?: string;
  txHash?: `0x${string}`;
  [field: string]: unknown;
}

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pilot-rehearsal-int-"));
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

test("a rehearsal runs from the job to the refund through the commands, and sends one settlement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pilot-rehearsal-int-db-"));
  const cfg = {
    chainId: anvilChain.id,
    usdc: env.usdcAddr,
    jobContract: env.jobAddr,
    identityRegistry: registry,
    arcExplorerUrl: "https://explorer.example.com",
    maxJobBudget: 10_000_000n,
    pilot: {
      mode: "rehearsal",
      testnetCasesCap: 10,
      liveCasesCap: 5,
      lookupBase: LOOKUP_BASE,
      buyerAgentId: agentIds.buyer,
      sellerAgentId: agentIds.seller,
    },
  } as unknown as Config;
  const open = (): PilotContext => {
    const db = openDatabase(join(dir, "pilot.db"));
    migrate(db);
    return {
      cfg,
      db,
      cases: new SqlitePilotCaseRepository(db),
      docStore: new FileDocumentStore(join(dir, "docs")),
      publicClient: withDeployedSubmittedEvent(env.publicClient),
      sendClient: createPublicClient({ chain: anvilChain, transport: http(env.rpcUrl) }),
      wallets: {
        buyer: env.clientWallet,
        seller: env.providerWallet,
        referee: env.evaluatorWallet,
      },
      addresses: { buyer: env.clientAddr, seller: env.providerAddr, referee: env.evaluatorAddr },
      close: () => db.close(),
    } as PilotContext;
  };

  /** One command line through its own wiring; returns every JSON object it printed. */
  const run = async (settlement: boolean, argv: string[]): Promise<Printed[]> => {
    const program = new Command();
    program.exitOverride();
    if (settlement) registerPilotSettlementCommands(program, { open, sleep: async () => {} });
    else registerPilotCommands(program, open, { readConfig: () => cfg });
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m) => logs.push(String(m)));
    try {
      await program.parseAsync(["node", "cli", ...argv]);
    } finally {
      spy.mockRestore();
    }
    return logs.map((l) => JSON.parse(l) as Printed);
  };

  stubLookups();
  const before = await env.usdcBalanceOf(env.clientAddr);
  const refereeTxsBefore = await env.publicClient.getTransactionCount({
    address: env.evaluatorAddr,
  });

  const [job] = await run(false, [
    "pilot:job",
    "--label",
    "test case 1",
    "--description-file",
    tempFile("description.txt", "Monthly expense report as a CSV\n"),
    "--deliverable",
    tempFile("deliverable.csv", "date,amount\n2026-10-01,12.50\n"),
    "--yes",
  ]);
  const caseId = job!.case!.caseId;
  expect(job!.case!.status).toBe("submitted");
  expect(await env.usdcBalanceOf(env.clientAddr)).toBe(before - BUDGET);

  const [contested] = await run(false, [
    "pilot:contest",
    "--case",
    caseId,
    "--reason-file",
    tempFile("reason.txt", "The report is missing the last week.\n"),
    "--yes",
  ]);
  expect(contested!.case!.status).toBe("contested");

  const filed = await run(false, [
    "pilot:dispute",
    "--case",
    caseId,
    "--script",
    "refund",
    "--yes",
  ]);
  expect(filed.some((o) => o.case?.status === "filed")).toBe(true);

  const watched = await run(true, [
    "pilot:poll",
    "--case",
    caseId,
    "--watch",
    "--max-minutes",
    "5",
    "--script",
    "refund",
  ]);
  expect(watched.at(-1)).toMatchObject({
    stop: "outcome",
    outcome: { kind: "refund" },
    status: "ruled",
  });

  const settled = await run(true, ["pilot:settle", "--case", caseId, "--yes"]);
  const result = settled.find((o) => o.status === "settled")!;
  expect(result).toMatchObject({ status: "settled", settlement: { action: "reject" } });

  // The client has its money back, and the referee sent one transaction in the whole run.
  expect(await env.usdcBalanceOf(env.clientAddr)).toBe(before);
  expect(await env.publicClient.getTransactionCount({ address: env.evaluatorAddr })).toBe(
    refereeTxsBefore + 1,
  );
  const receipt = await env.publicClient.getTransactionReceipt({ hash: result.txHash! });
  expect(receipt).toMatchObject({ status: "success", to: env.jobAddr.toLowerCase() });
  const db = open();
  try {
    const row = db.cases.find(caseId)!;
    expect(row).toMatchObject({
      status: "settled",
      escrowOutcome: "refunded",
      settleAction: "reject",
      settleTxHash: result.txHash,
      settleReason: reasonFor(row.coreDisputeId!),
    });
  } finally {
    db.close();
  }
}, 120_000);
