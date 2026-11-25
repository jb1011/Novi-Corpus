"use client";

import { useEffect, useRef, useState } from "react";
import { useConnection, usePublicClient } from "wagmi";
import { Callout } from "@/components/onboarding/primitives";
import { useAllowedWrite, useReadOrderPotNow, useWalletNow } from "@/lib/api/legalBodyHooks";
import type { Address, LegalBodyOrderView, OrderPotView } from "@/lib/api/types";
import { readAgentWallet } from "@/lib/legalBody/agentWallet";
import { allowedCall, identityRegistryAbi, potTransferCall } from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY, fillCopy } from "@/lib/legalBody/copy";
import { REGISTER_RECEIPT_TIMEOUT_MS } from "@/lib/legalBody/identity";
import { stepLifetime } from "@/lib/legalBody/lifetime";
import { pointerTxStage } from "@/lib/legalBody/pointer";
import {
  POT_AGENT_GAS_DEFAULT,
  POT_TRANSFER_GAS_CAP,
  potAddresses,
  type PotAddresses,
} from "@/lib/legalBody/safePot";
import { potReading, readPotRaw, type PotRaw } from "@/lib/legalBody/safePotRules";
import {
  potTransferAmount,
  potTransferDoneView,
  potTransferFailureView,
  potTransferSendLabel,
  runPotTransfer,
  type PotReadAgain,
  type PotTransfer,
  type PotTransferStage,
} from "@/lib/legalBody/safePotActions";
import {
  potFeeLines,
  potProblemSentence,
  potRefusalSentence,
  potSendPreflight,
} from "@/lib/legalBody/safePotStep";
import type { LegalBodyStepKit } from "./LegalBodyFlow";
import { PotActionPanel, PotActionResultPanel, PotAmountField, type PotCardLock } from "./PotPanels";

const POT = LEGAL_BODY_COPY.pot;

type Client = NonNullable<ReturnType<typeof usePublicClient>>;

const TITLES: Readonly<Record<PotTransfer, string>> = {
  add_money: POT.addMoneyTitle,
  fee_money: POT.feeMoneyTitle,
};
/** Each field as the card opens: nothing for the pot, 0.1 USDC of fee money proposed. */
const START: Readonly<Record<PotTransfer, string>> = {
  add_money: "",
  fee_money: POT_AGENT_GAS_DEFAULT,
};
const ORDER: readonly PotTransfer[] = ["add_money", "fee_money"];

/**
 * The pot's two USDC transfers, each its own panel with one transaction the guardian sends:
 * "Add money" (to the noted pot, only while it is on the record and reads its ceiling or reads
 * stopped) and "Send fee money" (to the agent's key, a plain key, at most 1 USDC), shown beside
 * what the key holds for its fees and the low mark's warning. Each is `transfer` on the table's
 * USDC in units, never a value.
 *
 * The panels are drawn from the done page's reads (`agentWallet`, `raw`). A click never builds
 * from them: it reads the registry's key, the pot for it at a fresh block and the guardian's
 * balance again, and for Add money the noted pot from the server (`runPotTransfer`), and builds
 * its transfer from THAT read. Fee money goes only to the key its panel names (Ruling R23 applied
 * to money): the click refuses another, and the card reads again. Then the page's checks, the
 * allowlist on the exact request, the simulation and the estimate from the guardian with no fee
 * field, the account connected now, and only then the wallet. After the receipt the pot and the
 * key are read again against the click's key, and `onChanged` reads the done page's pot again.
 *
 * Nothing is read or sent on mount. The amounts typed live in this panel's state only, never in a
 * browser store. A click's continuation stops after its next await once the card is gone.
 */
