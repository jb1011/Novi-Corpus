/**
 * The server's reads of a pot (`SafePotChain`) and the start-up check of the seven contracts'
 * code (`assertPotContracts`), over a hand-made client of `vi.fn`s: no network.
 *
 * The client answers as the real Safe of the 24 Nov run (`0x0bbB...77EF`) answered on Arc testnet,
 * read only with `cast call`, `cast code` and `cast balance`, at block 73,886,273 and again at
 * block 73,899,377 (the same answers): no module, no delegate, USDC still listed, the allowance
 * zeroed but for its nonce 3, nothing in it. The website's suite reads the same answers.
 */
import {
  type Address,
  type Hex,
  type PublicClient,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  zeroAddress,
} from "viem";
import { describe, expect, test, vi } from "vitest";
import {
  PotContractsNotVerifiedError,
  SafePotChain,
  assertPotContracts,
} from "../../../src/adapters/arc/safePotChain";
import {
  POT_CODE_HASHES,
  type PotAddresses,
  type PotRaw,
  SAFE_FALLBACK_HANDLER_SLOT,
  SAFE_GUARD_SLOT,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  SAFE_SENTINEL,
  allowanceModuleAbi,
  erc20Abi,
  potAddresses,
  potReading,
  safeAbi,
} from "../../../src/legalBody/safePot";

/** The real run of 24 Nov: the guardian, the agent's key, and the Safe it created. */
const G = "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A" as const;
const A = "0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C" as const;
const SAFE_CREATED = "0x0bbBa174c1D6b6Edd2F1A86ff5af435B645b77EF" as const;
/** An invention: another contract. */
const OTHER = "0x00000000000000000000000000000000000c0de2" as const;

const T = potAddresses(5042002) as PotAddresses;
const EXPECT = { addresses: T, guardian: G, agentWallet: A };

/** The real Safe's runtime code (171 bytes), read with `cast code` at block 73,886,273. */
const REAL_PROXY_CODE: Hex =
  "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea264697066735822122003d1488ee65e08fa41e58e888a9865554c535f2c77126a82cb4c0f917f31441364736f6c63430007060033";
const REAL_BLOCK = 73_886_273n;
/** The agent key's fee money on the real run: 0.000294 USDC. */
const REAL_AGENT_WEI = 294_000_000_000_000n;
const WORD_ZERO: Hex = `0x${"0".repeat(64)}`;
/** What the real Safe answered for its fallback handler slot: lower case, 32 bytes. */
const REAL_HANDLER_WORD: Hex = "0x000000000000000000000000fd0732dc9e303f09fcef3a7388ad10a83459ec99";

/** The real Safe as it reads today: the website's REAL_STOPPED, field for field. */
const REAL_STOPPED: PotRaw = {
  codeHash: SAFE_PROXY_RUNTIME_CODE_HASH,
  singleton: T.safeSingleton,
  owners: [G],
  threshold: 1n,
  modules: { list: [], next: SAFE_SENTINEL },
  guard: zeroAddress,
  fallbackHandler: T.fallbackHandler,
  delegates: { list: [], next: 0 },
  tokens: [T.usdc],
  allowance: [0n, 0n, 0n, 0n, 3n],
  usdcAllowanceToAgent: 0n,
  balanceUnits: 0n,
  balanceWei: 0n,
  agentBalanceWei: REAL_AGENT_WEI,
  agentHasCode: false,
};

/** The proof's healthy pot (RESULTS.md, S6): the allowance and balance the answers below give. */
const HEALTHY_ALLOWANCE = [50_000_000n, 10_000_000n, 43200n, 29919864n, 2n] as const;
const HEALTHY_UNITS = 190_000_000n;

type Contract = { address: Address; abi: unknown; functionName: string; args?: readonly unknown[] };

/** The real Safe's answers at block 73,886,273, per function (and slot). */
function realAnswer(c: Contract): unknown {
  switch (c.functionName) {
    case "masterCopy":
      return "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
    case "getOwners":
      return [G];
    case "getThreshold":
      return 1n;
    case "getModulesPaginated":
      return [[], SAFE_SENTINEL];
    case "getStorageAt":
      return c.args?.[0] === BigInt(SAFE_GUARD_SLOT) ? WORD_ZERO : REAL_HANDLER_WORD;
    case "getDelegates":
      return [[], 0];
    case "getTokens":
      return ["0x3600000000000000000000000000000000000000"];
    case "getTokenAllowance":
      return [0n, 0n, 0n, 0n, 3n];
    case "balanceOf":
      return 0n;
    case "allowance":
      return 0n;
    default:
      throw new Error(`no answer for ${c.functionName}`);
  }
}

