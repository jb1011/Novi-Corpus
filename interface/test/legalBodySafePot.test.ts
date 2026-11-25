/**
 * The company's pot, as bytes: the per-chain table, the pinned fragments against the signatures of
 * the script proven on Arc testnet on 24 Nov, and every transaction the website builds pinned to
 * the vectors of the plan (V1 to V15). V1, V2, V7 and V8 are bytes mined on Arc testnet; the rest
 * were computed with the same encoders. A vector that stops reproducing is a stop, never a new
 * expected value.
 */
import { describe, expect, test } from "vitest";
import {
  concat,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  size,
  slice,
  toBytes,
  zeroAddress,
} from "viem";
import {
  allowanceModuleAbi,
  erc20Abi,
  formatUsdcUnits,
  multicall3Abi,
  multiSendAbi,
  multiSendPart,
  ownerApprovalSignature,
  parseCeilingUsdc,
  parseUsdcAmount,
  POT_AGENT_GAS_DEFAULT,
  POT_AGENT_GAS_MAX_UNITS,
  POT_CEILING_MAX_USDC,
  POT_EXEC_GAS_CAP,
  POT_FEE_LOW_WEI,
  POT_FUND_MAX_UNITS,
  POT_PERIOD_MINUTES,
  POT_SETUP_GAS_CAP,
  POT_TAKE_GAS,
  POT_TRANSFER_GAS_CAP,
  potAddresses,
  potChangeArgs,
  potInitializer,
  potRestoreArgs,
  potRestoreParts,
  potSetupCalls,
  potStopArgs,
  potStopParts,
  potWithdrawArgs,
  PotBuildError,
  predictPotAddress,
  SAFE_FALLBACK_HANDLER_SLOT,
  SAFE_GUARD_SLOT,
  SAFE_PROXY_INIT_CODE_HASH,
  SAFE_PROXY_RUNTIME_CODE_HASH,
  SAFE_SENTINEL,
  safeAbi,
  safeProxyFactoryAbi,
  unitsToWei,
  USDC_UNIT,
  WEI_PER_UNIT,
  type PotAddresses,
  type PotSetup,
  type SafeExecArgs,
} from "@/lib/legalBody/safePot";
import type { Address, Hex } from "@/lib/api/types";

/** The real run of 24 Nov on Arc testnet: the guardian, the agent's key, the payee (also the "new
 *  key" of V12 and V13), the salt nonce, and the Safe it created. */
const G = "0x15D4EE6F84b6bf8ceE5A24cCb19FDF8257c22b0A" as const;
const A = "0x2dDcf8da463526614b9FA5E87Db259a3Bf06667C" as const;
const P = "0xE886e729CC5C43bE28642827C4e72e660A83C7E8" as const;
const SALT = BigInt("72231338869903870587851170785833461215");
const SAFE_CREATED = "0x0bbBa174c1D6b6Edd2F1A86ff5af435B645b77EF" as const;
/** An invention: some other Safe module. */
const OTHER_MODULE = "0x00000000000000000000000000000000000c0de1" as const;

const T = potAddresses(5042002) as PotAddresses;
const ZERO = BigInt(0);

/** V1's pot: a two-USDC ceiling over five minutes, as the real run set it. */
const V1: PotSetup = {
  guardian: G,
  agentWallet: A,
  token: T.usdc,
  ceilingUnits: BigInt(2_000_000),
  periodMinutes: 5,
};
/** V3's pot: 50 USDC in each thirty-day period. */
const V3: PotSetup = { ...V1, ceilingUnits: BigInt(50_000_000), periodMinutes: 43200 };

const exec = (args: SafeExecArgs): Hex =>
  encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args });

const pinned = (data: Hex, bytes: number, hash: Hex) => {
  expect(size(data)).toBe(bytes);
  expect(keccak256(data)).toBe(hash);
};

type Part = { operation: number; to: Address; value: bigint; data: Hex };

/** A MultiSend batch read back: operation (1 byte), to (20), value (32), length (32), data. */
function splitParts(transactions: Hex): Part[] {
  const parts: Part[] = [];
  let at = 0;
  const total = size(transactions);
  while (at < total) {
    const operation = Number(BigInt(slice(transactions, at, at + 1)));
    const to = getAddress(slice(transactions, at + 1, at + 21));
    const value = BigInt(slice(transactions, at + 21, at + 53));
    const length = Number(BigInt(slice(transactions, at + 53, at + 85)));
    const data = length === 0 ? "0x" : slice(transactions, at + 85, at + 85 + length);
    parts.push({ operation, to, value, data });
    at += 85 + length;
  }
  return parts;
}

/** The parts inside a `multiSend(bytes)` call. */
function partsOfMultiSend(data: Hex): Part[] {
  const call = decodeFunctionData({ abi: multiSendAbi, data });
  return splitParts(call.args[0]);
}

/** The parts of the batch a Safe's `setup` hands to MultiSendCallOnly. */
function partsOfInitializer(init: Hex): Part[] {
  const call = decodeFunctionData({ abi: safeAbi, data: init });
  if (call.functionName !== "setup") throw new Error("not a setup");
  return partsOfMultiSend(call.args[3]);
}

const decodeModuleCall = (data: Hex) => decodeFunctionData({ abi: allowanceModuleAbi, data });
const decodeSafeCall = (data: Hex) => decodeFunctionData({ abi: safeAbi, data });

