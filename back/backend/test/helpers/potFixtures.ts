import { type Address, type Hex, getAddress, keccak256, toHex, zeroAddress } from "viem";
import { type Mock, vi } from "vitest";
import type { SafePotChainPort } from "../../src/adapters/arc/safePotChain";
import type { GrantChoices } from "../../src/legalBody/grant";
import { createOrder } from "../../src/legalBody/orders";
import type { LegalBodyPotDeps } from "../../src/legalBody/pot";
import {
  POT_PERIOD_MINUTES,
  potAddresses,
  potInitializer,
  predictPotAddress,
} from "../../src/legalBody/safePot";
import { CHARTER_LEGAL_TEXTS, octoberLegalTexts } from "../../src/legalBody/texts/sets";
import { SqliteLegalBodyPotRepository } from "../../src/persistence/legalBodyPotRepository";
import type { LegalBodyRecord } from "../../src/persistence/legalBodyRepository";
import { ACTION, recordHuman } from "./customerCompanyFixtures";
import { type LegalBodyStores, customerCompany, legalBodyOrderDeps } from "./legalBodyFixtures";

/**
 * The fixtures the tests of the company's pot share: the real run's guardian, agent and payee, the
 * pot V3 of the pinned vectors, a linked body of a guardian whose agreement is stored (so its grant
 * reads back), a fake registry and a fake chain port that record their calls, and the pot's deps
 * over all of them.
 *
 * G, A and P are the addresses of the real run on Arc testnet of 24 Nov: public addresses, never a
 * key. Every other address is a placeholder, every name and filing number an invention.
 */

/** The real run's guardian. */
export const G: Address = "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A";
/** The real run's agent key. */
export const A: Address = "0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C";
/** The real run's payee, also the "new key" of V12 and V13. */
export const P: Address = "0xE886e729CC5C43bE28642827C4e72e660A83C7E8";

/** Arc testnet: the pot's table is the same on mainnet. */
export const POT_CHAIN_ID = 5_042_002;

/** V3: the pot of guardian G, agent A, USDC, a ceiling of 50 USDC and the real period, salt 1. */
export const V3_ADDRESS: Address = "0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D";
/** The body the pot door takes for V3, the declaration ticked. */
export const V3_INPUT = {
  address: V3_ADDRESS,
  saltNonce: "1",
  ceilingUnits: "50000000",
  agentWallet: A,
  declarationVersion: "pot-declaration-1",
} as const;

/** The address a pot of `guardian`, `agentWallet` and `ceilingUnits` would have with `saltNonce`,
 *  by the server's own prediction (V3 pins it against the vectors). */
export function potAddressOf(p: {
  guardian?: Address;
  agentWallet?: Address;
  ceilingUnits: bigint;
  saltNonce?: bigint;
}): Address {
  const table = potAddresses(POT_CHAIN_ID);
  if (table === null) throw new Error("no pot table for the test chain");
  return predictPotAddress(
    table,
    potInitializer(table, {
      guardian: p.guardian ?? G,
      agentWallet: p.agentWallet ?? A,
      token: table.usdc,
      ceilingUnits: p.ceilingUnits,
      periodMinutes: POT_PERIOD_MINUTES,
    }),
    p.saltNonce ?? 1n,
  );
}

/** The pot door's body for a ceiling in whole USDC, its address recomputed to match. */
export function inputFor(ceilingUsdc: bigint, saltNonce = 1n): Record<string, string> {
  const ceilingUnits = ceilingUsdc * 1_000_000n;
  return {
    address: potAddressOf({ ceilingUnits, saltNonce }),
    saltNonce: saltNonce.toString(),
    ceilingUnits: ceilingUnits.toString(),
    agentWallet: A,
    declarationVersion: "pot-declaration-1",
  };
}

/** Choices that allow providing services only: no buying, no paying, no engaging contractors. */
export const NO_SPENDING: GrantChoices = {
  acts: {
    provideServices: { allowed: true, perAct: 100, above: "not_allowed" },
    acceptEngagement: { allowed: false },
    issueInvoice: { allowed: false },
    receivePayment: { allowed: false },
    buy: { allowed: false },
    pay: { allowed: false },
    engageContractor: { allowed: false },
  },
  heavyActs: {
    employ: { mode: "not_allowed" },
    borrow: { mode: "not_allowed" },
    guarantee: { mode: "not_allowed" },
    transferProperty: { mode: "not_allowed" },
  },
  counterparties: "anyone",
  endsOn: null,
};

/** Bodies made by this module, so each gets its own agent, company, digest and body. */
let made = 0;