type Read = "getBlockNumber" | "getCode" | "getBalance" | "multicall";

/** A hand-made client: the real Safe's answers, each read recorded; `answer` can be replaced. */
function fakeClient(
  over: {
    potCode?: Hex | undefined;
    agentCode?: Hex | undefined;
    answer?: (c: Contract) => unknown;
    reject?: Read;
  } = {},
) {
  const potCode = "potCode" in over ? over.potCode : REAL_PROXY_CODE;
  const agentCode = "agentCode" in over ? over.agentCode : undefined;
  const answer = over.answer ?? realAnswer;
  const fail = (name: Read) => over.reject === name;
  const client = {
    // The options are recorded by the spy: the test pins `cacheTime: 0`.
    getBlockNumber: vi.fn(async (options?: { cacheTime?: number }) => {
      void options;
      if (fail("getBlockNumber")) throw new Error("no head");
      return REAL_BLOCK;
    }),
    getCode: vi.fn(async (p: { address: Address; blockNumber?: bigint }) => {
      if (fail("getCode")) throw new Error("no code read");
      return p.address.toLowerCase() === SAFE_CREATED.toLowerCase() ? potCode : agentCode;
    }),
    getBalance: vi.fn(async (p: { address: Address; blockNumber?: bigint }) => {
      if (fail("getBalance")) throw new Error("no balance read");
      return p.address.toLowerCase() === SAFE_CREATED.toLowerCase() ? 0n : REAL_AGENT_WEI;
    }),
    multicall: vi.fn(
      async (p: {
        contracts: readonly Contract[];
        allowFailure: false;
        multicallAddress: Address;
        blockNumber?: bigint;
      }) => {
        // As viem's own multicall does: each call encoded against its fragment, each address
        // checked (a mixed case that is not the checksum is refused).
        if (!isAddress(p.multicallAddress)) throw new Error("bad multicall address");
        for (const c of p.contracts) {
          if (!isAddress(c.address)) throw new Error("bad target");
          encodeFunctionData(c as Parameters<typeof encodeFunctionData>[0]);
        }
        if (fail("multicall")) throw new Error("a call reverted");
        return p.contracts.map(answer);
      },
    ),
  };
  const chain = new SafePotChain({ publicClient: client as unknown as PublicClient, addresses: T });
  return { client, chain };
}

/** Every read the client was asked for, but the head's. */
const readsOf = (client: ReturnType<typeof fakeClient>["client"]) => [
  ...client.getCode.mock.calls,
  ...client.getBalance.mock.calls,
  ...client.multicall.mock.calls,
];

const WHERE = { pot: SAFE_CREATED, agentWallet: A };

/** A PotRaw of a pot that has no proxy's code: only the code hash says anything. */
const EMPTY_REST = {
  singleton: zeroAddress,
  owners: [],
  threshold: 0n,
  modules: { list: [], next: zeroAddress },
  guard: zeroAddress,
  fallbackHandler: zeroAddress,
  delegates: { list: [], next: 0 },
  tokens: [],
  allowance: [0n, 0n, 0n, 0n, 0n],
  usdcAllowanceToAgent: 0n,
  balanceUnits: 0n,
  balanceWei: 0n,
  agentBalanceWei: 0n,
  agentHasCode: false,
};