describe("the addresses and the pinned values", () => {
  test("the table knows Arc mainnet and testnet with the same addresses, and no other chain", () => {
    expect(potAddresses(5042)).toEqual(potAddresses(5042002));
    expect(potAddresses(5042002)?.multiSendCallOnly).toBe(
      "0xA83c336B20401Af773B6219BA5027174338D1836",
    );
    expect(potAddresses(1)).toBeNull();
    expect(potAddresses(0)).toBeNull();
    expect(T).toEqual({
      safeSingleton: "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762",
      proxyFactory: "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67",
      fallbackHandler: "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99",
      multiSendCallOnly: "0xA83c336B20401Af773B6219BA5027174338D1836",
      allowanceModule: "0xAA46724893dedD72658219405185Fb0Fc91e091C",
      multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
      usdc: "0x3600000000000000000000000000000000000000",
    });
  });

  test("a caller that changes its copy of the table does not change the next answer", () => {
    const mine = potAddresses(5042002) as PotAddresses;
    mine.allowanceModule = OTHER_MODULE;
    expect(potAddresses(5042002)?.allowanceModule).toBe(
      "0xAA46724893dedD72658219405185Fb0Fc91e091C",
    );
  });

  test("the constants are the plan's", () => {
    expect(POT_PERIOD_MINUTES).toBe(43200);
    expect(POT_PERIOD_MINUTES).toBe(30 * 24 * 60);
    expect(USDC_UNIT).toBe(BigInt(1_000_000));
    expect(WEI_PER_UNIT).toBe(BigInt(1_000_000_000_000));
    expect(USDC_UNIT * WEI_PER_UNIT).toBe(BigInt("1000000000000000000"));
    expect(POT_CEILING_MAX_USDC).toBe(3_000_000_000);
    expect(POT_FUND_MAX_UNITS).toBe(BigInt(1_000_000_000) * USDC_UNIT);
    expect(POT_AGENT_GAS_MAX_UNITS).toBe(USDC_UNIT);
    expect(POT_AGENT_GAS_DEFAULT).toBe("0.1");
    expect(POT_SETUP_GAS_CAP).toBe(BigInt(1_500_000));
    expect(POT_EXEC_GAS_CAP).toBe(BigInt(500_000));
    expect(POT_TRANSFER_GAS_CAP).toBe(BigInt(120_000));
    expect(POT_TAKE_GAS).toBe(200_000);
    expect(POT_FEE_LOW_WEI).toBe(BigInt("10000000000000000"));
    // The low mark: 200,000 gas at 50 gwei.
    expect(POT_FEE_LOW_WEI).toBe(BigInt(POT_TAKE_GAS) * BigInt(50_000_000_000));
  });

  test("Safe's sentinel, its two storage slots and the proxy's two code hashes", () => {
    expect(SAFE_SENTINEL).toBe("0x0000000000000000000000000000000000000001");
    expect(SAFE_GUARD_SLOT).toBe(
      "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8",
    );
    expect(keccak256(toBytes("guard_manager.guard.address"))).toBe(SAFE_GUARD_SLOT);
    expect(SAFE_FALLBACK_HANDLER_SLOT).toBe(
      "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5",
    );
    expect(keccak256(toBytes("fallback_manager.handler.address"))).toBe(
      SAFE_FALLBACK_HANDLER_SLOT,
    );
    expect(SAFE_PROXY_INIT_CODE_HASH).toBe(
      "0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee",
    );
    expect(SAFE_PROXY_RUNTIME_CODE_HASH).toBe(
      "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c",
    );
  });
});

describe("the pinned fragments", () => {
  test("each is the script's signatures, member for member, and nothing else", () => {
    expect(multicall3Abi).toEqual(
      parseAbi([
        "struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }",
        "struct Result { bool success; bytes returnData; }",
        "function aggregate3Value(Call3Value[] calls) payable returns (Result[] returnData)",
      ]),
    );
    expect(safeProxyFactoryAbi).toEqual(
      parseAbi([
        "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
      ]),
    );
    expect(safeAbi).toEqual(
      parseAbi([
        "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
        "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
        "function enableModule(address module)",
        "function disableModule(address prevModule, address module)",
        "function getOwners() view returns (address[])",
        "function getThreshold() view returns (uint256)",
        "function getModulesPaginated(address start, uint256 pageSize) view returns (address[] array, address next)",
        "function getStorageAt(uint256 offset, uint256 length) view returns (bytes)",
        "function masterCopy() view returns (address)",
      ]),
    );
    expect(multiSendAbi).toEqual(parseAbi(["function multiSend(bytes transactions) payable"]));
    expect(allowanceModuleAbi).toEqual(
      parseAbi([
        "function addDelegate(address delegate)",
        "function removeDelegate(address delegate, bool removeAllowances)",
        "function deleteAllowance(address delegate, address token)",
        "function setAllowance(address delegate, address token, uint96 allowanceAmount, uint16 resetTimeMin, uint32 resetBaseMin)",
        "function executeAllowanceTransfer(address safe, address token, address to, uint96 amount, address paymentToken, uint96 payment, address delegate, bytes signature)",
        "function getDelegates(address safe, uint48 start, uint8 pageSize) view returns (address[] results, uint48 next)",
        "function getTokens(address safe, address delegate) view returns (address[])",
        "function getTokenAllowance(address safe, address delegate, address token) view returns (uint256[5])",
      ]),
    );
    expect(erc20Abi).toEqual(
      parseAbi([
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address _owner, address _spender) view returns (uint256 remaining)",
        "function transfer(address _to, uint256 _value) returns (bool success)",
      ]),
    );
  });

  test("V7: the agent's take over the module's fragment is the take mined in the real run", () => {
    const data = encodeFunctionData({
      abi: allowanceModuleAbi,
      functionName: "executeAllowanceTransfer",
      args: [SAFE_CREATED, T.usdc, P, BigInt(1_000_000), zeroAddress, ZERO, A, "0x"],
    });
    pinned(data, 292, "0xdfe8f8bded62c4439e5dc86fdb9f39258afb89a2a0c10a65383c15ae626c24ec");
  });

  test("V14 add money and V15 send fee money: USDC transfer over the ERC-20 fragment", () => {
    pinned(
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [SAFE_CREATED, BigInt(5_000_000)],
      }),
      68,
      "0x6269aa34f7e2541c8a744afcb67cfe5d56fe010b0019d20866a2d1ae6bd4e168",
    );
    pinned(
      encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [A, BigInt(100_000)] }),
      68,
      "0x81c73e55a126dfa49b01a558cb943527c09e803ac8ae17fa26f2b84a6532ab10",
    );
  });
});

