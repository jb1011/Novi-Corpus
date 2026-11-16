import {
  type Abi,
  type Address,
  BaseError,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  type Hex,
  type PublicClient,
  concatHex,
  getAbiItem,
  getContractAddress,
  isAddressEqual,
  pad,
  toFunctionSelector,
  zeroAddress,
  zeroHash,
} from "viem";
import {
  agentTreasuryAbi,
  iIdentityRegistryAbi,
  legalBodyFactoryAbi,
  legalManagerAbi,
  legalManagerFactoryAbi,
  noviControllerAbi,
} from "../../abis/generated";
import type { LegalBodyContractFacts } from "../../legalBody/texts/sets";

/**
 * Boot-time verification that the CHAIN agrees with the env (NoviController design §5/§7).
 *
 * `loadConfig` stays pure — it can only check that the env vars are internally consistent, which
 * catches a missing variable and nothing else. The mistakes that actually hurt are relational and
 * live on-chain: pointing at a factory the controller does not own, flipping the factory but
 * forgetting the controller, a deploy whose `acceptOwnership` ceremony never completed, an executor
 * key rotated without re-granting, a pin that was never set. Every one of those boots green today
 * and fails at the FIRST ONBOARDING, in front of a user, as an opaque `OwnableUnauthorizedAccount`
 * or `NotManager`. These checks move that to the boot log, named.
 *
 * Chain I/O belongs here (api/main.ts already has a PublicClient), not in loadConfig.
 */

/** One entry of the executor's standing grant set, with the name a human can check it by. */
export interface GrantedSelector {
  /** `Contract.function` as the deploy script logs it. */
  readonly name: string;
  readonly selector: Hex;
}

function selectorOf(abi: unknown, contract: string, name: string): Hex {
  const item = getAbiItem({ abi: abi as Abi, name });
  if (!item || item.type !== "function")
    throw new Error(`bootVerify: ${contract}.${name} is not a function in the generated ABI`);
  return toFunctionSelector(item);
}

/**
 * The seven selectors granted to the executor at deploy — DERIVED from the same generated ABIs the
 * adapter encodes calls with, never hardcoded hex. This is the TypeScript mirror of
 * `src/libraries/ControllerSelectors.sol`, which the deploy script and the Foundry suites share; a
 * signature change moves both sides together, and bootVerify.test.ts pins the set to exactly these
 * seven so a silent addition on either side is caught.
 */
export const CONTROLLER_GRANTED_SELECTORS: readonly GrantedSelector[] = [
  {
    name: "AgentTreasury.schedulePolicyUpdate",
    selector: selectorOf(agentTreasuryAbi, "AgentTreasury", "schedulePolicyUpdate"),
  },
  {
    name: "AgentTreasury.executePolicyUpdate",
    selector: selectorOf(agentTreasuryAbi, "AgentTreasury", "executePolicyUpdate"),
  },
  {
    name: "LegalManager.scheduleOperatingAgreementUpdate",
    selector: selectorOf(legalManagerAbi, "LegalManager", "scheduleOperatingAgreementUpdate"),
  },
  {
    name: "LegalManager.executeOperatingAgreementUpdate",
    selector: selectorOf(legalManagerAbi, "LegalManager", "executeOperatingAgreementUpdate"),
  },
  {
    name: "LegalManagerFactory.createEntity",
    selector: selectorOf(legalManagerFactoryAbi, "LegalManagerFactory", "createEntity"),
  },
  {
    name: "IdentityRegistry.setAgentWallet",
    selector: selectorOf(iIdentityRegistryAbi, "IIdentityRegistry", "setAgentWallet"),
  },
  {
    name: "IdentityRegistry.setMetadata",
    selector: selectorOf(iIdentityRegistryAbi, "IIdentityRegistry", "setMetadata"),
  },
] as const;

