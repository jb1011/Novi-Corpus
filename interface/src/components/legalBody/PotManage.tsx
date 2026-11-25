"use client";

import { useEffect, useRef, useState } from "react";
import { useConnection, usePublicClient } from "wagmi";
import { Callout } from "@/components/onboarding/primitives";
import {
  useAllowedWrite,
  useDeclarePotMutation,
  useOrderGrantQuery,
  useTakePotOffRecordMutation,
  useWalletNow,
} from "@/lib/api/legalBodyHooks";
import type { Address, LegalBodyOrderView, OrderPotView } from "@/lib/api/types";
import { arcTestnet } from "@/lib/chain";
import { readAgentWallet } from "@/lib/legalBody/agentWallet";
import {
  allowedCall,
  formatNative,
  identityRegistryAbi,
  potExecCall,
} from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY, POT_DECLARATION_VERSION, fillCopy } from "@/lib/legalBody/copy";
import { sameAddress } from "@/lib/legalBody/flow";
import { REGISTER_RECEIPT_TIMEOUT_MS } from "@/lib/legalBody/identity";
import { stepLifetime } from "@/lib/legalBody/lifetime";
import { pointerTxStage } from "@/lib/legalBody/pointer";
import { POT_EXEC_GAS_CAP, potAddresses, type PotAddresses } from "@/lib/legalBody/safePot";
import {
  potCeilingCapFromGrant,
  potReading,
  readPotRaw,
  type PotRaw,
  type PotReading,
} from "@/lib/legalBody/safePotRules";
import {
  isPotSafeAction,
  isPotTransfer,
  potActionAfter,
  potActionDoneView,
  potActionFailureView,
  potActionTakesCeiling,
  potCeilingCheck,
  potRecordFailureView,
  runPotAction,
  type PotActionStage,
  type PotReadAgain,
  type PotSafeAction,
} from "@/lib/legalBody/safePotActions";
import {
  potAgentCommands,
  potCeilingHint,
  potFeeLines,
  potProblemSentence,
  potReadingView,
  potRefusalSentence,
  potSendPreflight,
  type PotAction,
} from "@/lib/legalBody/safePotStep";
import type { LegalBodyStepKit } from "./LegalBodyFlow";
import { PotMoney } from "./PotMoney";
import {
  PotActionPanel,
  PotActionResultPanel,
  PotAgentPanel,
  PotCeilingField,
  PotDeclarationTick,
  PotManageFrame,
} from "./PotPanels";

const POT = LEGAL_BODY_COPY.pot;

type Client = NonNullable<ReturnType<typeof usePublicClient>>;
/** The actions that set a ceiling, each with its own field. */
type CeilingAction = "change" | "start_again" | "new_key";
/** The public record's two actions: one call to the server each, no wallet. */
type RecordAction = Extract<PotAction, "take_off_record" | "put_back">;
const isRecordAction = (action: PotAction): action is RecordAction =>
  action === "take_off_record" || action === "put_back";

const TITLES: Readonly<Record<PotSafeAction, string>> = {
  change: POT.changeTitle,
  stop: POT.stopTitle,
  withdraw: POT.withdrawTitle,
  start_again: POT.startAgainTitle,
  new_key: POT.newKeyTitle,
};

/**
 * The company's pot once it exists: what the chain shows, and the guardian's actions on the SAME
 * Safe, each its own panel with one transaction: change the allowance (a new ceiling; the running
 * period and what was taken in it are kept), stop it (every key listed off and the add-on off, no
 * amount), take the money back (only once no add-on is on), start again (after a stop), and move
 * the allowance to the agent's new key (when the registry names a key that is not the pot's).
 * There is never a way to create a second pot. Then the two USDC transfers (`PotMoney`: Add money,
 * Send fee money, with what the agent's key holds for its fees beside it), the public record's
 * action (`PotRecordAction`: take the pot off it, or put it back), and, for a pot whose ceiling is
 * read, what the agent does with its own key: the MCP tools by name and the two commands.
 *
 * The card is drawn from the done page's reads (`agentWallet`, `raw`, `reading`: the record's key
 * and the pot read for it). An action's click never builds from them: it reads the registry's key
 * and the pot again (`runPotAction`), and builds its transaction from THAT read, so a restore is
 * for the key the registry names in the same click; and since the guardian signs only what was
 * shown, a start again or a new key is refused when that key is not the one its panel names
 * (Ruling R23), and the card reads again. Then the page's checks, the allowlist on the exact
 * request, the simulation and the estimate from the guardian with no fee field, the account
 * connected now, and only then the wallet. After the receipt the pot is read again against the
 * click's key, and `onChanged` reads the done page's pot again.
 *
 * Nothing is read or sent on mount but the grant (the done page's, from the cache), which caps the
 * ceiling fields. The ceilings typed live in this card's state only, never in a browser store. A
 * click's continuation stops after its next await once the card is gone.
 */