describe("SafePotChain.readPot: the server's read of a pot, at one block", () => {
  test("the real Safe reads as it stands, and its reading is stopped, module_off", async () => {
    const { client, chain } = fakeClient();
    const raw = await chain.readPot(WHERE);
    expect(raw).toEqual(REAL_STOPPED);
    expect(potReading(raw, EXPECT)).toEqual({
      state: "stopped",
      why: "module_off",
      balanceUnits: 0n,
    });
    expect(client.multicall).toHaveBeenCalledTimes(1);
    expect(client.getCode).toHaveBeenCalledTimes(2);
    expect(client.getBalance).toHaveBeenCalledTimes(2);
  });

  test("with no block asked, the latest block number is read once, fresh, and every read is at it", async () => {
    const { client, chain } = fakeClient();
    await chain.readPot(WHERE);
    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
    // Fresh: viem otherwise serves a cached block number for its polling interval, and a read
    // right after the guardian's own transaction could see an older block.
    expect(client.getBlockNumber).toHaveBeenCalledWith({ cacheTime: 0 });
    const reads = readsOf(client);
    expect(reads).toHaveLength(5);
    for (const [p] of reads) expect(p.blockNumber).toBe(REAL_BLOCK);
  });

  test("every read carries the block number asked for, and the head is not read", async () => {
    const { client, chain } = fakeClient();
    const asked = 70_000_001n;
    await chain.readPot({ ...WHERE, blockNumber: asked });
    expect(client.getBlockNumber).not.toHaveBeenCalled();
    const reads = readsOf(client);
    expect(reads).toHaveLength(5);
    for (const [p] of reads) expect(p.blockNumber).toBe(asked);
  });

  test("one multicall through the table's Multicall3, failures not allowed, with the reads the real run made", async () => {
    const { client, chain } = fakeClient();
    await chain.readPot(WHERE);
    const p = client.multicall.mock.calls[0]?.[0];
    if (p === undefined) throw new Error("no multicall");
    expect(p.multicallAddress).toBe(T.multicall3);
    expect(p.multicallAddress).toBe("0xcA11bde05977b3631167028862bE2a173976CA11");
    expect(p.allowFailure).toBe(false);
    const asked = p.contracts.map((c) => ({
      address: c.address,
      functionName: c.functionName,
      args: c.args ?? [],
    }));
    expect(asked).toEqual([
      { address: SAFE_CREATED, functionName: "masterCopy", args: [] },
      { address: SAFE_CREATED, functionName: "getOwners", args: [] },
      { address: SAFE_CREATED, functionName: "getThreshold", args: [] },
      {
        address: SAFE_CREATED,
        functionName: "getModulesPaginated",
        args: [SAFE_SENTINEL, 10n],
      },
      {
        address: SAFE_CREATED,
        functionName: "getStorageAt",
        args: [BigInt(SAFE_GUARD_SLOT), 1n],
      },
      {
        address: SAFE_CREATED,
        functionName: "getStorageAt",
        args: [BigInt(SAFE_FALLBACK_HANDLER_SLOT), 1n],
      },
      { address: T.allowanceModule, functionName: "getDelegates", args: [SAFE_CREATED, 0, 10] },
      { address: T.allowanceModule, functionName: "getTokens", args: [SAFE_CREATED, A] },
      {
        address: T.allowanceModule,
        functionName: "getTokenAllowance",
        args: [SAFE_CREATED, A, T.usdc],
      },
      { address: T.usdc, functionName: "balanceOf", args: [SAFE_CREATED] },
      { address: T.usdc, functionName: "allowance", args: [SAFE_CREATED, A] },
    ]);
    // Each against its pinned fragment.
    for (const c of p.contracts.slice(0, 6)) expect(c.abi).toBe(safeAbi);
    for (const c of p.contracts.slice(6, 9)) expect(c.abi).toBe(allowanceModuleAbi);
    for (const c of p.contracts.slice(9)) expect(c.abi).toBe(erc20Abi);
    // The balances and the code, of the pot and of the agent's wallet.
    expect(client.getBalance.mock.calls.map(([q]) => q.address)).toEqual([SAFE_CREATED, A]);
    expect(client.getCode.mock.calls.map(([q]) => q.address)).toEqual([SAFE_CREATED, A]);
  });

  test("no code answers codeHash null and makes no other read", async () => {
    for (const potCode of [undefined, "0x" as Hex]) {
      const { client, chain } = fakeClient({ potCode });
      expect(await chain.readPot(WHERE)).toEqual({ codeHash: null, ...EMPTY_REST });
      expect(client.getCode).toHaveBeenCalledTimes(1);
      expect(client.getCode.mock.calls[0]?.[0]).toEqual({
        address: SAFE_CREATED,
        blockNumber: REAL_BLOCK,
      });
      expect(client.multicall).not.toHaveBeenCalled();
      expect(client.getBalance).not.toHaveBeenCalled();
      expect(potReading(await chain.readPot(WHERE), EXPECT)).toEqual({ state: "absent" });
    }
  });

  test("code that is not the proxy's answers its hash and makes no other read", async () => {
    const { client, chain } = fakeClient({ potCode: "0x1234" });
    const raw = await chain.readPot(WHERE);
    expect(raw).toEqual({ codeHash: keccak256("0x1234"), ...EMPTY_REST });
    expect(potReading(raw, EXPECT)).toEqual({ state: "not_the_guardians" });
    expect(client.getCode).toHaveBeenCalledTimes(1);
    expect(client.multicall).not.toHaveBeenCalled();
    expect(client.getBalance).not.toHaveBeenCalled();
  });

  test("a healthy pot's answers read back, and a delegated key's code reads as code", async () => {
    const healthyAnswer = (c: Contract): unknown => {
      switch (c.functionName) {
        case "getModulesPaginated":
          return [[T.allowanceModule], SAFE_SENTINEL];
        case "getDelegates":
          return [[A], 0];
        case "getTokenAllowance":
          return HEALTHY_ALLOWANCE;
        case "balanceOf":
          return HEALTHY_UNITS;
        default:
          return realAnswer(c);
      }
    };
    const { chain } = fakeClient({
      answer: healthyAnswer,
      agentCode: "0xef01002ddcf8da463526614b9fa5e87db259a3bf06667c",
    });
    const raw = await chain.readPot(WHERE);
    expect(raw.modules).toEqual({ list: [T.allowanceModule], next: SAFE_SENTINEL });
    expect(raw.delegates).toEqual({ list: [A], next: 0 });
    expect(raw.allowance).toEqual(HEALTHY_ALLOWANCE);
    expect(raw.agentHasCode).toBe(true);
    expect(potReading(raw, EXPECT)).toEqual({
      state: "ceiling_read",
      ceilingUnits: 50_000_000n,
      spentUnits: 10_000_000n,
      periodEndsAt: (29919864 + 43200) * 60,
      nonce: 2n,
      balanceUnits: HEALTHY_UNITS,
    });
  });

  test("addresses in any letter case: the reads send them checksummed and read the same", async () => {
    const upper = (x: Address) => `0x${x.slice(2).toUpperCase()}` as Address;
    const lowerTable = Object.fromEntries(
      Object.entries(T).map(([k, v]) => [k, v.toLowerCase()]),
    ) as PotAddresses;
    const { client } = fakeClient();
    const chain = new SafePotChain({
      publicClient: client as unknown as PublicClient,
      addresses: lowerTable,
    });
    const raw = await chain.readPot({
      pot: SAFE_CREATED.toLowerCase() as Address,
      agentWallet: upper(A),
    });
    expect(raw).toEqual(REAL_STOPPED);
    const p = client.multicall.mock.calls[0]?.[0];
    if (p === undefined) throw new Error("no multicall");
    expect(p.multicallAddress).toBe(T.multicall3);
    expect(p.contracts.map((c) => c.address)).toEqual([
      ...Array(6).fill(SAFE_CREATED),
      ...Array(3).fill(T.allowanceModule),
      T.usdc,
      T.usdc,
    ]);
    expect(p.contracts[7]?.args).toEqual([SAFE_CREATED, A]);
    expect(p.contracts[8]?.args).toEqual([SAFE_CREATED, A, T.usdc]);
    expect(client.getCode.mock.calls.map(([q]) => q.address)).toEqual([SAFE_CREATED, A]);
    expect(client.getBalance.mock.calls.map(([q]) => q.address)).toEqual([SAFE_CREATED, A]);
  });

  test("the guard and the handler are the last 20 bytes of their 32-byte words; any other word rejects", async () => {
    const withWords = (guard: Hex, handler: Hex) => (c: Contract) =>
      c.functionName === "getStorageAt"
        ? c.args?.[0] === BigInt(SAFE_GUARD_SLOT)
          ? guard
          : handler
        : realAnswer(c);
    const guardWord: Hex = `0x${"0".repeat(24)}${OTHER.slice(2)}`;
    const set = await fakeClient({ answer: withWords(guardWord, REAL_HANDLER_WORD) }).chain.readPot(
      WHERE,
    );
    expect(set.guard).toBe(getAddress(OTHER));
    expect(set.fallbackHandler).toBe(T.fallbackHandler);
    expect(potReading(set, EXPECT)).toEqual({
      state: "limits_not_read",
      problem: "guard_set",
      balanceUnits: 0n,
    });

    // Not 32 bytes, or a word with something above its last 20 bytes: not an address.
    const bad: Hex[] = [
      "0x",
      `0x${"0".repeat(62)}`,
      `0x${"0".repeat(66)}`,
      `0x01${"0".repeat(22)}${OTHER.slice(2)}`,
      `0x${"0".repeat(23)}1${OTHER.slice(2)}`,
    ];
    for (const word of bad) {
      await expect(
        fakeClient({ answer: withWords(word, REAL_HANDLER_WORD) }).chain.readPot(WHERE),
      ).rejects.toThrow();
      await expect(
        fakeClient({ answer: withWords(WORD_ZERO, word) }).chain.readPot(WHERE),
      ).rejects.toThrow();
    }
  });

  test("a rejected read rejects: a failure is never an answer", async () => {
    for (const reject of ["getBlockNumber", "getCode", "getBalance", "multicall"] as const) {
      await expect(fakeClient({ reject }).chain.readPot(WHERE)).rejects.toThrow();
    }
  });
});