/** The two selectors M5 pins to the identity registry (design §3). */
export const CONTROLLER_PINNED_SELECTORS: readonly GrantedSelector[] =
  CONTROLLER_GRANTED_SELECTORS.filter((s) => s.name.startsWith("IdentityRegistry."));

/**
 * The executor's two grants on the legal-body factory: create a body with the identity owner's
 * signature, and schedule an amendment the body's guardian signed. Derived from the generated ABI,
 * never hardcoded. When the factory is configured, boot refuses to start unless both are pinned to
 * the factory (setBoundTarget) and granted to the executor.
 */
export const LEGAL_BODY_GRANTED_SELECTORS: readonly GrantedSelector[] = [
  {
    name: "LegalBodyFactory.createLegalBody",
    selector: selectorOf(legalBodyFactoryAbi, "LegalBodyFactory", "createLegalBody"),
  },
  {
    name: "LegalBodyFactory.scheduleOperatingAgreementUpdate",
    selector: selectorOf(
      legalBodyFactoryAbi,
      "LegalBodyFactory",
      "scheduleOperatingAgreementUpdate",
    ),
  },
] as const;

/**
 * `role id = bytes32(bytes4 selector)` — the selector LEFT-aligned in a bytes32 (the Euler shape
 * the controller uses). Right-padding is what makes the selector namespace disjoint from
 * DEFAULT_ADMIN_ROLE (0x00) and from the right-aligned WILDCARD_ROLE.
 */
export function selectorRole(selector: Hex): Hex {
  return pad(selector, { dir: "right", size: 32 });
}

/** Anything that failed to READ is a verification outage, not a misconfiguration. */
export function unreadable(what: string, err: unknown): Error {
  return new Error(
    `boot: could not verify ${what} on-chain (RPC read failed against ARC_TESTNET_RPC_URL) — the deployment may be fine, but it cannot be confirmed; fix connectivity and restart`,
    { cause: err },
  );
}

/**
 * Tell "the contract refused the read" apart from "the read never got there". A call that comes
 * back empty (no code at the address) or reverted (a contract with no such function) was answered
 * by the chain: the ADDRESS is wrong, and telling the operator to fix connectivity sends them the
 * wrong way. Returns which address refused and how, or undefined for anything else (a transport
 * failure, a timeout), which stays a verification outage.
 */
function contractRefusal(err: unknown): { address?: Address; reason: string } | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const refused = err.walk(
    (e) => e instanceof ContractFunctionZeroDataError || e instanceof ContractFunctionRevertedError,
  );
  if (!(refused instanceof BaseError)) return undefined;
  const call = err.walk((e) => e instanceof ContractFunctionExecutionError);
  return {
    address: call instanceof ContractFunctionExecutionError ? call.contractAddress : undefined,
    // One line: a revert with an unknown error carries its signature on a second line.
    reason: refused.shortMessage.replace(/\s+/g, " "),
  };
}

/**
 * Controller mode: prove the factory is the controller's, the executor still holds all seven
 * grants, and the M5 registry pins are in place. Throws naming the failing check and the env vars
 * that produced it.
 */