describe("the setup", () => {
  test("V1: the initializer and the address of the Safe the real run created", () => {
    const init = potInitializer(T, V1);
    pinned(init, 964, "0x85e9c6994c94c27dde9801c8bc7e3ad95b8453d2ff43dc8955d666184b4526d8");
    expect(predictPotAddress(T, init, SALT)).toBe(SAFE_CREATED);
  });

  test("V2: the setup equals the transaction mined on Arc testnet, byte for byte", () => {
    const s = potSetupCalls(T, {
      ...V1,
      saltNonce: SALT,
      fundWei: BigInt("5000000000000000000"),
      agentGasWei: BigInt("100000000000000000"),
    });
    const data = encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3Value",
      args: [s.calls],
    });
    pinned(data, 1796, "0x4b7b3d40ad68c749c0fd423f03c816f5a96bc6d48bdcdb48adcb292327340ad4");
    expect(s.value).toBe(BigInt("5100000000000000000"));
    expect(s.pot).toBe(SAFE_CREATED);
    expect(s.calls).toHaveLength(3);
    expect(s.calls[0].target).toBe(T.proxyFactory);
    expect(s.calls[1].target).toBe(s.pot);
    expect(s.calls[2].target).toBe(A);
    expect(s.calls.map((c) => c.allowFailure)).toEqual([false, false, false]);
  });

  test("V3: thirty days, the initializer and its address with salt nonce 1", () => {
    const init = potInitializer(T, V3);
    pinned(init, 964, "0x42ac0798ddc35bae68b07cc36a195960f5673107db1bcfa8a23c20153cef753a");
    expect(predictPotAddress(T, init, BigInt(1))).toBe(
      "0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D",
    );
  });

  test("V4: with no money the setup is one call, the Safe's creation, and carries no value", () => {
    const s = potSetupCalls(T, { ...V3, saltNonce: BigInt(1), fundWei: ZERO, agentGasWei: ZERO });
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].target).toBe(T.proxyFactory);
    expect(s.calls[0].value).toBe(ZERO);
    expect(s.value).toBe(ZERO);
    expect(s.pot).toBe("0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D");
    pinned(
      encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3Value", args: [s.calls] }),
      1412,
      "0x50c45965c858bc26d42cfe3d36b6a90e33a0dca0a984b03af5e41112a9d23e73",
    );
  });

  test("V5: with money the setup is three calls: create, fund the Safe, give the agent fee money", () => {
    const s = potSetupCalls(T, {
      ...V3,
      saltNonce: BigInt(1),
      fundWei: BigInt("60000000000000000000"),
      agentGasWei: BigInt("100000000000000000"),
    });
    expect(s.calls).toHaveLength(3);
    expect(s.calls[1]).toEqual({
      target: s.pot,
      allowFailure: false,
      value: BigInt("60000000000000000000"),
      callData: "0x",
    });
    expect(s.calls[2]).toEqual({
      target: A,
      allowFailure: false,
      value: BigInt("100000000000000000"),
      callData: "0x",
    });
    expect(s.value).toBe(BigInt("60100000000000000000"));
    pinned(
      encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3Value", args: [s.calls] }),
      1796,
      "0xb5141445053d556060d1ea2ca1cb75be1d85193cc326b949272fff21238a772d",
    );
  });

  test("a call worth 0 is left out: money for the Safe alone, or fee money alone", () => {
    const fundOnly = potSetupCalls(T, {
      ...V3,
      saltNonce: BigInt(1),
      fundWei: BigInt(7),
      agentGasWei: ZERO,
    });
    expect(fundOnly.calls.map((c) => c.target)).toEqual([T.proxyFactory, fundOnly.pot]);
    expect(fundOnly.value).toBe(BigInt(7));
    const gasOnly = potSetupCalls(T, {
      ...V3,
      saltNonce: BigInt(1),
      fundWei: ZERO,
      agentGasWei: BigInt(9),
    });
    expect(gasOnly.calls.map((c) => c.target)).toEqual([T.proxyFactory, A]);
    expect(gasOnly.value).toBe(BigInt(9));
  });

  test("the Safe's creation call names the singleton, the initializer and the salt nonce", () => {
    const s = potSetupCalls(T, { ...V3, saltNonce: BigInt(1), fundWei: ZERO, agentGasWei: ZERO });
    const call = decodeFunctionData({ abi: safeProxyFactoryAbi, data: s.calls[0].callData });
    expect(call.functionName).toBe("createProxyWithNonce");
    expect(call.args[0]).toBe(T.safeSingleton);
    expect(call.args[1]).toBe(potInitializer(T, V3));
    expect(call.args[2]).toBe(BigInt(1));
  });

  test("the initializer: the guardian alone, threshold 1, the batch to MultiSendCallOnly, the handler, no payment", () => {
    const call = decodeSafeCall(potInitializer(T, V3));
    expect(call.functionName).toBe("setup");
    if (call.functionName !== "setup") return;
    const [owners, threshold, to, , fallbackHandler, paymentToken, payment, paymentReceiver] =
      call.args;
    expect(owners).toEqual([G]);
    expect(threshold).toBe(BigInt(1));
    expect(to).toBe(T.multiSendCallOnly);
    expect(fallbackHandler).toBe(T.fallbackHandler);
    expect(paymentToken).toBe(zeroAddress);
    expect(payment).toBe(ZERO);
    expect(paymentReceiver).toBe(zeroAddress);
  });

  test("the first inner call of the setup is enableModule sent to the zero address, never to the Safe's own address", () => {
    const init = potInitializer(T, V3);
    const pot = predictPotAddress(T, init, BigInt(1));
    const parts = partsOfInitializer(init);
    expect(parts).toHaveLength(3);
    expect(parts.map((p) => p.operation)).toEqual([0, 0, 0]);
    expect(parts.map((p) => p.value)).toEqual([ZERO, ZERO, ZERO]);
    expect(parts[0].to).toBe(zeroAddress);
    expect(parts[0].to).not.toBe(pot);
    const enable = decodeSafeCall(parts[0].data);
    expect(enable.functionName).toBe("enableModule");
    expect(enable.args).toEqual([T.allowanceModule]);
    expect(parts[1].to).toBe(T.allowanceModule);
    expect(decodeModuleCall(parts[1].data)).toMatchObject({
      functionName: "addDelegate",
      args: [A],
    });
    expect(parts[2].to).toBe(T.allowanceModule);
    expect(decodeModuleCall(parts[2].data)).toMatchObject({
      functionName: "setAllowance",
      args: [A, T.usdc, BigInt(50_000_000), 43200, 0],
    });
  });

  test("addresses in any letter case give the same bytes", () => {
    const lower: PotSetup = {
      ...V3,
      guardian: G.toLowerCase() as Address,
      agentWallet: A.toLowerCase() as Address,
    };
    expect(potInitializer(T, lower)).toBe(potInitializer(T, V3));
    const low = Object.fromEntries(
      Object.entries(T).map(([k, v]) => [k, v.toLowerCase()]),
    ) as PotAddresses;
    expect(predictPotAddress(low, potInitializer(low, V3), BigInt(1))).toBe(
      "0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D",
    );
    expect(exec(potChangeArgs(low, lower))).toBe(exec(potChangeArgs(T, V3)));
  });
});