export function PotManage({
  kit,
  order,
  noted,
  agentWallet: shownWallet,
  raw: shownRaw,
  reading: shownReading,
  nowSeconds,
  onChanged,
}: {
  kit: LegalBodyStepKit;
  order: LegalBodyOrderView;
  /** The noted pot, which holds the pot's code. */
  noted: OrderPotView;
  /** The record's agent wallet, the one the card's reading was made for. */
  agentWallet: Address;
  raw: PotRaw;
  reading: PotReading;
  /** When the pot was read, in unix seconds: what is left is said of that period. */
  nowSeconds: number;
  /** Reads the noted pot, its reading and the record again. */
  onChanged: () => void;
}) {
  const { config, tenant } = kit;
  const environment = config.environment;
  const guardian = order.guardian;
  const say = { environment, guardian };
  const publicClient = usePublicClient({ chainId: config.chainId });
  const { address, chainId: walletChainId } = useConnection();
  const connected = (address ?? null) as Address | null;
  const writeAllowed = useAllowedWrite();
  // The connected account at the moment of asking, never the click's.
  const walletNow = useWalletNow();
  // The done page's grant, from the cache: it caps the ceilings.
  const grantQuery = useOrderGrantQuery(order.id, true);

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

  const [ceilings, setCeilings] = useState<Record<CeilingAction, string>>({
    change: "",
    start_again: "",
    new_key: "",
  });
  const [ceilingProblems, setCeilingProblems] = useState<Partial<Record<CeilingAction, string>>>({});
  const [stage, setStage] = useState<PotActionStage>({ at: "idle" });
  const [busy, setBusy] = useState(false);
  // Set and cleared inside a click: a second click before the first settles reads and sends nothing.
  const inFlight = useRef(false);

  const a = potAddresses(config.chainId);
  const cap =
    grantQuery.data !== undefined
      ? potCeilingCapFromGrant(grantQuery.data.grant)
      : grantQuery.isError
        ? "unreadable"
        : null;

  function editCeiling(action: CeilingAction, value: string) {
    setCeilings((c) => ({ ...c, [action]: value }));
    setCeilingProblems((p) => ({ ...p, [action]: undefined }));
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

  function refusedHere(action: PotSafeAction, line: string) {
    setStage({ at: "problem", action, lines: [line], hash: null, again: null });
  }

  /** One action's click: its ceiling checked, then `runPotAction` over this click's own reads. */
  async function onAction(action: PotSafeAction) {
    if (inFlight.current) return;
    let newCeilingUnits: bigint | undefined;
    if (potActionTakesCeiling(action)) {
      const field = action as CeilingAction;
      if (cap === null || cap === "unreadable") return;
      const checked = potCeilingCheck(ceilings[field], cap);
      if (!checked.ok) {
        setCeilingProblems((p) => ({ ...p, [field]: checked.line }));
        return;
      }
      newCeilingUnits = checked.ceilingUnits;
    }
    setCeilingProblems({});
    const client = publicClient;
    const agentId = order.agentId;
    if (!client || a === null) {
      refusedHere(action, potRefusalSentence("chain_not_configured", say));
      return;
    }
    if (agentId === null) {
      refusedHere(action, potProblemSentence({ problem: "refused" }));
      return;
    }
    inFlight.current = true;
    setBusy(true);
    // Until the wallet opens: the click's reads, the checks, the simulation and the estimate.
    setStage({ at: "checking", action });
    try {
      // The key the panel names goes in only to be compared: the restore is built from the
      // click's own read of the registry, and refused unless the two are the same (Ruling R23).
      const shown = { pot: noted.address, guardian, shownAgentWallet: shownWallet, newCeilingUnits };
      const result = await runPotAction(action, shown, {
        alive: () => life.alive(),
        read: async () => {
          const wallet = await readRegistry(client, agentId);
          if (wallet === "none" || wallet === "unreadable")
            return { agentWallet: wallet, raw: null, reading: null };
          const fresh = await readPotRaw(client, a, { pot: noted.address, agentWallet: wallet });
          return {
            agentWallet: wallet,
            raw: fresh,
            reading: potReading(fresh, { addresses: a, guardian, agentWallet: wallet }),
          };
        },
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
          const req = potExecCall(config, ctx, POT_EXEC_GAS_CAP);
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
          const req = potExecCall(config, ctx, gas);
          if ("ok" in req) return Promise.resolve(req);
          setStage({ at: "sending", action });
          return writeAllowed(req, { config, order, pot: ctx });
        },
      });
      if (!life.alive()) return;
      if (!result.ok) {
        // The card was gone at one of the runner's awaits: nothing more was done.
        if (result.problem === "left") return;
        const failed = potActionFailureView(result, say);
        setStage({ at: "problem", action, lines: failed.lines, hash: null, again: null });
        // The pot is not as the card showed it: the done page reads it again.
        if (failed.reread) latestOnChanged.current();
        return;
      }
      await afterSend(client, a, action, {
        agentWallet: result.agentWallet,
        ceilingUnits: newCeilingUnits ?? null,
        hash: result.hash,
        confirmed: false,
      });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** The receipt, awaited; then what it says. */
  async function afterSend(client: Client, a: PotAddresses, action: PotSafeAction, again: PotReadAgain) {
    setStage({ at: "waiting", action, hash: again.hash });
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
    await afterReceipt(client, a, action, again, receipt);
  }

  /** A reverted receipt moved nothing; none in time may still land (Check again asks for it);
   *  one that went through: the pot read again. */
  async function afterReceipt(
    client: Client,
    a: PotAddresses,
    action: PotSafeAction,
    again: PotReadAgain,
    receipt: { status?: string } | null,
  ) {
    const outcome = pointerTxStage(receipt);
    if (outcome === "reverted") {
      setStage({ at: "problem", action, lines: [POT.problems.reverted], hash: again.hash, again: null });
      return;
    }
    if (outcome === "no_receipt") {
      setStage({ at: "problem", action, lines: [POT.problems.no_receipt], hash: again.hash, again });
      return;
    }
    await readBack(client, a, action, { ...again, confirmed: true });
  }

  /** The pot as the chain shows it after the receipt, read against the click's own key (after a
   *  restore, the key it was made for); then the done page reads it again. */
  async function readBack(client: Client, a: PotAddresses, action: PotSafeAction, again: PotReadAgain) {
    const wallet = again.agentWallet;
    let reading: PotReading | null;
    try {
      const fresh = await readPotRaw(client, a, { pot: noted.address, agentWallet: wallet });
      reading = potReading(fresh, { addresses: a, guardian, agentWallet: wallet });
    } catch {
      reading = null;
    }
    if (!life.alive()) return;
    if (reading === null || reading.state === "absent") {
      setStage({ at: "problem", action, lines: [POT.readBackFailed], hash: again.hash, again });
      return;
    }
    const done = potActionDoneView(action, reading, again.ceilingUnits, wallet);
    setStage({ at: "done", action, ok: done.ok, lines: done.lines, hash: again.hash });
    latestOnChanged.current();
  }

  /** "Check again": a receipt not seen in time is asked for first; then the pot read again. A
   *  receipt still not there leaves the card as it is. */
  async function onCheckAgain() {
    if (inFlight.current || stage.at !== "problem" || stage.again === null) return;
    const { action, again } = stage;
    const client = publicClient;
    if (!client || a === null) return;
    inFlight.current = true;
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
      inFlight.current = false;
      setBusy(false);
    }
  }

  const view = potReadingView(shownReading, shownRaw, {
    chainId: config.chainId,
    pot: noted.address,
    guardian,
    agentWallet: shownWallet,
    onRecord: noted.onRecord,
    onThisDeployment: order.chainId === config.chainId && sameAddress(order.factory, config.factory),
    nowSeconds,
  });
  const actions = view.actions.filter(isPotSafeAction);
  const transfers = view.actions.filter(isPotTransfer);
  const recordAction = view.actions.find(isRecordAction) ?? null;
  // What the agent's key holds for its fees is said in the Send fee money panel, beside its
  // button, and not twice on the card.
  const feeShownBelow = transfers.includes("fee_money") ? potFeeLines(shownRaw) : [];
  const frameLines = view.lines.filter((line) => !feeShownBelow.includes(line));
  const hint = cap === null || cap === "unreadable" ? null : potCeilingHint(cap);
  const commands =
    shownReading.state === "ceiling_read" && a !== null
      ? potAgentCommands({
          addresses: a,
          pot: noted.address,
          agentWallet: shownWallet,
          rpcUrl: arcTestnet.rpcUrls.default.http[0],
        })
      : null;

  function ceilingField(action: CeilingAction) {
    return (
      <PotCeilingField
        id={`legal-body-pot-ceiling-${action}`}
        value={ceilings[action]}
        hint={hint}
        error={ceilingProblems[action]}
        disabled={busy}
        onChange={(value) => editCeiling(action, value)}
        unreadable={cap === "unreadable"}
        onRetry={() => void grantQuery.refetch()}
        retrying={grantQuery.isFetching}
      />
    );
  }

  /** One action's panel: its title, its lines, its field, and its one button. */
  function panel(action: PotSafeAction) {
    const running = busy && stage.at !== "idle" && stage.action === action;
    const send = { onSend: () => void onAction(action), loading: running };
    // A ceiling's panel cannot send until the grant that caps it is read.
    const capped = { ...send, disabled: busy || hint === null };
    switch (action) {
      case "change":
        return (
          <PotActionPanel
            key={action}
            title={POT.changeTitle}
            lines={[POT.changeLine]}
            sendLabel={POT.changeSend}
            {...capped}
          >
            {ceilingField("change")}
          </PotActionPanel>
        );
      case "stop":
        return (
          <PotActionPanel
            key={action}
            title={POT.stopTitle}
            lines={[POT.stopLine]}
            sendLabel={POT.stopSend}
            danger
            disabled={busy}
            {...send}
          />
        );
      case "withdraw": {
        // The whole balance as the card read it; the click sends the whole balance it reads.
        const balance = formatNative(shownRaw.balanceWei);
        return (
          <PotActionPanel
            key={action}
            title={POT.withdrawTitle}
            lines={[fillCopy(POT.withdrawLine, { balance })]}
            sendLabel={fillCopy(POT.withdrawSend, { balance })}
            disabled={busy}
            {...send}
          />
        );
      }
      case "start_again":
        return (
          <PotActionPanel
            key={action}
            title={POT.startAgainTitle}
            lines={[fillCopy(POT.startAgainLine, { address: shownWallet }), POT.onePot]}
            sendLabel={POT.startAgainSend}
            {...capped}
          >
            {ceilingField("start_again")}
          </PotActionPanel>
        );
      case "new_key":
        return (
          <PotActionPanel
            key={action}
            title={POT.newKeyTitle}
            lines={[fillCopy(POT.newKeyLine, { address: shownWallet })]}
            sendLabel={POT.newKeySend}
            {...capped}
          >
            {ceilingField("new_key")}
          </PotActionPanel>
        );
    }
  }

  return (
    <PotManageFrame lines={frameLines}>
      {stage.at !== "idle" && (
        <PotActionResultPanel
          title={TITLES[stage.action]}
          stage={stage}
          after={potActionAfter(stage)}
          busy={busy}
          onCheckAgain={() => void onCheckAgain()}
        />
      )}
      {actions.map(panel)}
      <PotMoney
        kit={kit}
        order={order}
        noted={noted}
        agentWallet={shownWallet}
        raw={shownRaw}
        offered={transfers}
        onChanged={onChanged}
      />
      <PotRecordAction kit={kit} order={order} noted={noted} action={recordAction} onChanged={onChanged} />
      {commands && <PotAgentPanel take={commands.take} read={commands.read} />}
    </PotManageFrame>
  );
}

/**
 * The pot on the public record: "Take the pot off the public record" while it is on it (one call
 * of the server's off-record door, which answers whatever the pot's flag: a guardian may always
 * withdraw a claim), or "Put the pot back on the public record" (one note of the noted address
 * again, with the birth details the server served and the declaration's version), offered by the
 * reading only for an order of this deployment. Putting it back needs the declaration ticked
 * again: the button stays disabled until it is. Neither reaches a wallet or the chain.
 *
 * After either, the noted pot and the record are read again (`onChanged`). A refusal routes to
 * sign-in when it means that; a removal already done (a retry after a lost answer) shows nothing
 * and reads again; `pot_exists`, `pot_pending` and `pot_taken` say the server's sentence and read
 * again (`potRecordFailureView`). A click's continuation stops once the card is gone.
 */
export function PotRecordAction({
  kit,
  order,
  noted,
  action,
  onChanged,
}: {
  kit: LegalBodyStepKit;
  order: LegalBodyOrderView;
  noted: OrderPotView;
  /** The record action the card's reading offers, or none. */
  action: RecordAction | null;
  /** Reads the noted pot, its reading and the record again. */
  onChanged: () => void;
}) {
  const takeOff = useTakePotOffRecordMutation(order.id);
  const declarePot = useDeclarePotMutation(order.id);
  const [life] = useState(() => stepLifetime());
  useEffect(() => {
    life.begin();
    return () => life.end();
  }, [life]);
  const latestOnChanged = useRef(onChanged);
  useEffect(() => {
    latestOnChanged.current = onChanged;
  });
  // The declaration, ticked again for each put back: never kept in a browser store.
  const [declared, setDeclared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const inFlight = useRef(false);

  async function onRecord(act: RecordAction) {
    if (inFlight.current) return;
    if (act === "put_back" && !declared) return;
    inFlight.current = true;
    setBusy(true);
    setLines([]);
    try {
      if (act === "take_off_record") await takeOff.mutateAsync();
      else
        await declarePot.mutateAsync({
          address: noted.address,
          saltNonce: noted.birth.saltNonce,
          ceilingUnits: noted.birth.ceilingUnits,
          agentWallet: noted.birth.agentWallet,
          declarationVersion: POT_DECLARATION_VERSION,
        });
      if (!life.alive()) return;
      setDeclared(false);
      latestOnChanged.current();
    } catch (e) {
      if (!life.alive()) return;
      // A refusal of the server that means "sign in" goes there.
      if (kit.routeSignIn(e)) return;
      const failed = potRecordFailureView(e);
      setLines(failed.lines);
      if (failed.reread) latestOnChanged.current();
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const said = lines.length > 0 && (
    <Callout tone="warn" className="mb-4">
      {lines.join(" ")}
    </Callout>
  );
  if (action === "take_off_record")
    return (
      <PotActionPanel
        title={POT.offRecordTitle}
        lines={[POT.offRecordLine]}
        sendLabel={POT.offRecordSend}
        onSend={() => void onRecord("take_off_record")}
        disabled={busy}
        loading={busy}
      >
        {said}
      </PotActionPanel>
    );
  if (action === "put_back")
    return (
      <PotActionPanel
        title={POT.backOnTitle}
        lines={[]}
        sendLabel={POT.backOnSend}
        onSend={() => void onRecord("put_back")}
        disabled={busy || !declared}
        loading={busy}
      >
        {said}
        <PotDeclarationTick declared={declared} disabled={busy} onDeclared={setDeclared} />
        {!declared && <p className="mt-2 text-[12.5px] text-muted-2">{POT.declarationNeeded}</p>}
      </PotActionPanel>
    );
  return said ? <div className="border-t hairline pt-5">{said}</div> : null;
}