export async function assertControllerWiring(
  publicClient: PublicClient,
  p: { controller: Address; factory: Address; identityRegistry: Address; executor: Address },
): Promise<void> {
  let factoryOwner: Address;
  let grants: readonly boolean[];
  let pins: readonly Address[];
  try {
    [factoryOwner, grants, pins] = await Promise.all([
      publicClient.readContract({
        address: p.factory,
        abi: legalManagerFactoryAbi,
        functionName: "owner",
      }) as Promise<Address>,
      Promise.all(
        CONTROLLER_GRANTED_SELECTORS.map(
          (s) =>
            publicClient.readContract({
              address: p.controller,
              abi: noviControllerAbi,
              functionName: "hasRole",
              args: [selectorRole(s.selector), p.executor],
            }) as Promise<boolean>,
        ),
      ),
      Promise.all(
        CONTROLLER_PINNED_SELECTORS.map(
          (s) =>
            publicClient.readContract({
              address: p.controller,
              abi: noviControllerAbi,
              functionName: "boundTarget",
              args: [s.selector],
            }) as Promise<Address>,
        ),
      ),
    ]);
  } catch (err) {
    throw unreadable(
      `the controller wiring (controller ${p.controller}, factory ${p.factory})`,
      err,
    );
  }

  // 1. The factory must be the one the controller owns, or every relayed createEntity reverts
  //    OwnableUnauthorizedAccount. Also catches a deploy whose acceptOwnership never completed.
  if (!isAddressEqual(factoryOwner, p.controller))
    throw new Error(
      `boot: FACTORY_ADDRESS ${p.factory} is owned by ${factoryOwner}, not by CONTROLLER_ADDRESS ${p.controller} — this is not the controller's factory (or the acceptOwnership ceremony has not completed; the controller must ACCEPT the two-step transfer before it can create entities)`,
    );

  // 2. Every standing grant, by name: a rotated executor key, or a revoke-sweep that went too far,
  //    otherwise surfaces as NotAuthorized on whichever onboarding step needs the missing one.
  const missing = CONTROLLER_GRANTED_SELECTORS.filter((_, i) => !grants[i]);
  if (missing.length > 0)
    throw new Error(
      `boot: executor ${p.executor} (the address of PLATFORM_PRIVATE_KEY) is missing ${missing.length} of ${CONTROLLER_GRANTED_SELECTORS.length} selector grants on CONTROLLER_ADDRESS ${p.controller}: ${missing
        .map((s) => `${s.name} (${s.selector})`)
        .join(
          ", ",
        )} — grant them from the controller admin, or check that PLATFORM_PRIVATE_KEY is the key the deploy granted`,
    );

  // 3. M5 pins. An unpinned registry selector is relayable at ANY contract, which is the exact
  //    third-party-upgradeable-proxy risk the pin exists to bound.
  const badPins = CONTROLLER_PINNED_SELECTORS.map((s, i) => ({ s, actual: pins[i] })).filter(
    ({ actual }) => !actual || !isAddressEqual(actual, p.identityRegistry),
  );
  if (badPins.length > 0)
    throw new Error(
      `boot: M5 target pins on CONTROLLER_ADDRESS ${p.controller} do not point at IDENTITY_REGISTRY ${p.identityRegistry}: ${badPins
        .map(({ s, actual }) => `${s.name} -> ${actual}`)
        .join(
          ", ",
        )} — an unpinned registry selector may be relayed at any contract; set it via controller.setBoundTarget from the admin`,
    );
}

/**
 * Minimal-only mode (a controller with no FACTORY_ADDRESS): prove the controller carries none of
 * the full product's standing authority. The executor must hold none of the seven full-product
 * grants and neither registry selector may be pinned. A controller that still has them is a
 * full-product controller, and pointing a Minimal-only deployment at it would leave live grants
 * this box neither uses nor watches. Throws naming every offending selector.
 */