describe("the setup is built only from the pinned Safe, and with no amount below 0", () => {
  /** What `f` threw, or undefined. */
  const thrown = (f: () => unknown): unknown => {
    try {
      f();
    } catch (e) {
      return e;
    }
    return undefined;
  };
  const setup = { ...V3, saltNonce: BigInt(1), fundWei: BigInt(5), agentGasWei: BigInt(7) };
  const init = potInitializer(T, V3);

  test("another singleton: potSetupCalls and predictPotAddress throw PotBuildError, other_singleton", () => {
    // The creation would run another singleton at another address, and the money would go to the
    // address predicted for the pinned one.
    const other: PotAddresses = { ...T, safeSingleton: OTHER_MODULE };
    for (const f of [() => potSetupCalls(other, setup), () => predictPotAddress(other, init, BigInt(1))]) {
      const e = thrown(f);
      expect(e).toBeInstanceOf(PotBuildError);
      expect(e).toBeInstanceOf(Error);
      expect(e).toMatchObject({ name: "PotBuildError", problem: "other_singleton" });
    }
  });

  test("another proxy factory: potSetupCalls and predictPotAddress throw PotBuildError, other_proxy_factory", () => {
    const other: PotAddresses = { ...T, proxyFactory: OTHER_MODULE };
    for (const f of [() => potSetupCalls(other, setup), () => predictPotAddress(other, init, BigInt(1))]) {
      expect(thrown(f)).toMatchObject({ name: "PotBuildError", problem: "other_proxy_factory" });
    }
  });

  test("the pinned singleton and factory in another letter case are the pinned ones", () => {
    const loud: PotAddresses = {
      ...T,
      safeSingleton: T.safeSingleton.toLowerCase() as Address,
      proxyFactory: `0x${T.proxyFactory.slice(2).toUpperCase()}` as Address,
    };
    expect(potSetupCalls(loud, setup)).toEqual(potSetupCalls(T, setup));
    expect(predictPotAddress(loud, init, BigInt(1))).toBe("0x4A13bC20E8596009CA37B897Aaf654C5e0b8e87D");
  });

  test("money for the pot, or fee money, below 0: PotBuildError, negative_amount, before viem sees it", () => {
    for (const p of [
      { ...setup, fundWei: BigInt(-1) },
      { ...setup, agentGasWei: BigInt(-1) },
      { ...setup, fundWei: BigInt(-5), agentGasWei: BigInt(5) },
    ]) {
      const e = thrown(() => potSetupCalls(T, p));
      expect(e).toBeInstanceOf(PotBuildError);
      expect(e).toMatchObject({ name: "PotBuildError", problem: "negative_amount" });
    }
    // 0 is no money, never a refusal.
    expect(potSetupCalls(T, { ...setup, fundWei: ZERO, agentGasWei: ZERO }).calls).toHaveLength(1);
  });
});

