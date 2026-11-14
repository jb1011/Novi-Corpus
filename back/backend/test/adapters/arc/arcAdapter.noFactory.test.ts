/**
 * A Minimal-only deployment builds the adapter with no full-product factory. Creating an entity
 * must then fail by name, before anything is simulated or sent, and every read that never touches
 * the factory must keep working (the legal-body surfaces and the standing reads use them).
 */
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { expect, test, vi } from "vitest";
import {
  ArcAdapter,
  type CreateEntityParams,
  FullProductDisabledError,
} from "../../../src/adapters/arc/arcAdapter";

const REGISTRY = "0x0000000000000000000000000000000000000002" as Address;
const CONTROLLER = "0x4819000000000000000000000000000000000000" as Address;
const PROXY = "0x0000000000000000000000000000000000000abc" as Address;
const TX = `0x${"ab".repeat(32)}` as Hex;

function adapter() {
  const publicClient = {
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => {
      if (functionName === "status") return 0;
      throw new Error(`unexpected read ${functionName}`);
    }),
    simulateContract: vi.fn(),
    waitForTransactionReceipt: vi.fn(),
    estimateGas: vi.fn(),
  };
  const managerWallet = { sendTransaction: vi.fn(), writeContract: vi.fn() };
  const arc = new ArcAdapter({
    publicClient: publicClient as unknown as PublicClient,
    managerWallet: managerWallet as unknown as WalletClient,
    chainId: 5042002,
    identityRegistry: REGISTRY,
    controller: CONTROLLER,
  });
  return { arc, publicClient, managerWallet };
}

const params = {
  manager: CONTROLLER,
  guardian: CONTROLLER,
  operator: CONTROLLER,
  amendmentDelay: 172_800n,
  metadataURI: "ipfs://x",
  ein: "00-0000000",
  formationDate: 0,
  operatingAgreementHash: TX,
  treasury: {
    usdc: REGISTRY,
    payoutAddress: CONTROLLER,
    cap: 1n,
    period: 1n,
    allowlistEnabled: false,
  },
} as unknown as CreateEntityParams;

test("broadcastCreateEntity throws FullProductDisabledError and sends nothing", async () => {
  const { arc, publicClient, managerWallet } = adapter();
  const err = await arc.broadcastCreateEntity(params).catch((e) => e);
  expect(err).toBeInstanceOf(FullProductDisabledError);
  expect(err.message).toBe("the full product is off on this deployment: FACTORY_ADDRESS is unset");
  expect(publicClient.simulateContract).not.toHaveBeenCalled();
  expect(publicClient.estimateGas).not.toHaveBeenCalled();
  expect(managerWallet.sendTransaction).not.toHaveBeenCalled();
  expect(managerWallet.writeContract).not.toHaveBeenCalled();
});

test("confirmCreateEntity and createEntity throw FullProductDisabledError before reading a receipt", async () => {
  const { arc, publicClient } = adapter();
  await expect(arc.confirmCreateEntity(TX, CONTROLLER)).rejects.toBeInstanceOf(
    FullProductDisabledError,
  );
  await expect(arc.createEntity(params)).rejects.toBeInstanceOf(FullProductDisabledError);
  expect(publicClient.waitForTransactionReceipt).not.toHaveBeenCalled();
});

test("reads that never touch the factory still work", async () => {
  const { arc } = adapter();
  await expect(arc.legalStatus(PROXY)).resolves.toBe(0);
  expect(arc.identityRegistry).toBe(REGISTRY);
  expect(arc.chainId).toBe(5042002);
});