export async function assertNoFullProductGrants(
  publicClient: PublicClient,
  p: { controller: Address; executor: Address },
): Promise<void> {
  let grants: readonly boolean[];
  let pins: readonly Address[];
  try {
    [grants, pins] = await Promise.all([
      Promise.all(
        CONTROLLER_GRANTED_SELECTORS.map(
          (s) =>
            publicClient.readContract({
              address: p.controller,
              abi: noviControllerAbi,
              functionName: "hasRole",
              args: [selectorRole(s.selector), p.executor],
            }) as Promise<boolean>,
        ),
      ),
      Promise.all(
        CONTROLLER_PINNED_SELECTORS.map(
          (s) =>
            publicClient.readContract({
              address: p.controller,
              abi: noviControllerAbi,
              functionName: "boundTarget",
              args: [s.selector],
            }) as Promise<Address>,
        ),
      ),
    ]);
  } catch (err) {
    throw unreadable(`the absence of full-product grants (controller ${p.controller})`, err);
  }

  const held = CONTROLLER_GRANTED_SELECTORS.filter((_, i) => grants[i] !== false);
  const pinned = CONTROLLER_PINNED_SELECTORS.map((s, i) => ({ s, actual: pins[i] })).filter(
    ({ actual }) => !actual || !isAddressEqual(actual, zeroAddress),
  );
  if (held.length === 0 && pinned.length === 0) return;
  const parts: string[] = [];
  if (held.length > 0)
    parts.push(
      `executor ${p.executor} (the address of PLATFORM_PRIVATE_KEY) holds ${held.map((s) => `${s.name} (${s.selector})`).join(", ")}`,
    );
  if (pinned.length > 0)
    parts.push(`${pinned.map(({ s, actual }) => `${s.name} is pinned to ${actual}`).join(", ")}`);
  throw new Error(
    `boot: CONTROLLER_ADDRESS ${p.controller} carries full-product authority while FACTORY_ADDRESS is unset: ${parts.join("; ")} — this deployment is pointed at a full-product controller; deploy a Minimal-only controller, or set FACTORY_ADDRESS to run the full product`,
  );
}

/**
 * The typed-data domain the legal-body factory signs under (its name and version are fixed in the
 * contract's constructor). Link and amendment signatures are built against exactly this domain.
 */
export const LEGAL_BODY_FACTORY_DOMAIN = { name: "Novi LegalBodyFactory", version: "1" } as const;

/**
 * Legal-body mode: prove the factory belongs to the controller with no handover pending, reads the
 * configured identity registry, signs under the expected typed-data domain on the configured chain,
 * and that both executor grants exist and are pinned to it. Every mismatch otherwise surfaces at a
 * customer's first order as an opaque relay revert.
 *
 * Why the domain and the chain id: every legal-body record stores its chain id, write-once, and
 * every link signature is bound to this domain (name, version, chain id, the factory's address).
 * The factory reports the chain it actually runs on, so a chain id in the config that is not the
 * chain behind the RPC is caught here. Left unchecked, it would surface at a customer's first
 * order as a bad signature, after records carrying the wrong chain id had already been written.
 */