/**
 * A body of `tenant` (G unless told otherwise) placed through the order door's own domain function,
 * so its agreement is stored and reads back, then brought to `state` (linked unless told otherwise)
 * through the repository's own moves, for an agent of its own. On the October agreement, which
 * takes no grant, unless `grant` is given: then on the Charter, with that grant.
 */
export function potBody(
  s: LegalBodyStores,
  o: { tenant?: Address; grant?: GrantChoices; state?: "linked" | "deployed"; nowMs?: number } = {},
): LegalBodyRecord {
  made += 1;
  const n = made;
  const tenant = o.tenant ?? G;
  const nowMs = o.nowMs ?? Date.now();
  if (s.store.findByTenant(tenant, ACTION) === undefined)
    recordHuman(s.store, tenant, `nullifier-pot-${tenant.toLowerCase()}`, nowMs - 60_000);
  const charter = o.grant !== undefined;
  const companyId = customerCompany(s, tenant, {
    filingNumber: `TEST-P${String(n).padStart(4, "0")}`,
    ...(charter ? { wordingVersion: "2026-11-draft-2" } : {}),
  });
  const orders = legalBodyOrderDeps(s, {
    texts: charter ? CHARTER_LEGAL_TEXTS : octoberLegalTexts(),
    now: () => nowMs,
  });
  const view = createOrder(orders, tenant, {
    companyId,
    ...(charter ? { grant: o.grant } : {}),
  });
  const id = view.id;
  const reserved = s.repo.reserve(id, {
    agentId: String(7_000 + n),
    identityOwner: getAddress("0x00000000000000000000000000000000000a0001"),
    linkDigest: keccak256(toHex(`pot-link:${n}`)),
    linkDeadline: 1_900_000_000,
    linkSignature: "0x01",
    bodyAddress: getAddress(`0x${(0xb07000 + n).toString(16).padStart(40, "0")}`),
    observedAtBlock: 1,
    firstCheckAt: nowMs,
  });
  if (reserved !== "reserved") throw new Error(`potBody: reserve gave ${reserved}`);
  if (
    !s.repo.markDeployed(id, {
      txHash: keccak256(toHex(`pot-create:${n}`)),
      deployedAt: 1_790_000_000 + n,
    })
  )
    throw new Error("potBody: markDeployed was not made");
  if (o.state !== "deployed" && s.repo.markLinked(id, 1_791_000_000 + n).outcome !== "linked")
    throw new Error("potBody: markLinked was not made");
  const row = s.repo.findById(id);
  if (row === undefined) throw new Error("potBody: the row vanished");
  return row;
}

/** A registry that answers `wallets` by agent id (none: the zero address), and records reads. */
export function fakeRegistry(): {
  wallets: Map<string, Address>;
  getAgentWallet: Mock<(agentId: bigint) => Promise<Address>>;
} {
  const wallets = new Map<string, Address>();
  const getAgentWallet = vi.fn(
    async (agentId: bigint) => wallets.get(agentId.toString()) ?? zeroAddress,
  );
  return { wallets, getAgentWallet };
}

/** A chain port whose code reads answer `codes` (lower-case address -> its code hash; absent: no
 *  code), and whose pot reads throw: the note door never reads a pot. */
export function fakePotChain(): {
  codes: Map<string, Hex>;
  port: SafePotChainPort & {
    codeHash: Mock<(address: Address) => Promise<Hex | null>>;
    readPot: Mock<SafePotChainPort["readPot"]>;
  };
} {
  const codes = new Map<string, Hex>();
  return {
    codes,
    port: {
      codeHash: vi.fn(async (address: Address) => codes.get(address.toLowerCase()) ?? null),
      readPot: vi.fn<SafePotChainPort["readPot"]>(async () => {
        throw new Error("the note door read a pot");
      }),
    },
  };
}

/** A code hash for a fake chain: any 32 bytes stand for "holds code". */
export const SOME_CODE: Hex = `0x${"d7".repeat(32)}`;

/** The pot's deps over the stores, the registry and the chain port given, on `POT_CHAIN_ID`. */
export function potDeps(
  s: LegalBodyStores,
  o: {
    registry: LegalBodyPotDeps["registry"];
    chain: SafePotChainPort;
    now: () => number;
    offered?: () => boolean;
    chainId?: number;
  },
): LegalBodyPotDeps {
  return {
    repo: new SqliteLegalBodyPotRepository(s.db),
    registry: o.registry,
    bodies: s.repo,
    chain: o.chain,
    chainId: o.chainId ?? POT_CHAIN_ID,
    now: o.now,
    grants: s.grants,
    docStore: s.docStore,
    offered: o.offered ?? (() => true),
  };
}