describe("SafePotChain.codeHash: keccak256 of the code at the latest block", () => {
  test("null for 0x and for undefined, and no other read", async () => {
    for (const potCode of [undefined, "0x" as Hex]) {
      const { client, chain } = fakeClient({ potCode });
      expect(await chain.codeHash(SAFE_CREATED)).toBeNull();
      expect(client.getCode).toHaveBeenCalledTimes(1);
      expect(client.getBlockNumber).not.toHaveBeenCalled();
      expect(client.multicall).not.toHaveBeenCalled();
      expect(client.getBalance).not.toHaveBeenCalled();
    }
  });

  test("code 0x1234 answers keccak256 of it, read at the latest block, and makes no other read", async () => {
    const { client, chain } = fakeClient({ potCode: "0x1234" });
    expect(await chain.codeHash(SAFE_CREATED)).toBe(keccak256("0x1234"));
    expect(client.getCode).toHaveBeenCalledTimes(1);
    expect(client.getCode.mock.calls[0]?.[0]).toEqual({ address: SAFE_CREATED });
    expect(client.getBlockNumber).not.toHaveBeenCalled();
    expect(client.multicall).not.toHaveBeenCalled();
    expect(client.getBalance).not.toHaveBeenCalled();
  });

  test("the real Safe's code hashes to the proxy's, the address taken in any letter case", async () => {
    const { client, chain } = fakeClient();
    expect(await chain.codeHash(SAFE_CREATED.toLowerCase() as Address)).toBe(
      SAFE_PROXY_RUNTIME_CODE_HASH,
    );
    expect(client.getCode.mock.calls[0]?.[0]).toEqual({ address: SAFE_CREATED });
  });

  test("a rejected read rejects", async () => {
    await expect(fakeClient({ reject: "getCode" }).chain.codeHash(SAFE_CREATED)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// The start-up check
// ---------------------------------------------------------------------------------------------

const NAMES = Object.keys(T) as (keyof PotAddresses)[];

/** A different invented code for each of the seven, and the record of their hashes. */
const FAKE_CODES = Object.fromEntries(
  NAMES.map((name, i) => [name, `0x60${(i + 1).toString(16).padStart(2, "0")}` as Hex]),
) as Record<keyof PotAddresses, Hex>;
const FAKE_HASHES = Object.fromEntries(
  NAMES.map((name) => [name, keccak256(FAKE_CODES[name])]),
) as Record<keyof PotAddresses, Hex>;

/** A client whose getCode answers `codes` by address, or rejects for the addresses in `fails`. */
function codeClient(
  codes: Partial<Record<keyof PotAddresses, Hex | undefined>>,
  fails = new Set<string>(),
) {
  const byAddress = new Map(NAMES.map((name) => [T[name].toLowerCase(), name]));
  const getCode = vi.fn(async (p: { address: Address; blockNumber?: bigint }) => {
    const name = byAddress.get(p.address.toLowerCase());
    if (name === undefined) throw new Error(`not a pot contract: ${p.address}`);
    if (fails.has(name)) throw new Error("the node did not answer");
    return codes[name];
  });
  return { getCode, client: { getCode } as unknown as Pick<PublicClient, "getCode"> };
}

/** What `assertPotContracts` threw, or a failure when it did not. */
async function refusalOf(p: Promise<void>): Promise<PotContractsNotVerifiedError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PotContractsNotVerifiedError);
    return e as PotContractsNotVerifiedError;
  }
  throw new Error("assertPotContracts did not throw");
}

describe("assertPotContracts: the seven contracts hold the pinned code", () => {
  test("the seven codes, each with the hash pinned for it: passes, one getCode per address at the latest block", async () => {
    const { client, getCode } = codeClient(FAKE_CODES);
    await expect(assertPotContracts(client, T, FAKE_HASHES)).resolves.toBeUndefined();
    expect(getCode).toHaveBeenCalledTimes(7);
    expect(getCode.mock.calls.map(([p]) => p)).toEqual(NAMES.map((name) => ({ address: T[name] })));
  });

  test("hashes are compared in lower case", async () => {
    const upperHashes = Object.fromEntries(
      NAMES.map((name) => [name, `0x${FAKE_HASHES[name].slice(2).toUpperCase()}`]),
    ) as Record<keyof PotAddresses, Hex>;
    await expect(
      assertPotContracts(codeClient(FAKE_CODES).client, T, upperHashes),
    ).resolves.toBeUndefined();
  });

  test("one code changed: a mismatch naming that contract, its address and the two hashes", async () => {
    for (const name of NAMES) {
      const codes = { ...FAKE_CODES, [name]: "0x6099" as Hex };
      const e = await refusalOf(assertPotContracts(codeClient(codes).client, T, FAKE_HASHES));
      expect(e.reason).toBe("mismatch");
      expect(e.contract).toBe(name);
      expect(e.address).toBe(T[name]);
      expect(e.expected).toBe(FAKE_HASHES[name]);
      expect(e.actual).toBe(keccak256("0x6099"));
      expect(e.message).toContain(name);
      expect(e.message).toContain(T[name]);
      expect(e.message).toContain(FAKE_HASHES[name]);
      expect(e.message).toContain(keccak256("0x6099"));
    }
  });

  test("one address with no code: a mismatch, with no hash read", async () => {
    for (const code of [undefined, "0x" as Hex]) {
      const codes = { ...FAKE_CODES, allowanceModule: code };
      const e = await refusalOf(assertPotContracts(codeClient(codes).client, T, FAKE_HASHES));
      expect(e.reason).toBe("mismatch");
      expect(e.contract).toBe("allowanceModule");
      expect(e.address).toBe(T.allowanceModule);
      expect(e.actual).toBeNull();
      expect(e.message).toContain("allowanceModule");
      expect(e.message).toContain(T.allowanceModule);
      expect(e.message).toContain(FAKE_HASHES.allowanceModule);
    }
  });

  test("a rejected getCode: unreadable, naming the contract, the node's error kept as the cause", async () => {
    const e = await refusalOf(
      assertPotContracts(codeClient(FAKE_CODES, new Set(["usdc"])).client, T, FAKE_HASHES),
    );
    expect(e.reason).toBe("unreadable");
    expect(e.contract).toBe("usdc");
    expect(e.address).toBe(T.usdc);
    expect((e.cause as Error).message).toBe("the node did not answer");
  });

  test("an answer that is not code is unreadable too, never a pass", async () => {
    // A number, a string that is not hex, half a byte: none is hashed as if it were code.
    for (const answer of [12345, "not code", "0x123", "0xzz"]) {
      const codes = { ...FAKE_CODES, multicall3: answer as unknown as Hex };
      const e = await refusalOf(assertPotContracts(codeClient(codes).client, T, FAKE_HASHES));
      expect(e.reason, String(answer)).toBe("unreadable");
      expect(e.contract).toBe("multicall3");
    }
  });

  test("a contract with other code is reported before one that could not be read", async () => {
    const codes = { ...FAKE_CODES, usdc: "0x6099" as Hex };
    const e = await refusalOf(
      assertPotContracts(codeClient(codes, new Set(["safeSingleton"])).client, T, FAKE_HASHES),
    );
    expect(e.reason).toBe("mismatch");
    expect(e.contract).toBe("usdc");
  });

  test("a hashes record without a contract's hash never passes", async () => {
    const { usdc: _left, ...six } = FAKE_HASHES;
    void _left;
    const e = await refusalOf(
      assertPotContracts(
        codeClient(FAKE_CODES).client,
        T,
        six as unknown as Record<keyof PotAddresses, Hex>,
      ),
    );
    expect(e.reason).toBe("mismatch");
    expect(e.contract).toBe("usdc");
  });

  test("by default the pinned hashes of the table are the ones compared", async () => {
    expect(POT_CODE_HASHES.safeSingleton).toBe(
      "0xb1f926978a0f44a2c0ec8fe822418ae969bd8c3f18d61e5103100339894f81ff",
    );
    const e = await refusalOf(assertPotContracts(codeClient(FAKE_CODES).client, T));
    expect(e.reason).toBe("mismatch");
    expect(e.contract).toBe("safeSingleton");
    expect(e.expected).toBe(POT_CODE_HASHES.safeSingleton);
  });

  test("the error is one named class, whose reason says which", () => {
    const e = new PotContractsNotVerifiedError({
      reason: "unreadable",
      contract: "usdc",
      address: T.usdc,
    });
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("PotContractsNotVerifiedError");
    expect(e.reason).toBe("unreadable");
  });
});