export async function assertLegalBodyFactoryWiring(
  publicClient: PublicClient,
  p: {
    factory: Address;
    controller: Address;
    identityRegistry: Address;
    executor: Address;
    /** The configured chain id (ARC_CHAIN_ID). */
    chainId: number;
  },
): Promise<void> {
  let owner: Address;
  let pendingOwner: Address;
  let registry: Address;
  // eip712Domain() returns (fields, name, version, chainId, verifyingContract, salt, extensions).
  let domain: readonly [Hex, string, string, bigint, Address, Hex, readonly bigint[]];
  let pins: readonly Address[];
  let grants: readonly boolean[];
  try {
    [owner, pendingOwner, registry, domain, pins, grants] = await Promise.all([
      publicClient.readContract({
        address: p.factory,
        abi: legalBodyFactoryAbi,
        functionName: "owner",
      }) as Promise<Address>,
      publicClient.readContract({
        address: p.factory,
        abi: legalBodyFactoryAbi,
        functionName: "pendingOwner",
      }) as Promise<Address>,
      publicClient.readContract({
        address: p.factory,
        abi: legalBodyFactoryAbi,
        functionName: "identityRegistry",
      }) as Promise<Address>,
      publicClient.readContract({
        address: p.factory,
        abi: legalBodyFactoryAbi,
        functionName: "eip712Domain",
      }) as Promise<typeof domain>,
      Promise.all(
        LEGAL_BODY_GRANTED_SELECTORS.map(
          (s) =>
            publicClient.readContract({
              address: p.controller,
              abi: noviControllerAbi,
              functionName: "boundTarget",
              args: [s.selector],
            }) as Promise<Address>,
        ),
      ),
      Promise.all(
        LEGAL_BODY_GRANTED_SELECTORS.map(
          (s) =>
            publicClient.readContract({
              address: p.controller,
              abi: noviControllerAbi,
              functionName: "hasRole",
              args: [selectorRole(s.selector), p.executor],
            }) as Promise<boolean>,
        ),
      ),
    ]);
  } catch (err) {
    const refused = contractRefusal(err);
    if (!refused) throw unreadable(`the legal-body factory wiring (factory ${p.factory})`, err);
    // The two controller reads (pins and grants) are the only ones not made at the factory.
    const atController =
      refused.address !== undefined &&
      isAddressEqual(refused.address, p.controller) &&
      !isAddressEqual(p.controller, p.factory);
    throw new Error(
      atController
        ? `boot: CONTROLLER_ADDRESS ${p.controller} does not answer as the controller of LEGAL_BODY_FACTORY_ADDRESS ${p.factory} on this chain (${refused.reason})`
        : `boot: LEGAL_BODY_FACTORY_ADDRESS ${p.factory} does not answer as a legal-body factory on this chain (${refused.reason})`,
      { cause: err },
    );
  }

  if (!isAddressEqual(owner, p.controller))
    throw new Error(
      `boot: LEGAL_BODY_FACTORY_ADDRESS ${p.factory} is owned by ${owner}, not by CONTROLLER_ADDRESS ${p.controller} — this is not the controller's legal-body factory`,
    );
  if (!isAddressEqual(pendingOwner, zeroAddress))
    throw new Error(
      `boot: an ownership handover of LEGAL_BODY_FACTORY_ADDRESS ${p.factory} to ${pendingOwner} is pending — refusing to boot until it is accepted or cancelled (the executor's grants would stop reaching it)`,
    );
  if (!isAddressEqual(registry, p.identityRegistry))
    throw new Error(
      `boot: LEGAL_BODY_FACTORY_ADDRESS ${p.factory} reads identity registry ${registry}, not IDENTITY_REGISTRY ${p.identityRegistry}`,
    );
  const [, domainName, domainVersion, domainChainId, verifyingContract] = domain;
  if (domainChainId !== BigInt(p.chainId))
    throw new Error(
      `boot: LEGAL_BODY_FACTORY_ADDRESS ${p.factory} signs for chain id ${domainChainId}, not ARC_CHAIN_ID ${p.chainId} — the configured chain id is not the chain this factory runs on; every legal-body record would store the wrong chain and every link signature would be refused`,
    );
  if (!isAddressEqual(verifyingContract, p.factory))
    throw new Error(
      `boot: LEGAL_BODY_FACTORY_ADDRESS ${p.factory} names ${verifyingContract} as the verifying contract of its typed-data domain, not itself — link signatures built for this address would be refused`,
    );
  if (domainName !== LEGAL_BODY_FACTORY_DOMAIN.name)
    throw new Error(
      `boot: LEGAL_BODY_FACTORY_ADDRESS ${p.factory} has typed-data domain name ${JSON.stringify(domainName)}, not ${JSON.stringify(LEGAL_BODY_FACTORY_DOMAIN.name)} — this is not the legal-body factory this build signs for`,
    );
  if (domainVersion !== LEGAL_BODY_FACTORY_DOMAIN.version)
    throw new Error(
      `boot: LEGAL_BODY_FACTORY_ADDRESS ${p.factory} has typed-data domain version ${JSON.stringify(domainVersion)}, not ${JSON.stringify(LEGAL_BODY_FACTORY_DOMAIN.version)} — this build signs for another version of the factory`,
    );
  const badPins = LEGAL_BODY_GRANTED_SELECTORS.filter(
    (_, i) => !pins[i] || !isAddressEqual(pins[i]!, p.factory),
  );
  if (badPins.length > 0)
    throw new Error(
      `boot: ${badPins.map((s) => `${s.name} (${s.selector})`).join(", ")} not pinned to LEGAL_BODY_FACTORY_ADDRESS ${p.factory} on CONTROLLER_ADDRESS ${p.controller} — pin each selector to the factory (setBoundTarget) before granting it`,
    );
  const missing = LEGAL_BODY_GRANTED_SELECTORS.filter((_, i) => !grants[i]);
  if (missing.length > 0)
    throw new Error(
      `boot: executor ${p.executor} (the address of PLATFORM_PRIVATE_KEY) is missing ${missing.map((s) => `${s.name} (${s.selector})`).join(", ")} on CONTROLLER_ADDRESS ${p.controller} — grant it from the controller admin`,
    );
}