export function PotMoney({
  kit,
  order,
  noted,
  agentWallet: shownWallet,
  raw: shownRaw,
  offered,
  lock,
  onChanged,
}: {
  kit: LegalBodyStepKit;
  order: LegalBodyOrderView;
  /** The noted pot, which holds the pot's code. */
  noted: OrderPotView;
  /** The record's agent wallet, the one the card's reading was made for. */
  agentWallet: Address;
  raw: PotRaw;
  /** The transfers the card's reading offers (`potReadingView`). */
  offered: readonly PotTransfer[];
  /** The card's one lock, the done page's: one action of the card at a time (Ruling R25). */
  lock: PotCardLock;
  /** Reads the noted pot, its reading and the record again. */
  onChanged: () => void;
}) {
  const { config, tenant } = kit;
  const guardian = order.guardian;
  const say = { environment: config.environment, guardian };
  const publicClient = usePublicClient({ chainId: config.chainId });
  const { address, chainId: walletChainId } = useConnection();
  const connected = (address ?? null) as Address | null;
  const writeAllowed = useAllowedWrite();
  // The connected account at the moment of asking, never the click's.
  const walletNow = useWalletNow();
  // `GET /pot`, a request made in the click.
  const readPotNow = useReadOrderPotNow(order.id);

  // On screen from the effect below, gone at its cleanup.
  const [life] = useState(() => stepLifetime());
  useEffect(() => {
    life.begin();
    return () => life.end();
  }, [life]);
  const latestOnChanged = useRef(onChanged);
  useEffect(() => {
    latestOnChanged.current = onChanged;
  });

  const [amounts, setAmounts] = useState<Record<PotTransfer, string>>({ ...START });
  const [amountProblems, setAmountProblems] = useState<Partial<Record<PotTransfer, string>>>({});
  const [stage, setStage] = useState<PotTransferStage>({ at: "idle" });
  // This component's own click in flight (its spinner). The card's lock (`lock.busy`) disables
  // every action of the card while any one of them is in flight (Ruling R25).
  const [busy, setBusy] = useState(false);

  const a = potAddresses(config.chainId);

  function editAmount(kind: PotTransfer, typed: string) {
    setAmounts((m) => ({ ...m, [kind]: typed }));
    setAmountProblems((p) => ({ ...p, [kind]: undefined }));
  }

  /** The registry's agent wallet for this identity, read now: "unreadable" when the read failed. */
  function readRegistry(client: Client, agentId: string) {
    return readAgentWallet(() =>
      client.readContract({
        address: config.identityRegistry,
        abi: identityRegistryAbi,
        functionName: "getAgentWallet",
        args: [BigInt(agentId)],
      }),
    );
  }

  function refusedHere(kind: PotTransfer, line: string) {
    setStage({ at: "problem", action: kind, lines: [line], hash: null, again: null });
  }

  /** One transfer's click: its amount checked, then `runPotTransfer` over this click's own reads. */
  async function onTransfer(kind: PotTransfer) {
    if (lock.held()) return;
    const amount = potTransferAmount(kind, amounts[kind]);
    if (!amount.ok) {
      setAmountProblems((p) => ({ ...p, [kind]: amount.sentence }));
      return;
    }
    setAmountProblems({});
    const client = publicClient;
    const agentId = order.agentId;
    if (!client || a === null) {
      refusedHere(kind, potRefusalSentence("chain_not_configured", say));
      return;
    }
    if (agentId === null) {
      refusedHere(kind, potProblemSentence({ problem: "refused" }));
      return;
    }
    if (!lock.take()) return;
    setBusy(true);
    // Until the wallet opens: the click's reads, the checks, the simulation and the estimate.
    setStage({ at: "checking", action: kind });
    try {
      // The key the fee money panel names goes in only to be compared: the transfer is built from
      // the click's own read of the registry, and refused unless the two are the same.
      const shown = { pot: noted.address, guardian, shownAgentWallet: shownWallet, amountUnits: amount.amountUnits };
      const result = await runPotTransfer(kind, shown, {
        alive: () => life.alive(),
        read: async () => {
          const [wallet, guardianBalanceWei] = await Promise.all([
            readRegistry(client, agentId),
            client.getBalance({ address: guardian }),
          ]);
          if (wallet === "none" || wallet === "unreadable")
            return { agentWallet: wallet, raw: null, reading: null, guardianBalanceWei };
          const fresh = await readPotRaw(client, a, { pot: noted.address, agentWallet: wallet });
          return {
            agentWallet: wallet,
            raw: fresh,
            reading: potReading(fresh, { addresses: a, guardian, agentWallet: wallet }),
            guardianBalanceWei,
          };
        },
        readNoted: () => readPotNow(),
        preflight: () =>
          potSendPreflight({
            order,
            tenant,
            connected,
            walletChainId,
            chainId: config.chainId,
            guardian,
          }),
        // The exact request the allowlist takes: a context it refuses reaches nothing.
        check: (ctx) => {
          const req = potTransferCall(config, ctx, POT_TRANSFER_GAS_CAP);
          if ("ok" in req) return req;
          const allowed = allowedCall(req, { config, order, pot: ctx });
          return allowed.ok ? { ok: true, call: { to: req.address, data: allowed.data } } : allowed;
        },
        simulate: async (call) =>
          (await client.call({ account: guardian, to: call.to, data: call.data })).data ?? "0x",
        estimate: (call) => client.estimateGas({ account: guardian, to: call.to, data: call.data }),
        readBalance: () => client.getBalance({ address: guardian }),
        account: () => walletNow().address,
        send: (ctx, gas) => {
          const req = potTransferCall(config, ctx, gas);
          if ("ok" in req) return Promise.resolve(req);
          setStage({ at: "sending", action: kind });
          return writeAllowed(req, { config, order, pot: ctx });
        },
      });
      if (!life.alive()) return;
      if (!result.ok) {
        // The card was gone at one of the runner's awaits: nothing more was done.
        if (result.problem === "left") return;
        // A refusal of the server that means "sign in" goes there.
        if (result.problem === "pot_unreadable" && kit.routeSignIn(result.cause)) return;
        const failed = potTransferFailureView(result, say);
        setStage({ at: "problem", action: kind, lines: failed.lines, hash: null, again: null });
        // The pot or the key is not as the card showed it: the done page reads it again.
        if (failed.reread) latestOnChanged.current();
        return;
      }
      // The transfer is on its way: its field starts again, so nothing is sent twice by mistake.
      setAmounts((m) => ({ ...m, [kind]: START[kind] }));
      await afterSend(client, a, kind, {
        agentWallet: result.agentWallet,
        ceilingUnits: null,
        hash: result.hash,
        confirmed: false,
      });
    } finally {
      lock.release();
      setBusy(false);
    }
  }

  /** The receipt, awaited; then what it says. */
  async function afterSend(client: Client, a: PotAddresses, kind: PotTransfer, again: PotReadAgain) {
    setStage({ at: "waiting", action: kind, hash: again.hash });
    let receipt: { status?: string } | null;
    try {
      receipt = await client.waitForTransactionReceipt({
        hash: again.hash,
        timeout: REGISTER_RECEIPT_TIMEOUT_MS,
      });
    } catch {
      receipt = null;
    }
    if (!life.alive()) return;
    await afterReceipt(client, a, kind, again, receipt);
  }

  /** A reverted receipt moved nothing; none in time may still land (Check again asks for it);
   *  one that went through: the pot and the key read again. */
  async function afterReceipt(
    client: Client,
    a: PotAddresses,
    kind: PotTransfer,
    again: PotReadAgain,
    receipt: { status?: string } | null,
  ) {
    const outcome = pointerTxStage(receipt);
    if (outcome === "reverted") {
      setStage({ at: "problem", action: kind, lines: [POT.problems.reverted], hash: again.hash, again: null });
      return;
    }
    if (outcome === "no_receipt") {
      setStage({ at: "problem", action: kind, lines: [POT.problems.no_receipt], hash: again.hash, again });
      return;
    }
    await readBack(client, a, kind, { ...again, confirmed: true });
  }

  /** What the chain shows after the receipt, read for the click's own key: the pot's balance, or
   *  what the key holds; then the done page reads it again. */
  async function readBack(client: Client, a: PotAddresses, kind: PotTransfer, again: PotReadAgain) {
    const wallet = again.agentWallet;
    let fresh: PotRaw | null;
    try {
      fresh = await readPotRaw(client, a, { pot: noted.address, agentWallet: wallet });
    } catch {
      fresh = null;
    }
    if (!life.alive()) return;
    if (fresh === null || fresh.codeHash === null) {
      setStage({ at: "problem", action: kind, lines: [POT.readBackFailed], hash: again.hash, again });
      return;
    }
    const done = potTransferDoneView(kind, fresh);
    setStage({ at: "done", action: kind, ok: done.ok, lines: done.lines, hash: again.hash });
    latestOnChanged.current();
  }

  /** "Check again": a receipt not seen in time is asked for first; then the pot read again. A
   *  receipt still not there leaves the panel as it is. */
  async function onCheckAgain() {
    if (lock.held() || stage.at !== "problem" || stage.again === null) return;
    const { action, again } = stage;
    const client = publicClient;
    if (!client || a === null) return;
    if (!lock.take()) return;
    setBusy(true);
    try {
      if (again.confirmed) {
        await readBack(client, a, action, again);
        return;
      }
      let receipt: { status?: string } | null;
      try {
        receipt = await client.getTransactionReceipt({ hash: again.hash });
      } catch {
        receipt = null;
      }
      if (!life.alive()) return;
      await afterReceipt(client, a, action, again, receipt);
    } finally {
      lock.release();
      setBusy(false);
    }
  }

  const feeLines = potFeeLines(shownRaw);
  // What the key holds, in the panel's lines; the low mark's warning as a warning beside them.
  const held = feeLines.filter((line) => line !== POT.feeMoneyLow);
  const low = feeLines.includes(POT.feeMoneyLow);

  /** One transfer's panel: its title, its lines, its amount field, and its one button. */
  function panel(kind: PotTransfer) {
    const running = busy && stage.at !== "idle" && stage.action === kind;
    const field = (
      <PotAmountField
        id={kind === "add_money" ? "legal-body-pot-add-money" : "legal-body-pot-fee-money"}
        label={kind === "add_money" ? POT.addMoneyLabel : POT.gasLabel}
        value={amounts[kind]}
        error={amountProblems[kind]}
        disabled={lock.busy}
        onChange={(typed) => editAmount(kind, typed)}
      />
    );
    const send = {
      sendLabel: potTransferSendLabel(kind, amounts[kind]),
      onSend: () => void onTransfer(kind),
      disabled: lock.busy,
      loading: running,
    };
    if (kind === "add_money")
      return (
        <PotActionPanel
          key={kind}
          title={POT.addMoneyTitle}
          lines={[fillCopy(POT.addMoneyLine, { address: noted.address }), POT.keepLittle, POT.noRecovery]}
          {...send}
        >
          {field}
        </PotActionPanel>
      );
    return (
      <PotActionPanel
        key={kind}
        title={POT.feeMoneyTitle}
        lines={[...held, fillCopy(POT.feeMoneyLine, { address: shownWallet })]}
        {...send}
      >
        {low && (
          <Callout tone="warn" className="mb-4">
            {POT.feeMoneyLow}
          </Callout>
        )}
        {field}
      </PotActionPanel>
    );
  }

  return (
    <>
      {stage.at !== "idle" && (
        <PotActionResultPanel
          title={TITLES[stage.action]}
          stage={stage}
          after={[]}
          busy={busy}
          disabled={lock.busy}
          onCheckAgain={() => void onCheckAgain()}
        />
      )}
      {ORDER.filter((kind) => offered.includes(kind)).map(panel)}
    </>
  );
}