describe("the guardian's transactions on a running or stopped pot", () => {
  test("V6 change, V9 stop, V10 take back: each encodes to its vector over safeAbi execTransaction", () => {
    pinned(
      exec(potChangeArgs(T, { ...V3, ceilingUnits: BigInt(20_000_000) })),
      676,
      "0xc615b5f6bca36df97bbcb1f78c3a6a5f5a4cfb3c0f932d529192511423f01944",
    );
    const stop = potStopArgs(T, { guardian: G, delegates: [A], modules: [T.allowanceModule] });
    expect(stop).not.toBeNull();
    pinned(
      exec(stop as SafeExecArgs),
      900,
      "0xd709c6dfd342e50a6df9859f5063de95552f967b76c3281224a69a8c93507324",
    );
    pinned(
      exec(potWithdrawArgs({ guardian: G, balanceWei: BigInt("3000000000000000000") })),
      484,
      "0xce7031830a444423e2440b3aa34c5e9bfd41e6606641d3deb24abb35961dd164",
    );
  });

  test("the change is a plain call to the module, with nothing but setAllowance and no value", () => {
    const [to, value, data, operation, safeTxGas, baseGas, gasPrice, gasToken, refund, sig] =
      potChangeArgs(T, V3);
    expect(to).toBe(T.allowanceModule);
    expect(value).toBe(ZERO);
    expect(operation).toBe(0);
    expect([safeTxGas, baseGas, gasPrice]).toEqual([ZERO, ZERO, ZERO]);
    expect([gasToken, refund]).toEqual([zeroAddress, zeroAddress]);
    expect(sig).toBe(ownerApprovalSignature(G));
    expect(decodeModuleCall(data)).toMatchObject({
      functionName: "setAllowance",
      args: [A, T.usdc, BigInt(50_000_000), 43200, 0],
    });
  });

  test("the take back is a plain call to the guardian with the value and no data", () => {
    const [to, value, data, operation, , , , , , sig] = potWithdrawArgs({
      guardian: G,
      balanceWei: BigInt(42),
    });
    expect(to).toBe(G);
    expect(value).toBe(BigInt(42));
    expect(data).toBe("0x");
    expect(operation).toBe(0);
    expect(sig).toBe(ownerApprovalSignature(G));
  });

  test("V8: the stop's two parts followed by multiSendPart(G, 3e18, 0x) are the stop mined in the real run", () => {
    const parts = potStopParts(T, { delegates: [A], modules: [T.allowanceModule] });
    expect(parts).toHaveLength(2);
    const batch = encodeFunctionData({
      abi: multiSendAbi,
      functionName: "multiSend",
      args: [concat([...parts, multiSendPart(G, BigInt("3000000000000000000"), "0x")])],
    });
    const args: SafeExecArgs = [
      T.multiSendCallOnly,
      ZERO,
      batch,
      1,
      ZERO,
      ZERO,
      ZERO,
      zeroAddress,
      zeroAddress,
      ownerApprovalSignature(G),
    ];
    pinned(exec(args), 996, "0x43295b119f07566ccf07dbaf49fb1046f985141bcda180da375bf706c3087a83");
  });

  test("the stop: every delegate removed with its allowances, then the module disabled after the sentinel, sent to the zero address", () => {
    const parts = splitParts(
      concat(potStopParts(T, { delegates: [A, P], modules: [T.allowanceModule] })),
    );
    expect(parts.map((p) => p.to)).toEqual([T.allowanceModule, T.allowanceModule, zeroAddress]);
    expect(decodeModuleCall(parts[0].data)).toMatchObject({
      functionName: "removeDelegate",
      args: [A, true],
    });
    expect(decodeModuleCall(parts[1].data)).toMatchObject({
      functionName: "removeDelegate",
      args: [P, true],
    });
    expect(decodeSafeCall(parts[2].data)).toMatchObject({
      functionName: "disableModule",
      args: [SAFE_SENTINEL, T.allowanceModule],
    });
  });

  test("the stop's transaction is a delegatecall to MultiSendCallOnly, signed by the guardian, with no value", () => {
    const stop = potStopArgs(T, {
      guardian: G,
      delegates: [A],
      modules: [T.allowanceModule],
    }) as SafeExecArgs;
    const [to, value, data, operation, , , , , , sig] = stop;
    expect(to).toBe(T.multiSendCallOnly);
    expect(value).toBe(ZERO);
    expect(operation).toBe(1);
    expect(sig).toBe(ownerApprovalSignature(G));
    expect(partsOfMultiSend(data)).toHaveLength(2);
  });

  test("a module that is second in the list is disabled after the one before it, not after the sentinel", () => {
    const parts = potStopParts(T, { delegates: [], modules: [OTHER_MODULE, T.allowanceModule] });
    expect(parts).toHaveLength(1);
    const [only] = splitParts(parts[0]);
    expect(only.to).toBe(zeroAddress);
    expect(decodeSafeCall(only.data)).toMatchObject({
      functionName: "disableModule",
      args: [getAddress(OTHER_MODULE), T.allowanceModule],
    });
    // Ours first, another after it: the sentinel comes before ours.
    const [first] = splitParts(
      potStopParts(T, { delegates: [], modules: [T.allowanceModule, OTHER_MODULE] })[0],
    );
    expect(decodeSafeCall(first.data)).toMatchObject({
      functionName: "disableModule",
      args: [SAFE_SENTINEL, T.allowanceModule],
    });
  });

  test("the stop leaves another module alone, and finds ours in any letter case", () => {
    expect(potStopParts(T, { delegates: [], modules: [OTHER_MODULE] })).toEqual([]);
    expect(
      potStopParts(T, {
        delegates: [],
        modules: [T.allowanceModule.toLowerCase() as Address],
      }),
    ).toHaveLength(1);
  });

  test("V11 start again, V12 new key on a running pot, V13 new key on a stopped pot: each encodes to its vector", () => {
    const v11 = potRestoreArgs(T, { ...V3, delegates: [], modules: [] });
    expect(v11).not.toBeNull();
    pinned(
      exec(v11 as SafeExecArgs),
      1092,
      "0x86747b4dd8d72f104246417a357650d86a7dd380fef6a438545ae98b453fdb76",
    );
    const v12 = potRestoreArgs(T, {
      ...V3,
      agentWallet: P,
      delegates: [A],
      modules: [T.allowanceModule],
    });
    expect(v12).not.toBeNull();
    pinned(
      exec(v12 as SafeExecArgs),
      1124,
      "0xf8652af05b7d90febd332989e7aa09032325dac7467a629f72dc61fb28bed50c",
    );
    const v13 = potRestoreArgs(T, { ...V3, agentWallet: P, delegates: [], modules: [] });
    expect(v13).not.toBeNull();
    pinned(
      exec(v13 as SafeExecArgs),
      1092,
      "0x80154523980e27f1c18cdd015aedbfb47a427bc92292b88995879b2373401c12",
    );
  });

  test("V16 start again with the key itself still listed (removeDelegate first), and V17 a restore of an unlisted key with leftovers (deleteAllowance first): each encodes to its vector", () => {
    const v16 = potRestoreArgs(T, { ...V3, delegates: [A], modules: [], clearAllowance: false });
    pinned(
      exec(v16 as SafeExecArgs),
      1252,
      "0x5cc5e16da50f1eaa12fa7f4a415b509af88d67e05b494e1fb809035362871c1f",
    );
    // A listed key's allowance goes with its removal: the flag adds nothing for it.
    expect(potRestoreArgs(T, { ...V3, delegates: [A], modules: [], clearAllowance: true })).toEqual(v16);
    const v17 = potRestoreArgs(T, {
      ...V3,
      delegates: [],
      modules: [T.allowanceModule],
      clearAllowance: true,
    });
    pinned(
      exec(v17 as SafeExecArgs),
      1124,
      "0x5df83fef2cd3e804490975a21e4f0eef03d743e6c8c799fbff13906b8d90959a",
    );
    const parts = splitParts(
      concat(
        potRestoreParts(T, { ...V3, delegates: [], modules: [T.allowanceModule], clearAllowance: true }) as Hex[],
      ),
    );
    expect(parts.map((p) => decodeModuleCall(p.data).functionName)).toEqual([
      "deleteAllowance",
      "addDelegate",
      "setAllowance",
    ]);
    expect(decodeModuleCall(parts[0].data)).toMatchObject({ args: [A, T.usdc] });
  });

  test("Ruling R35: the deleteAllowance part comes only for an unlisted key with leftovers, after the removals and the module, before addDelegate; V11 to V13 are unchanged by a false flag", () => {
    // A stopped pot (module off) whose key was removed elsewhere with its allowance kept.
    const stopped = potRestoreParts(T, { ...V3, delegates: [], modules: [], clearAllowance: true }) as Hex[];
    const stoppedParts = stopped.map((p) => splitParts(p)[0]);
    expect(stoppedParts.map((p) => p.to)).toEqual([
      zeroAddress,
      T.allowanceModule,
      T.allowanceModule,
      T.allowanceModule,
    ]);
    expect(decodeSafeCall(stoppedParts[0].data)).toMatchObject({ functionName: "enableModule" });
    expect(decodeModuleCall(stoppedParts[1].data)).toMatchObject({ functionName: "deleteAllowance", args: [A, T.usdc] });
    // A new key P, unlisted, with leftovers, while the old key A is listed: A removed first.
    const moved = potRestoreParts(T, {
      ...V3,
      agentWallet: P,
      delegates: [A],
      modules: [T.allowanceModule],
      clearAllowance: true,
    }) as Hex[];
    expect(moved.map((p) => decodeModuleCall(splitParts(p)[0].data))).toMatchObject([
      { functionName: "removeDelegate", args: [A, true] },
      { functionName: "deleteAllowance", args: [P, T.usdc] },
      { functionName: "addDelegate", args: [P] },
      { functionName: "setAllowance" },
    ]);
    // A false flag, or none, is the restore as before: V11 to V13 byte for byte.
    for (const clearAllowance of [false, undefined]) {
      const v11 = potRestoreArgs(T, { ...V3, delegates: [], modules: [], clearAllowance });
      pinned(exec(v11 as SafeExecArgs), 1092, "0x86747b4dd8d72f104246417a357650d86a7dd380fef6a438545ae98b453fdb76");
      const v12 = potRestoreArgs(T, { ...V3, agentWallet: P, delegates: [A], modules: [T.allowanceModule], clearAllowance });
      pinned(exec(v12 as SafeExecArgs), 1124, "0xf8652af05b7d90febd332989e7aa09032325dac7467a629f72dc61fb28bed50c");
      const v13 = potRestoreArgs(T, { ...V3, agentWallet: P, delegates: [], modules: [], clearAllowance });
      pinned(exec(v13 as SafeExecArgs), 1092, "0x80154523980e27f1c18cdd015aedbfb47a427bc92292b88995879b2373401c12");
    }
  });

  test("the restore's order: remove the old key, enable the module when it is off, add the key, set the ceiling", () => {
    const parts = splitParts(
      concat(potRestoreParts(T, { ...V3, agentWallet: P, delegates: [A], modules: [] }) as Hex[]),
    );
    expect(parts.map((p) => p.to)).toEqual([
      T.allowanceModule,
      zeroAddress,
      T.allowanceModule,
      T.allowanceModule,
    ]);
    expect(decodeModuleCall(parts[0].data)).toMatchObject({
      functionName: "removeDelegate",
      args: [A, true],
    });
    expect(decodeSafeCall(parts[1].data)).toMatchObject({
      functionName: "enableModule",
      args: [T.allowanceModule],
    });
    expect(decodeModuleCall(parts[2].data)).toMatchObject({
      functionName: "addDelegate",
      args: [P],
    });
    expect(decodeModuleCall(parts[3].data)).toMatchObject({
      functionName: "setAllowance",
      args: [P, T.usdc, BigInt(50_000_000), 43200, 0],
    });
  });

  test("restore removes a listed delegate that is the agent's wallet first, so its allowance starts a fresh period; and is null when modules hold another module, alone or beside ours", () => {
    // A pot stopped elsewhere by switching the add-on off alone keeps its key listed, with its old
    // period and what was taken in it. Removed with its allowances, then added and set again, the
    // key starts a new period at the minute the restore is mined, with nothing taken.
    const listed = potRestoreParts(T, {
      ...V3,
      delegates: [A.toLowerCase() as Address],
      modules: [],
    }) as Hex[];
    const parts = listed.map((p) => splitParts(p)[0]);
    expect(parts.map((p) => p.to)).toEqual([T.allowanceModule, zeroAddress, T.allowanceModule, T.allowanceModule]);
    expect(decodeModuleCall(parts[0].data)).toMatchObject({ functionName: "removeDelegate", args: [A, true] });
    expect(decodeSafeCall(parts[1].data)).toMatchObject({ functionName: "enableModule" });
    expect(decodeModuleCall(parts[2].data)).toMatchObject({ functionName: "addDelegate", args: [A] });
    expect(decodeModuleCall(parts[3].data)).toMatchObject({
      functionName: "setAllowance",
      args: [A, T.usdc, BigInt(50_000_000), 43200, 0],
    });
    // The add-on still on: the same, without enabling it again.
    const on = potRestoreParts(T, { ...V3, delegates: [A], modules: [T.allowanceModule] }) as Hex[];
    expect(on.map((p) => decodeModuleCall(splitParts(p)[0].data).functionName)).toEqual([
      "removeDelegate",
      "addDelegate",
      "setAllowance",
    ]);
    // Every listed key goes, the agent's wallet among them, in the order listed.
    const mixed = potRestoreParts(T, {
      ...V3,
      delegates: [P, A],
      modules: [T.allowanceModule],
    }) as Hex[];
    const mixedParts = mixed.map((p) => decodeModuleCall(splitParts(p)[0].data));
    expect(mixedParts.map((c) => c.functionName)).toEqual([
      "removeDelegate",
      "removeDelegate",
      "addDelegate",
      "setAllowance",
    ]);
    expect(mixedParts[0]).toMatchObject({ args: [P, true] });
    expect(mixedParts[1]).toMatchObject({ args: [A, true] });

    const others: Address[][] = [
      [OTHER_MODULE],
      [OTHER_MODULE, T.allowanceModule],
      [T.allowanceModule, OTHER_MODULE],
      [T.allowanceModule, T.allowanceModule],
    ];
    for (const modules of others) {
      expect(potRestoreParts(T, { ...V3, delegates: [], modules })).toBeNull();
      expect(potRestoreArgs(T, { ...V3, delegates: [], modules })).toBeNull();
    }
  });

  test("the restore's transaction is a delegatecall to MultiSendCallOnly signed by the guardian", () => {
    const [to, value, , operation, , , , , , sig] = potRestoreArgs(T, {
      ...V3,
      delegates: [],
      modules: [],
    }) as SafeExecArgs;
    expect(to).toBe(T.multiSendCallOnly);
    expect(value).toBe(ZERO);
    expect(operation).toBe(1);
    expect(sig).toBe(ownerApprovalSignature(G));
  });

  test("the stop and the restore carry no value in any part; the stop is null with no delegate and no module", () => {
    const batches: Hex[][] = [
      potStopParts(T, { delegates: [A, P], modules: [OTHER_MODULE, T.allowanceModule] }),
      potRestoreParts(T, { ...V3, delegates: [A, P], modules: [] }) as Hex[],
      potRestoreParts(T, { ...V3, delegates: [P], modules: [T.allowanceModule] }) as Hex[],
    ];
    for (const batch of batches) {
      expect(batch.length).toBeGreaterThan(0);
      for (const part of batch) {
        const read = splitParts(part);
        expect(read).toHaveLength(1);
        expect(read[0].operation).toBe(0);
        expect(read[0].value).toBe(ZERO);
      }
    }
    expect(potStopParts(T, { delegates: [], modules: [] })).toEqual([]);
    expect(potStopArgs(T, { guardian: G, delegates: [], modules: [] })).toBeNull();
    expect(potStopArgs(T, { guardian: G, delegates: [], modules: [OTHER_MODULE] })).toBeNull();
  });

  test("multiSendPart packs operation 0, the address, the value, the length and the bytes", () => {
    const part = multiSendPart(G, BigInt(5), "0xabcd");
    expect(size(part)).toBe(1 + 20 + 32 + 32 + 2);
    expect(splitParts(part)).toEqual([{ operation: 0, to: G, value: BigInt(5), data: "0xabcd" }]);
    expect(part).toBe(part.toLowerCase());
  });

  test("the owner's approval: the owner as a 32-byte word, 32 zero bytes, then 0x01", () => {
    const sig = ownerApprovalSignature(G);
    expect(size(sig)).toBe(65);
    expect(sig).toBe(`0x${"0".repeat(24)}${G.slice(2).toLowerCase()}${"0".repeat(64)}01`);
    expect(ownerApprovalSignature(G.toLowerCase() as Address)).toBe(sig);
  });
});