/** The creation code of a minimal proxy (EIP-1167), before and after the address of the code it
 *  runs. */
const MINIMAL_PROXY_CREATION_HEAD: Hex = "0x3d602d80600a3d3981f3363d3d373d3d3d363d73";
const MINIMAL_PROXY_CREATION_TAIL: Hex = "0x5af43d82803e903d91602b57fd5bf3";

/** The bounds of the amendment delay a factory takes, in seconds, as the version states them. */
const STATED_MIN_AMENDMENT_DELAY = 172_800n;
const STATED_MAX_AMENDMENT_DELAY = 2_592_000n;

/** What `MAX_AMENDMENT_DELAY()` answers on legal-body code under which the wallet that started a
 *  dissolution can cancel it. */
const CANCELLABLE_DISSOLUTION_CODE_MAX_AMENDMENT_DELAY = 31_536_000n;

/**
 * Proves on chain what a pair's agreement says of the legal body's contract; else throws.
 *
 * Run at start, after the factory's wiring, for a pair whose agreement states such facts. Each
 * refusal names the version, the factory and the fact that does not hold. A read of 1, 2 or 4 that
 * the contract refused (no code at the address, or no such function) is that fact's refusal; any
 * other read that fails is `unreadable`, a verification outage.
 *
 * `fixed_copy_cancellable_dissolution`, the one set of facts a version states today, in four reads
 * and one local computation, in this order:
 * 1. `implementation()` on the factory: the address of the code its legal bodies run.
 * 2. `predictLegalBody` on the factory, with a salt of 32 zero bytes, against the address computed
 *    here: the CREATE2 address of a minimal proxy (EIP-1167) to that code, created by the factory
 *    with that salt. Equal, the factory creates each legal body as a fixed copy: its bytecode holds
 *    the code's address, and no call can point it at other code.
 * 3. `MIN_AMENDMENT_DELAY()` and `MAX_AMENDMENT_DELAY()` on the factory: the bounds of the
 *    amendment delay a legal body is created with are the ones the version states.
 * 4. `MAX_AMENDMENT_DELAY()` on the code: a constant the contract gained in the same change as the
 *    rule that lets the wallet that started a dissolution cancel it. Code that does not answer it,
 *    or answers another value, is refused as code without that rule.
 */
