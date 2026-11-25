/**
 * The company's pot, the whole flow, on a fork of Arc testnet with Safe's real contracts.
 *
 * Opt-in, off by default (the pattern of `test/jobs.arc.live.test.ts`): it needs the network.
 * Step 0 is pure (no chain) and runs ALWAYS, so every run of the suite pins this file's encoders
 * to the website's vectors; the steps after it need the flag:
 *
 *   cd back/backend && SAFE_POT_FORK=1 ./node_modules/.bin/vitest run --minWorkers=1 \
 *     --maxWorkers=2 test/legalBody/safePot.fork.live.test.ts
 *
 * What it does. It starts its OWN anvil forking `https://rpc.testnet.arc.io` on 127.0.0.1:8572
 * (refused when the port is taken; never 8555, never 8546) and stops it at the end. Anvil's first
 * four accounts, read from the node, are the guardian, the agent's key, a payee and the agent's new
 * key: published test addresses, never a key of anyone's, and no key is written here (the node
 * signs for its own accounts). On Arc testnet two of them carry an EIP-7702 delegation someone set;
 * the test clears the code of all four on the fork, so each is a plain key as the pot expects.
 *
 * The server's own encoders and reader run against the real code the fork holds: the setup's
 * initializer and address (`potInitializer`, `predictPotAddress`), the agent's take
 * (`takeCalldata`), the reads (`SafePotChain.readPot`) and the rules (`potReading`), the start-up
 * check (`assertPotContracts`), and the note door (`declarePot`, Ruling R22). The guardian's
 * transactions are built by small encoders of this file, lifted from the proven script of
 * 20-24 Nov (`msTx`, `multiSendData`, `ownerSig`, `execTxData` and the Multicall3 wrapper of its
 * `buildPlan`), in exactly the shapes the website sends: step 0 pins them to the same bytes the
 * website's encoders are pinned to (V2, V4 to V6, V9 to V13 and V16).
 *
 * The module logic runs on the repository's 6-decimal `MockUSDC`, through a copy of the pot's table
 * whose `usdc` is the mock: an anvil fork cannot move Arc's USDC (its transfer calls a node-level
 * precompile the fork does not run). The native coin stands where Arc's native balance stands: the
 * money sent to the pot and the fee money are native value, as on Arc.
 *
 * What this does NOT prove, and stays proven only by the real run on Arc testnet of 24 Nov and by
 * the read-only simulations made while planning:
 *  - Arc's USDC as the token, where a take through its ERC-20 face moves the native balance;
 *  - fees paid in USDC;
 *  - the node's refusal of a sender with no balance;
 *  - the guardian's USDC transfer for "Add money" and "Send fee money" (estimated on the real node,
 *    not mined);
 *  - the restore on the real Safe (simulated on the real node, not mined).
 *
 * Time is moved with `evm_setNextBlockTimestamp` and one mined block, five seconds into the minute,
 * as the proof did. The steps share one chain and run in order.
 */
import {
  http,
  type Address,
  type Hex,
  type PublicClient,
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  encodePacked,
  getAddress,
  keccak256,
  pad,
  parseAbi,
  parseEventLogs,
  size,
  zeroAddress,
} from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PotContractsNotVerifiedError,
  SafePotChain,
  assertPotContracts,
} from "../../src/adapters/arc/safePotChain";
import { ApiError } from "../../src/errors";
import { declarePot } from "../../src/legalBody/pot";
import {
  POT_PERIOD_MINUTES,
  POT_TAKE_GAS,
  type PotAddresses,
  type PotRaw,
  type PotReading,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  SAFE_SENTINEL,
  allowanceModuleAbi,
  multiSendAbi,
  potAddresses,
  potInitializer,
  potReading,
  predictPotAddress,
  safeAbi,
  takeCalldata,
} from "../../src/legalBody/safePot";
import { SqliteLegalBodyPotRepository } from "../../src/persistence/legalBodyPotRepository";
import { type AnvilHandle, startAnvil } from "../helpers/anvil";
import { loadArtifact } from "../helpers/artifacts";
import { openStatementStores } from "../helpers/legalBodyStatementFixtures";
import {
  A as RUN_A,
  G as RUN_G,
  P as RUN_P,
  fakeRegistry,
  potBody,
  potDeps,
} from "../helpers/potFixtures";

const gated = process.env.SAFE_POT_FORK === "1";
const run = gated ? describe : describe.skip;

const FORK_URL = "https://rpc.testnet.arc.io";
/** This test's own port: never 8555 (another session's) and never 8546. */
const PORT = 8572;
const ARC_TESTNET = 5_042_002;

const PERIOD = BigInt(POT_PERIOD_MINUTES);
const TAKE_GAS = BigInt(POT_TAKE_GAS);
/** The plan's caps: the setup and any execTransaction. */
const SETUP_GAS = 1_500_000n;
const EXEC_GAS = 500_000n;
/** 6 decimals: the mock token, as USDC's ERC-20 face. */
const U = 1_000_000n;
/** 18 decimals: the native coin, as Arc's native balance. */
const WEI = 1_000_000_000_000_000_000n;

// ---------------------------------------------------------------------------------------------
// The guardian's transactions, lifted from the proven script, in the shapes the website sends
// ---------------------------------------------------------------------------------------------

/** The members the script's ABIs hold beyond the server's pinned fragments. */
const safeTxAbi = parseAbi([
  "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
  "function disableModule(address prevModule, address module)",
  "function setFallbackHandler(address handler)",
  "function addOwnerWithThreshold(address owner, uint256 _threshold)",
  "function nonce() view returns (uint256)",
]);
const factoryAbi = parseAbi([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
  "event ProxyCreation(address indexed proxy, address singleton)",
]);
const multicall3Abi = parseAbi([
  "struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3Value(Call3Value[] calls) payable returns (Result[] returnData)",
]);
const moduleExtraAbi = parseAbi([
  "function removeDelegate(address delegate, bool removeAllowances)",
]);