describe("the amounts a person types", () => {
  test("parseCeilingUsdc: '' empty; '2.5', '1e3', ' 2', '-1' not_whole; '0' zero; '3000000001' too_large; '2' is 2000000 units", () => {
    expect(parseCeilingUsdc("")).toEqual({ problem: "empty" });
    for (const raw of ["2.5", "1e3", " 2", "2 ", "-1", "+1", "1,000", "0x10", "2.", "abc"]) {
      expect(parseCeilingUsdc(raw)).toEqual({ problem: "not_whole" });
    }
    expect(parseCeilingUsdc("0")).toEqual({ problem: "zero" });
    expect(parseCeilingUsdc("000")).toEqual({ problem: "zero" });
    expect(parseCeilingUsdc("3000000001")).toEqual({ problem: "too_large" });
    expect(parseCeilingUsdc("99999999999999999999999999")).toEqual({ problem: "too_large" });
    expect(parseCeilingUsdc("2")).toBe(BigInt(2_000_000));
    expect(parseCeilingUsdc("1")).toBe(USDC_UNIT);
    expect(parseCeilingUsdc("3000000000")).toBe(BigInt(3_000_000_000) * USDC_UNIT);
  });

  test("parseUsdcAmount: '' is 0; '5.1' is 5100000; '0.000001' is 1; '0.0000001' too_precise; 'abc', '1,5', '.5.' not_amount; above the maximum too_large", () => {
    const max = POT_FUND_MAX_UNITS;
    expect(parseUsdcAmount("", max)).toBe(ZERO);
    expect(parseUsdcAmount("5.1", max)).toBe(BigInt(5_100_000));
    expect(parseUsdcAmount("0.000001", max)).toBe(BigInt(1));
    expect(parseUsdcAmount("60", max)).toBe(BigInt(60_000_000));
    expect(parseUsdcAmount(".5", max)).toBe(BigInt(500_000));
    expect(parseUsdcAmount("5.", max)).toBe(BigInt(5_000_000));
    expect(parseUsdcAmount("0", max)).toBe(ZERO);
    expect(parseUsdcAmount("0.0000001", max)).toEqual({ problem: "too_precise" });
    expect(parseUsdcAmount("1.1000000", max)).toEqual({ problem: "too_precise" });
    for (const raw of ["abc", "1,5", ".5.", ".", " 1", "1 ", "-1", "+1", "1e3", "0x10", "1..5"]) {
      expect(parseUsdcAmount(raw, max)).toEqual({ problem: "not_amount" });
    }
    expect(parseUsdcAmount("1000000000", max)).toBe(max);
    expect(parseUsdcAmount("1000000000.000001", max)).toEqual({ problem: "too_large" });
    expect(parseUsdcAmount("1", POT_AGENT_GAS_MAX_UNITS)).toBe(USDC_UNIT);
    expect(parseUsdcAmount("1.000001", POT_AGENT_GAS_MAX_UNITS)).toEqual({ problem: "too_large" });
    expect(parseUsdcAmount(POT_AGENT_GAS_DEFAULT, POT_AGENT_GAS_MAX_UNITS)).toBe(
      BigInt(100_000),
    );
  });

  test("unitsToWei('5.1' in units) is 5100000000000000000, and formatUsdcUnits reads it back as '5.1'", () => {
    const units = parseUsdcAmount("5.1", POT_FUND_MAX_UNITS) as bigint;
    expect(unitsToWei(units)).toBe(BigInt("5100000000000000000"));
    expect(formatUsdcUnits(units)).toBe("5.1");
    expect(formatUsdcUnits(BigInt(2_000_000))).toBe("2");
    expect(formatUsdcUnits(BigInt(1))).toBe("0.000001");
    expect(formatUsdcUnits(ZERO)).toBe("0");
    expect(formatUsdcUnits(BigInt(50_000_000))).toBe("50");
    expect(unitsToWei(BigInt(1))).toBe(WEI_PER_UNIT);
  });
});