export async function assertLegalBodyContractFacts(
  publicClient: PublicClient,
  p: { factory: Address; facts: LegalBodyContractFacts; agreementVersion: string },
): Promise<void> {
  const notServable = (fact: string, cause?: unknown) =>
    new Error(
      `boot: LEGAL_BODY_AGREEMENT_VERSION ${p.agreementVersion} cannot be served: ${fact}`,
      cause === undefined ? undefined : { cause },
    );
  const what = `the legal-body contract facts of agreement ${p.agreementVersion} (factory ${p.factory})`;

  // 1. The code the factory's legal bodies run.
  let code: Address;
  try {
    code = (await publicClient.readContract({
      address: p.factory,
      abi: legalBodyFactoryAbi,
      functionName: "implementation",
    })) as Address;
  } catch (err) {
    if (!contractRefusal(err)) throw unreadable(what, err);
    throw notServable(
      `LEGAL_BODY_FACTORY_ADDRESS ${p.factory} does not answer implementation(), the code its legal bodies run`,
      err,
    );
  }

  // 2. Each legal body is a fixed copy of that code.
  const notFixedCopies = `LEGAL_BODY_FACTORY_ADDRESS ${p.factory} does not create each legal body as a fixed copy of the code at ${code}, and this version is written for legal bodies whose code is never replaced`;
  let predicted: Address;
  try {
    predicted = (await publicClient.readContract({
      address: p.factory,
      abi: legalBodyFactoryAbi,
      functionName: "predictLegalBody",
      args: [zeroHash],
    })) as Address;
  } catch (err) {
    if (!contractRefusal(err)) throw unreadable(what, err);
    throw notServable(notFixedCopies, err);
  }
  const fixedCopy = getContractAddress({
    opcode: "CREATE2",
    from: p.factory,
    salt: zeroHash,
    bytecode: concatHex([MINIMAL_PROXY_CREATION_HEAD, code, MINIMAL_PROXY_CREATION_TAIL]),
  });
  if (!isAddressEqual(predicted, fixedCopy)) throw notServable(notFixedCopies);

  // 3. The bounds of the amendment delay the factory takes.
  let minDelay: bigint;
  let maxDelay: bigint;
  try {
    [minDelay, maxDelay] = await Promise.all([
      publicClient.readContract({
        address: p.factory,
        abi: legalBodyFactoryAbi,
        functionName: "MIN_AMENDMENT_DELAY",
      }) as Promise<bigint>,
      publicClient.readContract({
        address: p.factory,
        abi: legalBodyFactoryAbi,
        functionName: "MAX_AMENDMENT_DELAY",
      }) as Promise<bigint>,
    ]);
  } catch (err) {
    throw unreadable(what, err);
  }
  if (minDelay !== STATED_MIN_AMENDMENT_DELAY || maxDelay !== STATED_MAX_AMENDMENT_DELAY)
    throw notServable(
      `LEGAL_BODY_FACTORY_ADDRESS ${p.factory} takes an amendment delay from ${minDelay} to ${maxDelay} seconds, and this version states ${STATED_MIN_AMENDMENT_DELAY} to ${STATED_MAX_AMENDMENT_DELAY}`,
    );

  // 4. The code lets the wallet that started a dissolution cancel it.
  const notCancellable = `the legal bodies of LEGAL_BODY_FACTORY_ADDRESS ${p.factory} run code under which the wallet that started a dissolution cannot cancel it, and this version says the Guardian Wallet can`;
  let codeMaxDelay: bigint;
  try {
    codeMaxDelay = (await publicClient.readContract({
      address: code,
      abi: legalManagerAbi,
      functionName: "MAX_AMENDMENT_DELAY",
    })) as bigint;
  } catch (err) {
    if (!contractRefusal(err)) throw unreadable(what, err);
    throw notServable(notCancellable, err);
  }
  if (codeMaxDelay !== CANCELLABLE_DISSOLUTION_CODE_MAX_AMENDMENT_DELAY)
    throw notServable(notCancellable);
}

/**
 * Legacy mode (no controller) with a factory configured: the signing key must still BE the
 * factory's owner. Catches the flipped-factory-forgot-CONTROLLER_ADDRESS case, and the window
 * where ownership was transferred to a controller that this deployment does not know about.
 */
export async function assertLegacyFactoryOwner(
  publicClient: PublicClient,
  p: { factory: Address; signer: Address },
): Promise<void> {
  let owner: Address;
  try {
    owner = (await publicClient.readContract({
      address: p.factory,
      abi: legalManagerFactoryAbi,
      functionName: "owner",
    })) as Address;
  } catch (err) {
    throw unreadable(`the factory owner (FACTORY_ADDRESS ${p.factory})`, err);
  }
  if (!isAddressEqual(owner, p.signer))
    throw new Error(
      `boot: FACTORY_ADDRESS ${p.factory} owner is ${owner}, not the signing key ${p.signer} — factory owner is not the signing key; is CONTROLLER_ADDRESS missing? (if this factory was handed to a NoviController, set CONTROLLER_ADDRESS to it; if the handover is still pending, complete or cancel it before starting)`,
    );
}