const OP_CALL = 0;
const OP_DELEGATECALL = 1;
const low = <T extends Hex>(x: T): T => x.toLowerCase() as T;

/** One part of a MultiSendCallOnly batch: operation, to, value, data length, data, packed. */
const msTx = (op: 0 | 1, to: Address, value: bigint, data: Hex): Hex =>
  encodePacked(
    ["uint8", "address", "uint256", "uint256", "bytes"],
    [op, low(to), value, BigInt(size(data)), low(data)],
  );
const multiSendData = (txs: readonly Hex[]): Hex =>
  encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [concat([...txs])] });
/** The guardian is the only owner, threshold 1: the "approved by the sender" signature. */
const ownerSig = (owner: Address): Hex =>
  concat([pad(low(owner), { size: 32 }), pad("0x00", { size: 32 }), "0x01"]);
const execTxData = (
  owner: Address,
  t: { to: Address; value?: bigint; data?: Hex; operation?: 0 | 1 },
): Hex =>
  encodeFunctionData({
    abi: safeTxAbi,
    functionName: "execTransaction",
    args: [
      low(t.to),
      t.value ?? 0n,
      t.data ?? "0x",
      t.operation ?? OP_CALL,
      0n,
      0n,
      0n,
      zeroAddress,
      zeroAddress,
      ownerSig(owner),
    ],
  });

const enableModulePart = (a: PotAddresses): Hex =>
  msTx(
    OP_CALL,
    zeroAddress,
    0n,
    encodeFunctionData({
      abi: safeAbi,
      functionName: "enableModule",
      args: [low(a.allowanceModule)],
    }),
  );
const disableModulePart = (a: PotAddresses, previous: Address): Hex =>
  msTx(
    OP_CALL,
    zeroAddress,
    0n,
    encodeFunctionData({
      abi: safeTxAbi,
      functionName: "disableModule",
      args: [low(previous), low(a.allowanceModule)],
    }),
  );
const addDelegatePart = (a: PotAddresses, delegate: Address): Hex =>
  msTx(
    OP_CALL,
    a.allowanceModule,
    0n,
    encodeFunctionData({
      abi: allowanceModuleAbi,
      functionName: "addDelegate",
      args: [low(delegate)],
    }),
  );
const removeDelegatePart = (a: PotAddresses, delegate: Address): Hex =>
  msTx(
    OP_CALL,
    a.allowanceModule,
    0n,
    encodeFunctionData({
      abi: moduleExtraAbi,
      functionName: "removeDelegate",
      args: [low(delegate), true],
    }),
  );
const setAllowanceData = (key: Address, token: Address, ceilingUnits: bigint): Hex =>
  encodeFunctionData({
    abi: allowanceModuleAbi,
    functionName: "setAllowance",
    args: [low(key), low(token), ceilingUnits, POT_PERIOD_MINUTES, 0],
  });

/** The setup: Multicall3 `aggregate3Value`, none allowed to fail: the factory's
 *  `createProxyWithNonce(singleton, potInitializer(...), saltNonce)` with value 0; the predicted
 *  address with the money and no data; the agent with the fee money and no data. A call worth 0 is
 *  left out, as the website leaves it out. */
function setupTx(
  a: PotAddresses,
  p: {
    guardian: Address;
    agentWallet: Address;
    token: Address;
    ceilingUnits: bigint;
    saltNonce: bigint;
    fundWei: bigint;
    agentGasWei: bigint;
    periodMinutes?: number;
  },
): { pot: Address; to: Address; data: Hex; value: bigint; calls: number } {
  const initializer = potInitializer(a, {
    guardian: p.guardian,
    agentWallet: p.agentWallet,
    token: p.token,
    ceilingUnits: p.ceilingUnits,
    periodMinutes: p.periodMinutes ?? POT_PERIOD_MINUTES,
  });
  const pot = predictPotAddress(a, initializer, p.saltNonce);
  const calls = [
    {
      target: low(a.proxyFactory),
      allowFailure: false,
      value: 0n,
      callData: encodeFunctionData({
        abi: factoryAbi,
        functionName: "createProxyWithNonce",
        args: [low(a.safeSingleton), initializer, p.saltNonce],
      }),
    },
  ];
  if (p.fundWei !== 0n)
    calls.push({ target: low(pot), allowFailure: false, value: p.fundWei, callData: "0x" });
  if (p.agentGasWei !== 0n)
    calls.push({
      target: low(p.agentWallet),
      allowFailure: false,
      value: p.agentGasWei,
      callData: "0x",
    });
  return {
    pot,
    to: a.multicall3,
    data: encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3Value",
      args: [calls],
    }),
    value: p.fundWei + p.agentGasWei,
    calls: calls.length,
  };
}

/** The change: `execTransaction(module, 0, setAllowance(key, token, amount, 43200, 0), 0, ...)`. */
const changeTx = (
  a: PotAddresses,
  guardian: Address,
  key: Address,
  token: Address,
  ceilingUnits: bigint,
): Hex =>
  execTxData(guardian, {
    to: a.allowanceModule,
    data: setAllowanceData(key, token, ceilingUnits),
  });

/** The stop: a delegatecall to MultiSendCallOnly of `removeDelegate(d, true)` for each delegate,
 *  then `disableModule(previous, module)` sent to the zero address. No amount. */
function stopTx(
  a: PotAddresses,
  guardian: Address,
  delegates: readonly Address[],
  modules: readonly Address[],
): Hex {
  const parts = delegates.map((d) => removeDelegatePart(a, d));
  const i = modules.findIndex((m) => m.toLowerCase() === a.allowanceModule.toLowerCase());
  if (i >= 0)
    parts.push(disableModulePart(a, i === 0 ? SAFE_SENTINEL : (modules[i - 1] as Address)));
  return execTxData(guardian, {
    to: a.multiSendCallOnly,
    data: multiSendData(parts),
    operation: OP_DELEGATECALL,
  });
}

/** The restore (start again, or a new key): a delegatecall to MultiSendCallOnly of
 *  `removeDelegate(d, true)` for each listed delegate, `enableModule(module)` to the zero address
 *  when the module is off, `addDelegate(key)`, `setAllowance(key, token, amount, 43200, 0)`. */
function restoreTx(
  a: PotAddresses,
  guardian: Address,
  p: {
    key: Address;
    token: Address;
    ceilingUnits: bigint;
    delegates: readonly Address[];
    modules: readonly Address[];
  },
): Hex {
  const parts = p.delegates.map((d) => removeDelegatePart(a, d));
  if (p.modules.length === 0) parts.push(enableModulePart(a));
  parts.push(
    addDelegatePart(a, p.key),
    msTx(OP_CALL, a.allowanceModule, 0n, setAllowanceData(p.key, p.token, p.ceilingUnits)),
  );
  return execTxData(guardian, {
    to: a.multiSendCallOnly,
    data: multiSendData(parts),
    operation: OP_DELEGATECALL,
  });
}

/** The take back: `execTransaction(guardian, value, 0x, 0, ...)`. */
const takeBackTx = (guardian: Address, wei: bigint): Hex =>
  execTxData(guardian, { to: guardian, value: wei });

/** Bytes pinned by their length and keccak256. */
function pinned(data: Hex, bytes: number, hash: Hex): void {
  expect(size(data)).toBe(bytes);
  expect(keccak256(data)).toBe(hash);
}

/** Every message down an error's cause chain, so a revert reason is found wherever viem put it. */
function messagesOf(e: unknown): string {
  const parts: string[] = [];
  let x: unknown = e;
  for (let depth = 0; x instanceof Error && depth < 10; depth += 1) {
    parts.push(x.message);
    x = (x as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

// ---------------------------------------------------------------------------------------------
// The fork
// ---------------------------------------------------------------------------------------------

function clientsFor(rpcUrl: string) {
  const chain = defineChain({
    id: ARC_TESTNET,
    name: "Arc testnet fork",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const transport = http(rpcUrl);
  return {
    chain,
    pub: createPublicClient({ chain, transport, pollingInterval: 50 }),
    wallet: createWalletClient({ chain, transport }),
    test: createTestClient({ chain, mode: "anvil", transport }),
  };
}

/** Step 0 needs no chain: it runs whatever the flag, so every run of the suite pins this file's
 *  encoders to the website's vectors. */
describe("the fork test's own encoders, pinned to the website's vectors (no chain, always run)", () => {
  it("0. the test's own encoders give the bytes the website's encoders are pinned to (V2, V4 to V6, V9 to V13 and V16)", () => {
    const T = potAddresses(ARC_TESTNET);
    if (T === null) throw new Error("no pot table");
    const v3 = { guardian: RUN_G, agentWallet: RUN_A, token: T.usdc, ceilingUnits: 50n * U };
    const v2 = setupTx(T, {
      ...v3,
      ceilingUnits: 2n * U,
      periodMinutes: 5,
      saltNonce: 72231338869903870587851170785833461215n,
      fundWei: 5n * WEI,
      agentGasWei: WEI / 10n,
    });
    pinned(v2.data, 1796, "0x4b7b3d40ad68c749c0fd423f03c816f5a96bc6d48bdcdb48adcb292327340ad4");
    expect(v2.value).toBe(5_100_000_000_000_000_000n);
    expect(v2.pot).toBe("0x0bbBa174c1D6b6Edd2F1A86ff5af435B645b77EF");
    const v4 = setupTx(T, { ...v3, saltNonce: 1n, fundWei: 0n, agentGasWei: 0n });
    pinned(v4.data, 1412, "0x50c45965c858bc26d42cfe3d36b6a90e33a0dca0a984b03af5e41112a9d23e73");
    expect([v4.calls, v4.value, v4.pot]).toEqual([
      1,
      0n,
      "0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D",
    ]);
    const v5 = setupTx(T, { ...v3, saltNonce: 1n, fundWei: 60n * WEI, agentGasWei: WEI / 10n });
    pinned(v5.data, 1796, "0xb5141445053d556060d1ea2ca1cb75be1d85193cc326b949272fff21238a772d");
    pinned(
      changeTx(T, RUN_G, RUN_A, T.usdc, 20n * U),
      676,
      "0xc615b5f6bca36df97bbcb1f78c3a6a5f5a4cfb3c0f932d529192511423f01944",
    );
    pinned(
      stopTx(T, RUN_G, [RUN_A], [T.allowanceModule]),
      900,
      "0xd709c6dfd342e50a6df9859f5063de95552f967b76c3281224a69a8c93507324",
    );
    pinned(
      takeBackTx(RUN_G, 3n * WEI),
      484,
      "0xce7031830a444423e2440b3aa34c5e9bfd41e6606641d3deb24abb35961dd164",
    );
    const restore = { token: T.usdc, ceilingUnits: 50n * U };
    pinned(
      restoreTx(T, RUN_G, { ...restore, key: RUN_A, delegates: [], modules: [] }),
      1092,
      "0x86747b4dd8d72f104246417a357650d86a7dd380fef6a438545ae98b453fdb76",
    );
    pinned(
      restoreTx(T, RUN_G, {
        ...restore,
        key: RUN_P,
        delegates: [RUN_A],
        modules: [T.allowanceModule],
      }),
      1124,
      "0xf8652af05b7d90febd332989e7aa09032325dac7467a629f72dc61fb28bed50c",
    );
    pinned(
      restoreTx(T, RUN_G, { ...restore, key: RUN_P, delegates: [], modules: [] }),
      1092,
      "0x80154523980e27f1c18cdd015aedbfb47a427bc92292b88995879b2373401c12",
    );
    // V16: start again with the key itself still listed (removeDelegate first).
    pinned(
      restoreTx(T, RUN_G, { ...restore, key: RUN_A, delegates: [RUN_A], modules: [] }),
      1252,
      "0x5cc5e16da50f1eaa12fa7f4a415b509af88d67e05b494e1fb809035362871c1f",
    );
  });
});

run("the company's pot on a fork of Arc testnet, with Safe's real contracts", () => {
  let anvil: AnvilHandle | undefined;
  let c: ReturnType<typeof clientsFor>;
  /** The real table: the seven addresses the fork holds the real code of. */
  let REAL: PotAddresses;
  /** The same table with the mock token in USDC's place, for the module logic. */
  let M: PotAddresses;
  let mock: Address;
  let tokenAbi: ReturnType<typeof loadArtifact>["abi"];
  /** Anvil's first four accounts: the guardian, the agent's key, a payee, the agent's new key. */
  let G: Address;
  let A: Address;
  let P: Address;
  let K: Address;
  /** Salt numbers no pot on Arc testnet uses: from the fork's own block number. */
  let saltBase: bigint;

  // State the steps of the main pot share, in order.
  let pot: Address;
  let firstPeriodStart: bigint;
  let secondPeriodStart: bigint;
  /** Gas used by each kind of transaction, printed once at the end for the record of the run. */
  const gasUsed: Record<string, string> = {};

  beforeAll(async () => {
    anvil = await startAnvil(PORT, { forkUrl: FORK_URL });
    c = clientsFor(anvil.rpcUrl);
    expect(await c.pub.getChainId()).toBe(ARC_TESTNET);
    const table = potAddresses(ARC_TESTNET);
    if (table === null) throw new Error("no pot table for Arc testnet");
    REAL = table;

    const accounts = await c.wallet.getAddresses();
    [G, A, P, K] = accounts as [Address, Address, Address, Address];
    for (const who of [G, A, P, K]) {
      await c.test.setCode({ address: who, bytecode: "0x" });
      await c.test.setBalance({ address: who, value: 1_000n * WEI });
      expect(await c.pub.getCode({ address: who })).toBeUndefined();
    }
    saltBase = (await c.pub.getBlockNumber()) * 1_000n;

    const artifact = loadArtifact("MockUSDC");
    tokenAbi = artifact.abi;
    const hash = await c.wallet.deployContract({
      account: G,
      chain: c.chain,
      abi: artifact.abi,
      bytecode: artifact.bytecode,
    });
    const deployed = await c.pub.waitForTransactionReceipt({ hash });
    if (!deployed.contractAddress) throw new Error("MockUSDC was not deployed");
    mock = getAddress(deployed.contractAddress);
    M = { ...REAL, usdc: mock };
  });

  afterAll(() => {
    anvil?.stop();
    console.log(`safe pot fork: gas used ${JSON.stringify(gasUsed)}`);
  });

  /** A transaction from one of the node's accounts, with an explicit gas limit (so a transaction
   *  that reverts is mined as reverted, never refused by an estimate), and its receipt. */
  async function send(from: Address, to: Address, data: Hex, o: { gas: bigint; value?: bigint }) {
    const hash = await c.wallet.sendTransaction({
      account: from,
      chain: c.chain,
      to,
      data,
      value: o.value ?? 0n,
      gas: o.gas,
    });
    return c.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 });
  }

  /** The revert of an eth_call, as text; throws when the call does not revert. */
  async function revertOf(from: Address, to: Address, data: Hex, value = 0n): Promise<string> {
    try {
      await c.pub.call({ account: from, to, data, value });
    } catch (e) {
      return messagesOf(e);
    }
    throw new Error("the call did not revert");
  }

  const nativeOf = (who: Address) => c.pub.getBalance({ address: who });
  const tokenOf = (who: Address) =>
    c.pub.readContract({
      address: mock,
      abi: tokenAbi,
      functionName: "balanceOf",
      args: [who],
    }) as Promise<bigint>;
  const mint = (to: Address, units: bigint) =>
    send(G, mock, encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [to, units] }), {
      gas: 200_000n,
    });
  const safeNonceOf = (safe: Address) =>
    c.pub.readContract({ address: safe, abi: safeTxAbi, functionName: "nonce" });
  const allowanceOf = (safe: Address, key: Address) =>
    c.pub.readContract({
      address: M.allowanceModule,
      abi: allowanceModuleAbi,
      functionName: "getTokenAllowance",
      args: [safe, key, mock],
    });

  /** The server's reads and rules, for the pot as the guardian `G` holds it. */
  async function readingOf(
    safe: Address,
    agentWallet: Address,
    a: PotAddresses = M,
  ): Promise<{ raw: PotRaw; reading: PotReading }> {
    const raw = await new SafePotChain({
      publicClient: c.pub as unknown as PublicClient,
      addresses: a,
    }).readPot({ pot: safe, agentWallet });
    return { raw, reading: potReading(raw, { addresses: a, guardian: G, agentWallet }) };
  }

  /** The ceiling read, or a failure naming what was read instead. */
  async function ceilingOf(safe: Address, agentWallet: Address) {
    const { reading } = await readingOf(safe, agentWallet);
    if (reading.state !== "ceiling_read")
      throw new Error(
        `expected ceiling_read, read ${JSON.stringify(reading, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`,
      );
    return reading;
  }

  /** The agent's take, sent by `from` itself to the module with the fixed gas limit. */
  const takeData = (safe: Address, from: Address, units: bigint, token: Address = mock) =>
    takeCalldata({ pot: safe, token, to: P, amountUnits: units, agentWallet: from });

  /** A take that passes: the payee gains exactly the amount, under the fixed gas limit. */
  async function takes(safe: Address, from: Address, units: bigint) {
    const before = await tokenOf(P);
    const r = await send(from, M.allowanceModule, takeData(safe, from, units), { gas: TAKE_GAS });
    expect(r.status).toBe("success");
    expect(r.gasUsed < TAKE_GAS).toBe(true);
    expect((await tokenOf(P)) - before).toBe(units);
    return r;
  }

  /** A take that is refused: the call reverts (with `reason` when given), the mined transaction
   *  reverts, and the payee and the pot hold what they held. */
  async function refusedTake(
    safe: Address,
    from: Address,
    units: bigint,
    o: { reason?: string; token?: Address } = {},
  ) {
    const data = takeData(safe, from, units, o.token);
    const why = await revertOf(from, M.allowanceModule, data);
    if (o.reason !== undefined) expect(why).toContain(o.reason);
    const payee = await tokenOf(P);
    const held = await tokenOf(safe);
    const heldWei = await nativeOf(safe);
    const r = await send(from, M.allowanceModule, data, { gas: TAKE_GAS });
    expect(r.status).toBe("reverted");
    expect(await tokenOf(P)).toBe(payee);
    expect(await tokenOf(safe)).toBe(held);
    expect(await nativeOf(safe)).toBe(heldWei);
  }

  /** The guardian's Safe transaction to the pot, which must pass. */
  async function guardianExec(safe: Address, data: Hex) {
    const r = await send(G, safe, data, { gas: EXEC_GAS });
    expect(r.status).toBe("success");
    return r;
  }

  /** Mines one block at five seconds into `minute`. */
  async function atMinute(minute: bigint) {
    await c.test.setNextBlockTimestamp({ timestamp: minute * 60n + 5n });
    await c.test.mine({ blocks: 1 });
  }
  const minuteOf = async (blockNumber: bigint) =>
    (await c.pub.getBlock({ blockNumber })).timestamp / 60n;

  // -------------------------------------------------------------------------------------------

  it("1. the start-up check passes against the fork with the real table, and fails on a table naming another token", async () => {
    const client = c.pub as unknown as PublicClient;
    await expect(assertPotContracts(client, REAL)).resolves.toBeUndefined();
    const other = await assertPotContracts(client, M).catch((e: unknown) => e);
    expect(other).toBeInstanceOf(PotContractsNotVerifiedError);
    expect(other).toMatchObject({ reason: "mismatch", contract: "usdc" });
  });

  it("2. one guardian transaction to Multicall3, value 5.1, creates the pot at the predicted address with a ceiling of 50 in each thirty-day period", async () => {
    const setup = setupTx(M, {
      guardian: G,
      agentWallet: A,
      token: mock,
      ceilingUnits: 50n * U,
      saltNonce: saltBase + 1n,
      fundWei: 5n * WEI,
      agentGasWei: WEI / 10n,
    });
    pot = setup.pot;
    expect(setup.calls).toBe(3);
    expect(setup.value).toBe(5_100_000_000_000_000_000n);
    expect((await readingOf(pot, A)).reading).toEqual({ state: "absent" });
    const agentBefore = await nativeOf(A);

    const r = await send(G, setup.to, setup.data, { gas: SETUP_GAS, value: setup.value });
    expect(r.status).toBe("success");
    expect(r.to?.toLowerCase()).toBe(M.multicall3.toLowerCase());
    expect(r.gasUsed < 600_000n).toBe(true);
    gasUsed.setup = r.gasUsed.toString();
    const created = parseEventLogs({ abi: factoryAbi, eventName: "ProxyCreation", logs: r.logs });
    expect(created).toHaveLength(1);
    expect(created[0]?.args.proxy).toBe(pot);
    expect(created[0]?.args.singleton).toBe(M.safeSingleton);
    const chain = new SafePotChain({
      publicClient: c.pub as unknown as PublicClient,
      addresses: M,
    });
    expect(await chain.codeHash(pot)).toBe(SAFE_PROXY_RUNTIME_CODE_HASH);
    expect(await nativeOf(pot)).toBe(5n * WEI);
    expect((await nativeOf(A)) - agentBefore).toBe(WEI / 10n);

    const { raw, reading } = await readingOf(pot, A);
    expect(raw.owners).toEqual([G]);
    expect(raw.threshold).toBe(1n);
    expect(raw.modules).toEqual({ list: [M.allowanceModule], next: SAFE_SENTINEL });
    expect(raw.delegates).toEqual({ list: [A], next: 0 });
    expect(raw.tokens).toEqual([mock]);
    expect(raw.balanceWei).toBe(5n * WEI);
    firstPeriodStart = await minuteOf(r.blockNumber);
    expect(raw.allowance).toEqual([50n * U, 0n, PERIOD, firstPeriodStart, 1n]);
    expect(reading).toEqual({
      state: "ceiling_read",
      ceilingUnits: 50_000_000n,
      spentUnits: 0n,
      periodEndsAt: Number((firstPeriodStart + PERIOD) * 60n),
      nonce: 1n,
      balanceUnits: 0n,
    });
  });

  it("3. with 200 in the pot, the agent's own key takes 10 to a payee, under 200,000 gas", async () => {
    expect((await mint(pot, 200n * U)).status).toBe("success");
    gasUsed.firstTake = (await takes(pot, A, 10n * U)).gasUsed.toString();
    const reading = await ceilingOf(pot, A);
    expect(reading.spentUnits).toBe(10_000_000n);
    expect(reading.balanceUnits).toBe(190n * U);
  });

  it("4. a take of 41 is refused; exactly 40 passes; one more unit is refused", async () => {
    const ceiling = "newSpent > allowance.spent && newSpent <= allowance.amount";
    await refusedTake(pot, A, 41n * U, { reason: ceiling });
    await takes(pot, A, 40n * U);
    expect((await ceilingOf(pot, A)).spentUnits).toBe(50n * U);
    await refusedTake(pot, A, 1n, { reason: ceiling });
  });

  it("5. a take with the token set to the zero address is refused: no allowance on the native coin", async () => {
    await refusedTake(pot, A, 1n, {
      token: zeroAddress,
      reason: "newSpent > allowance.spent && newSpent <= allowance.amount",
    });
    expect(await nativeOf(pot)).toBe(5n * WEI);
  });

  it("6. the minute before the period's end a take is refused; at its end the reading says taken 0 with no transaction, and a take of 50 passes", async () => {
    await atMinute(firstPeriodStart + PERIOD - 1n);
    const before = await ceilingOf(pot, A);
    expect(before.spentUnits).toBe(50n * U);
    expect(before.periodEndsAt).toBe(Number((firstPeriodStart + PERIOD) * 60n));
    await refusedTake(pot, A, 1n);

    await atMinute(firstPeriodStart + PERIOD);
    secondPeriodStart = firstPeriodStart + PERIOD;
    const fresh = await ceilingOf(pot, A);
    expect(fresh.spentUnits).toBe(0n);
    expect(fresh.periodEndsAt).toBe(Number((secondPeriodStart + PERIOD) * 60n));
    await takes(pot, A, 50n * U);
    expect((await ceilingOf(pot, A)).spentUnits).toBe(50n * U);
  });

  it("7. a change to 20 keeps what was taken and the period's end; a take is refused until the next period", async () => {
    gasUsed.change = (await guardianExec(pot, changeTx(M, G, A, mock, 20n * U))).gasUsed.toString();
    const changed = await ceilingOf(pot, A);
    expect(changed.ceilingUnits).toBe(20_000_000n);
    expect(changed.spentUnits).toBe(50_000_000n);
    expect(changed.periodEndsAt).toBe(Number((secondPeriodStart + PERIOD) * 60n));
    await refusedTake(pot, A, 1n);

    await atMinute(secondPeriodStart + PERIOD);
    expect((await ceilingOf(pot, A)).spentUnits).toBe(0n);
    await refusedTake(pot, A, 21n * U);
    await takes(pot, A, 20n * U);
  });

  it("8. a new key on the running pot: the new key reads a fresh period, the old key reads other_delegate and is refused, the new key takes", async () => {
    const { raw } = await readingOf(pot, A);
    expect(raw.delegates.list).toEqual([A]);
    expect(raw.modules.list).toEqual([M.allowanceModule]);
    const r = await guardianExec(
      pot,
      restoreTx(M, G, {
        key: K,
        token: mock,
        ceilingUnits: 20n * U,
        delegates: raw.delegates.list,
        modules: raw.modules.list,
      }),
    );
    gasUsed.newKey = r.gasUsed.toString();
    const now = await minuteOf(r.blockNumber);
    const fresh = await ceilingOf(pot, K);
    expect(fresh.ceilingUnits).toBe(20n * U);
    expect(fresh.spentUnits).toBe(0n);
    expect(fresh.periodEndsAt).toBe(Number((now + PERIOD) * 60n));
    expect((await readingOf(pot, A)).reading).toMatchObject({
      state: "limits_not_read",
      problem: "other_delegate",
    });
    await refusedTake(pot, A, 1n);
    await takes(pot, K, 1n * U);
  });

  it("9. the stop (two parts, no amount) while the pot holds money: stopped (module_off), the module still answers for the key, a take is refused", async () => {
    const { raw } = await readingOf(pot, K);
    expect(raw.balanceWei).toBe(5n * WEI);
    expect(raw.balanceUnits > 0n).toBe(true);
    const nonceBefore = raw.allowance[4];
    gasUsed.stop = (
      await guardianExec(pot, stopTx(M, G, raw.delegates.list, raw.modules.list))
    ).gasUsed.toString();

    const after = await readingOf(pot, K);
    expect(after.reading).toEqual({
      state: "stopped",
      why: "module_off",
      balanceUnits: raw.balanceUnits,
    });
    expect(after.raw.modules.list).toEqual([]);
    expect(after.raw.delegates.list).toEqual([]);
    // The module still answers for the key: its token still listed, its allowance five numbers
    // with its nonce kept. The Safe's own module list is what says the allowance is off.
    expect(after.raw.tokens).toEqual([mock]);
    expect(after.raw.allowance).toEqual([0n, 0n, 0n, 0n, nonceBefore]);
    expect(await nativeOf(pot)).toBe(5n * WEI);
    await refusedTake(pot, K, 1n);
  });

  it("10. start again (no listed delegate, the module off): a fresh period, a take passes; then stopped again", async () => {
    const { raw } = await readingOf(pot, K);
    expect(raw.delegates.list).toEqual([]);
    expect(raw.modules.list).toEqual([]);
    const r = await guardianExec(
      pot,
      restoreTx(M, G, {
        key: K,
        token: mock,
        ceilingUnits: 50n * U,
        delegates: raw.delegates.list,
        modules: raw.modules.list,
      }),
    );
    gasUsed.startAgain = r.gasUsed.toString();
    const now = await minuteOf(r.blockNumber);
    const fresh = await ceilingOf(pot, K);
    expect(fresh.ceilingUnits).toBe(50n * U);
    expect(fresh.spentUnits).toBe(0n);
    expect(fresh.periodEndsAt).toBe(Number((now + PERIOD) * 60n));
    await takes(pot, K, 1n * U);

    const running = await readingOf(pot, K);
    await guardianExec(pot, stopTx(M, G, running.raw.delegates.list, running.raw.modules.list));
    expect((await readingOf(pot, K)).reading).toMatchObject({
      state: "stopped",
      why: "module_off",
    });
  });

  it("11. a take back of the balance plus one wei is refused (GS013) and changes nothing; exactly the balance passes and the guardian gains it", async () => {
    const held = await nativeOf(pot);
    expect(held).toBe(5n * WEI);
    const nonce = await safeNonceOf(pot);
    const tooMuch = takeBackTx(G, held + 1n);
    expect(await revertOf(G, pot, tooMuch)).toContain("GS013");
    const refused = await send(G, pot, tooMuch, { gas: EXEC_GAS });
    expect(refused.status).toBe("reverted");
    expect(await nativeOf(pot)).toBe(held);
    expect(await safeNonceOf(pot)).toBe(nonce);

    const before = await nativeOf(G);
    const r = await guardianExec(pot, takeBackTx(G, held));
    gasUsed.takeBack = r.gasUsed.toString();
    expect(await nativeOf(pot)).toBe(0n);
    const fee = r.gasUsed * r.effectiveGasPrice;
    expect((await nativeOf(G)) - before + fee).toBe(held);
    expect(await safeNonceOf(pot)).toBe(nonce + 1n);
  });

  it("12. another fallback handler reads limits_not_read (other_handler); Safe's handler set back reads stopped again", async () => {
    const setHandler = (handler: Address) =>
      execTxData(G, {
        to: pot,
        data: encodeFunctionData({
          abi: safeTxAbi,
          functionName: "setFallbackHandler",
          args: [handler],
        }),
      });
    await guardianExec(pot, setHandler(P));
    expect((await readingOf(pot, K)).reading).toMatchObject({
      state: "limits_not_read",
      problem: "other_handler",
    });
    await guardianExec(pot, setHandler(M.fallbackHandler));
    expect((await readingOf(pot, K)).reading).toMatchObject({
      state: "stopped",
      why: "module_off",
    });
  });

  it("13. the pot's approval of the key on the token reads limits_not_read (usdc_approved), even while stopped", async () => {
    await guardianExec(
      pot,
      execTxData(G, {
        to: mock,
        data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [K, 1n] }),
      }),
    );
    const { raw, reading } = await readingOf(pot, K);
    expect(raw.modules.list).toEqual([]);
    expect(raw.usdcAllowanceToAgent).toBe(1n);
    expect(reading).toMatchObject({ state: "limits_not_read", problem: "usdc_approved" });
  });

  it("14. a second owner added by the guardian reads not_the_guardians", async () => {
    await guardianExec(
      pot,
      execTxData(G, {
        to: pot,
        data: encodeFunctionData({
          abi: safeTxAbi,
          functionName: "addOwnerWithThreshold",
          args: [P, 1n],
        }),
      }),
    );
    const { raw, reading } = await readingOf(pot, K);
    expect(raw.owners).toHaveLength(2);
    expect(reading).toEqual({ state: "not_the_guardians" });
  });

  it("15. two setups of the same noted address in flight: the second reverts on the address already created, and nothing moves twice", async () => {
    const setup = setupTx(M, {
      guardian: G,
      agentWallet: A,
      token: mock,
      ceilingUnits: 50n * U,
      saltNonce: saltBase + 2n,
      fundWei: 1n * WEI,
      agentGasWei: WEI / 10n,
    });
    const guardianBefore = await nativeOf(G);
    const agentBefore = await nativeOf(A);
    await c.test.setAutomine(false);
    const hashes: Hex[] = [];
    try {
      for (let i = 0; i < 2; i += 1)
        hashes.push(
          await c.wallet.sendTransaction({
            account: G,
            chain: c.chain,
            to: setup.to,
            data: setup.data,
            value: setup.value,
            gas: SETUP_GAS,
          }),
        );
      await c.test.mine({ blocks: 1 });
    } finally {
      await c.test.setAutomine(true);
    }
    const [first, second] = await Promise.all(
      hashes.map((hash) => c.pub.waitForTransactionReceipt({ hash, pollingInterval: 50 })),
    );
    if (first === undefined || second === undefined) throw new Error("two receipts expected");
    expect(second.blockNumber).toBe(first.blockNumber);
    expect(first.status).toBe("success");
    expect(second.status).toBe("reverted");
    // Each inner call has allowFailure false: the factory's refusal of a taken address fails all.
    expect(await revertOf(G, setup.to, setup.data, setup.value)).toContain(
      "Multicall3: call failed",
    );

    expect(await nativeOf(setup.pot)).toBe(1n * WEI);
    expect((await nativeOf(A)) - agentBefore).toBe(WEI / 10n);
    const fees =
      first.gasUsed * first.effectiveGasPrice + second.gasUsed * second.effectiveGasPrice;
    expect(guardianBefore - (await nativeOf(G))).toBe(setup.value + fees);
    expect((await ceilingOf(setup.pot, A)).spentUnits).toBe(0n);
  });

  it("16. a pot switched off with disableModule alone, its key still listed after a take: the website's start again (removeDelegate first) starts a new period with nothing taken, the nonce kept", async () => {
    const setup = setupTx(M, {
      guardian: G,
      agentWallet: A,
      token: mock,
      ceilingUnits: 50n * U,
      saltNonce: saltBase + 3n,
      fundWei: 0n,
      agentGasWei: 0n,
    });
    const created = await send(G, setup.to, setup.data, { gas: SETUP_GAS });
    expect(created.status).toBe("success");
    const start = await minuteOf(created.blockNumber);
    const safe = setup.pot;
    await mint(safe, 100n * U);
    await takes(safe, A, 7n * U);
    expect(await allowanceOf(safe, A)).toEqual([50n * U, 7n * U, PERIOD, start, 2n]);

    await guardianExec(
      safe,
      execTxData(G, {
        to: safe,
        data: encodeFunctionData({
          abi: safeTxAbi,
          functionName: "disableModule",
          args: [SAFE_SENTINEL, M.allowanceModule],
        }),
      }),
    );
    const off = await readingOf(safe, A);
    expect(off.reading).toMatchObject({ state: "stopped", why: "module_off" });
    // The module still answers the key and a live-looking allowance: only the Safe's list is off.
    expect(off.raw.delegates.list).toEqual([A]);
    expect(off.raw.allowance).toEqual([50n * U, 7n * U, PERIOD, start, 2n]);
    await refusedTake(safe, A, 1n, { reason: "GS104" });

    await atMinute(start + 1_000n);
    const snapshot = await c.test.snapshot();
    // The shape without the removal, on a copy of the chain: the old period and what was taken in
    // it carry on. This is why the website's restore removes a listed key first.
    await guardianExec(
      safe,
      execTxData(G, {
        to: M.multiSendCallOnly,
        operation: OP_DELEGATECALL,
        data: multiSendData([
          enableModulePart(M),
          addDelegatePart(M, A),
          msTx(OP_CALL, M.allowanceModule, 0n, setAllowanceData(A, mock, 50n * U)),
        ]),
      }),
    );
    expect(await allowanceOf(safe, A)).toEqual([50n * U, 7n * U, PERIOD, start, 2n]);
    await c.test.revert({ id: snapshot });
    expect(await allowanceOf(safe, A)).toEqual([50n * U, 7n * U, PERIOD, start, 2n]);

    const r = await guardianExec(
      safe,
      restoreTx(M, G, {
        key: A,
        token: mock,
        ceilingUnits: 50n * U,
        delegates: off.raw.delegates.list,
        modules: off.raw.modules.list,
      }),
    );
    const mined = await minuteOf(r.blockNumber);
    expect(mined).toBe(start + 1_000n);
    expect(await allowanceOf(safe, A)).toEqual([50n * U, 0n, PERIOD, mined, 2n]);
    const fresh = await ceilingOf(safe, A);
    expect(fresh.spentUnits).toBe(0n);
    expect(fresh.periodEndsAt).toBe(Number((mined + PERIOD) * 60n));
    expect((await readingOf(safe, A)).raw.tokens).toEqual([mock]);
    await takes(safe, A, 1n * U);
  });

  it("17. a changed-key setup (Ruling R19): the noted address created for its first key with no money, then moved to the new key on the same Safe", async () => {
    const setup = setupTx(M, {
      guardian: G,
      agentWallet: A,
      token: mock,
      ceilingUnits: 50n * U,
      saltNonce: saltBase + 4n,
      fundWei: 0n,
      agentGasWei: 0n,
    });
    expect([setup.calls, setup.value]).toEqual([1, 0n]);
    const agentBefore = await nativeOf(A);
    const created = await send(G, setup.to, setup.data, { gas: SETUP_GAS });
    expect(created.status).toBe("success");
    const safe = setup.pot;
    expect(await nativeOf(safe)).toBe(0n);
    expect(await nativeOf(A)).toBe(agentBefore);
    expect((await ceilingOf(safe, A)).spentUnits).toBe(0n);

    const { raw } = await readingOf(safe, A);
    const r = await guardianExec(
      safe,
      restoreTx(M, G, {
        key: K,
        token: mock,
        ceilingUnits: 50n * U,
        delegates: raw.delegates.list,
        modules: raw.modules.list,
      }),
    );
    const now = await minuteOf(r.blockNumber);
    const moved = await ceilingOf(safe, K);
    expect(moved.ceilingUnits).toBe(50n * U);
    expect(moved.spentUnits).toBe(0n);
    expect(moved.periodEndsAt).toBe(Number((now + PERIOD) * 60n));
    expect((await readingOf(safe, A)).reading).toMatchObject({
      state: "limits_not_read",
      problem: "other_delegate",
    });
    await mint(safe, 10n * U);
    await refusedTake(safe, A, 1n);
    await takes(safe, K, 1n * U);
  });

  it("18. the note door (Ruling R22) against the fork's chain: a new address while a code-less note exists is pot_pending; once the noted pot holds code, pot_exists", async () => {
    const s = openStatementStores();
    try {
      const body = potBody(s, { tenant: G });
      expect(body.guardian.toLowerCase()).toBe(G.toLowerCase());
      if (body.agentId === null) throw new Error("a linked body without its agent");
      const registry = fakeRegistry();
      registry.wallets.set(body.agentId, A);
      const chain = new SafePotChain({
        publicClient: c.pub as unknown as PublicClient,
        addresses: REAL,
      });
      const deps = potDeps(s, {
        registry: { getAgentWallet: registry.getAgentWallet },
        chain,
        now: () => Date.now(),
      });
      // The note door recomputes with the real table: USDC is Arc's.
      const plan = (saltNonce: bigint) =>
        setupTx(REAL, {
          guardian: G,
          agentWallet: A,
          token: REAL.usdc,
          ceilingUnits: 50n * U,
          saltNonce,
          fundWei: 0n,
          agentGasWei: 0n,
        });
      const input = (address: Address, saltNonce: bigint) => ({
        address,
        saltNonce: saltNonce.toString(),
        ceilingUnits: (50n * U).toString(),
        agentWallet: A,
        declarationVersion: "pot-declaration-1",
      });
      const refusal = async (run: () => Promise<unknown>) => {
        const e = await run().then(
          () => undefined,
          (err: unknown) => err,
        );
        if (!(e instanceof ApiError)) throw new Error(`no refusal: ${messagesOf(e)}`);
        return { code: e.code, status: e.status };
      };
      const X = plan(saltBase + 5n);
      const Y = plan(saltBase + 6n);

      const noted = await declarePot(deps, G, body.legalBodyId, input(X.pot, saltBase + 5n));
      expect(noted).toMatchObject({ address: X.pot, onRecord: true });
      expect(await chain.codeHash(X.pot)).toBeNull();
      expect(
        await refusal(() => declarePot(deps, G, body.legalBodyId, input(Y.pot, saltBase + 6n))),
      ).toEqual({ code: "pot_pending", status: 409 });

      const created = await send(G, X.to, X.data, { gas: SETUP_GAS });
      expect(created.status).toBe("success");
      expect(await chain.codeHash(X.pot)).toBe(SAFE_PROXY_RUNTIME_CODE_HASH);
      expect(
        await refusal(() => declarePot(deps, G, body.legalBodyId, input(Y.pot, saltBase + 6n))),
      ).toEqual({ code: "pot_exists", status: 409 });
      expect(
        await declarePot(deps, G, body.legalBodyId, input(X.pot, saltBase + 5n)),
      ).toMatchObject({ address: X.pot, onRecord: true, declaredAt: noted.declaredAt });
      expect(new SqliteLegalBodyPotRepository(s.db).list(body.legalBodyId)).toHaveLength(1);
    } finally {
      s.db.close();
    }
  });
});
