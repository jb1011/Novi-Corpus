"use client";

import { useEffect, useRef, useState } from "react";
import { useConnection, usePublicClient } from "wagmi";
import { Spinner } from "@/components/onboarding/primitives";
import {
  useAllowedWrite,
  useDeclarePotMutation,
  useOrderGrantQuery,
  useOrderPotQuery,
  useReadOrderPotNow,
  useWalletNow,
} from "@/lib/api/legalBodyHooks";
import type { Address, Hex, LegalBodyOrderView } from "@/lib/api/types";
import { readAgentWallet } from "@/lib/legalBody/agentWallet";
import {
  allowedCall,
  identityRegistryAbi,
  potSetupCall,
  type CallContext,
  type WalletKind,
} from "@/lib/legalBody/chain";
import { LEGAL_BODY_COPY, POT_DECLARATION_VERSION } from "@/lib/legalBody/copy";
import { REGISTER_RECEIPT_TIMEOUT_MS, networkName } from "@/lib/legalBody/identity";
import { stepLifetime } from "@/lib/legalBody/lifetime";
import { pointerTxStage } from "@/lib/legalBody/pointer";
import { POT_SETUP_GAS_CAP, potAddresses } from "@/lib/legalBody/safePot";
import {
  potCeilingCapFromGrant,
  potReading,
  readPotRaw,
  type PotRaw,
} from "@/lib/legalBody/safePotRules";
import {
  potCreateFailureView,
  potFormBegin,
  potFormMoney,
  potFreshSalt,
  potReviewNote,
  runPotCreate,
  runPotReview,
  type PotStage,
} from "@/lib/legalBody/safePotRun";
import {
  potCeilingHint,
  potCreatedView,
  potFormCheck,
  potGrantView,
  potProblemSentence,
  potRefusalSentence,
  potReviewLines,
  potSendPreflight,
  potSetupContext,
  type PotForm,
  type PotFormCheck,
  type PotPlan,
} from "@/lib/legalBody/safePotStep";
import type { LegalBodyStepKit } from "./LegalBodyFlow";
import {
  PotCreatedPanel,
  PotFormPanel,
  PotNotice,
  PotProblemPanel,
  PotReviewPanel,
  PotStatusPanel,
} from "./PotPanels";

const POT = LEGAL_BODY_COPY.pot;

type FieldProblems = Omit<Extract<PotFormCheck, { ok: false }>, "ok">;
type Client = NonNullable<ReturnType<typeof usePublicClient>>;

/**
 * "Give your agent an allowance": the company's pot, created in one transaction from the done page
 * of a linked legal body, with the guardian's declaration.
 *
 * As it opens, the step reads one thing, the order's grant, which caps the ceiling; the done page
 * has read the noted pot already, and the step takes it from there for what the form shows only.
 * A grant that could not be read says so with Try again, and one that allows no spending says so;
 * neither shows a form. Otherwise the form: the ceiling EMPTY (the noted pot's own, for the noted
 * pot that never got code), the grant's cap beside it, the pot's money, and the fee money for a
 * plain key (no field for a wallet the last click read as a delegated key or a contract).
 *
 * "Review" checks the form, then reads every fact the plan decides on, FRESH, in the click
 * (`runPotReview`): `GET /pot` (never the card's cached answer), the registry's agent wallet, the
 * guardian's balance, the code at the noted address, the agent wallet's code, and the code at the
 * predicted address with a salt of 16 random bytes; a failed read sends nothing. Then the review's
 * lines and the declaration's tick box, unticked: "Create the pot" stays disabled until it is
 * ticked.
 *
 * "Create the pot" is `runPotCreate`: the page's own checks; the simulation and the estimate of
 * the exact request the allowlist takes, from the guardian, with no fee field; then the note of the
 * pot with its declaration on the server; and only then the one transaction, through the allowlist
 * alone. After the receipt the pot is read back from the chain against the key it was set up for,
 * and the reading says whether its ceiling is the plan's: anything else is a warning, and nothing
 * more is offered. `onCreated` then reads the noted pot, its reading and the record again, so the
 * done page moves on; it is asked too when the server says the pot exists already.
 *
 * The amounts typed live in this step's state only, never in a browser store. Every read but the
 * grant's, and the one transaction, are a click's; a click's continuation stops after its next
 * await once the step is gone.
 */
export function PotStep({
  kit,
  order,
  agentWallet,
  onCreated,
}: {
  kit: LegalBodyStepKit;
  order: LegalBodyOrderView;
  /** The record's agent wallet, as the done page read it: for what the form shows only. */
  agentWallet: Address;
  /** Reads the noted pot, its reading and the record again. */
  onCreated: () => void;
}) {
  const { config, tenant } = kit;
  const environment = config.environment;
  const publicClient = usePublicClient({ chainId: config.chainId });
  const { address, chainId: walletChainId } = useConnection();
  const connected = (address ?? null) as Address | null;
  const writeAllowed = useAllowedWrite();
  const declarePot = useDeclarePotMutation(order.id);
  const readPotNow = useReadOrderPotNow(order.id);
  // The connected account at the moment of asking, never the click's.
  const walletNow = useWalletNow();
  const grantQuery = useOrderGrantQuery(order.id, true);
  // The done page's answer from the cache, never asked of the server here: the form shows it, and
  // the click reads it again before it plans anything.
  const notedQuery = useOrderPotQuery(order.id, false);
  const noted = notedQuery.data?.pot ?? null;

  // On screen from the effect below, gone at its cleanup.
  const [life] = useState(() => stepLifetime());
  useEffect(() => {
    life.begin();
    return () => life.end();
  }, [life]);
  // The done page's latest reads, asked when the chain or the server moved.
  const latestOnCreated = useRef(onCreated);
  useEffect(() => {
    latestOnCreated.current = onCreated;
  });

  // The agent wallet's kind, as the last click read it: null before any click.
  const [kind, setKind] = useState<WalletKind | null>(null);
  const [form, setForm] = useState<PotForm>(() =>
    potFormBegin({ kind: null, noted, registryWallet: agentWallet }),
  );
  const [fieldProblems, setFieldProblems] = useState<FieldProblems | null>(null);
  // The sentences of the last answer.
  const [lines, setLines] = useState<string[]>([]);
  const [stage, setStage] = useState<PotStage>({ at: "form" });
  const [busy, setBusy] = useState(false);
  // Set and cleared inside a click: a second click before the first settles reads and sends nothing.
  const inFlight = useRef(false);

  const cap = grantQuery.data !== undefined ? potCeilingCapFromGrant(grantQuery.data.grant) : null;
  const guardian = order.guardian;
  const say = { environment, guardian };

  function edit(field: keyof PotForm, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    setFieldProblems((p) => (p === null ? null : { ...p, [field]: undefined }));
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

  /** "Review": the form's check, then every read of the plan, fresh, then the review. */
  async function onReview() {
    if (inFlight.current || stage.at !== "form" || cap === null || !potGrantView(cap).form) return;
    setLines([]);
    const check = potFormCheck(form, cap, kind ?? "key");
    if (!check.ok) {
      setFieldProblems(check);
      return;
    }
    setFieldProblems(null);
    const client = publicClient;
    const agentId = order.agentId;
    if (!client) {
      setLines([potRefusalSentence("chain_not_configured", say)]);
      return;
    }
    if (agentId === null) {
      setLines([potProblemSentence({ problem: "refused" })]);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await runPotReview(
        { chainId: config.chainId, guardian, checked: check },
        {
          readNoted: () => readPotNow(),
          readRegistryWallet: () => readRegistry(client, agentId),
          readCode: (at) => client.getCode({ address: at }),
          readBalance: () => client.getBalance({ address: guardian }),
          freshSalt: () => potFreshSalt(crypto.getRandomValues(new Uint8Array(16))),
        },
      );
      if (!life.alive()) return;
      if (result.kind !== null) setKind(result.kind);
      if (!result.ok) {
        if (result.cause !== undefined && kit.routeSignIn(result.cause)) return;
        setLines([potProblemSentence(result.say)]);
        // The pot exists already: the done page reads it and moves on.
        if (result.say.problem === "pot_exists") latestOnCreated.current();
        return;
      }
      setStage({ at: "review", plan: result.plan, noted: result.noted, declared: false });
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** "Create the pot": the checks, the simulation and the estimate, the note, then the wallet;
   *  then the receipt, and the pot read back. */
  async function onCreate() {
    if (inFlight.current || stage.at !== "review" || !stage.declared) return;
    const { plan, noted: reviewed } = stage;
    setLines([]);
    const client = publicClient;
    const agentId = order.agentId;
    if (!client) {
      setLines([potRefusalSentence("chain_not_configured", say)]);
      return;
    }
    if (agentId === null) {
      setLines([potProblemSentence({ problem: "refused" })]);
      return;
    }
    const context = potSetupContext(plan);
    const ctx: CallContext = { config, order, pot: context };
    // The exact request the allowlist takes, simulated and estimated as it will be sent: a plan
    // the allowlist refuses never reaches the chain, the server or the wallet.
    const built = potSetupCall(config, context, POT_SETUP_GAS_CAP);
    if ("ok" in built) {
      refusedBefore(plan, built.problem);
      return;
    }
    const allowed = allowedCall(built, ctx);
    if (!allowed.ok) {
      refusedBefore(plan, allowed.problem);
      return;
    }
    inFlight.current = true;
    setBusy(true);
    // Until the wallet opens: the checks, the simulation, the estimate, the reads and the note.
    setStage({ at: "checking", plan });
    try {
      const result = await runPotCreate(plan, reviewed, {
        alive: () => life.alive(),
        preflight: () =>
          potSendPreflight({
            order,
            tenant,
            connected,
            walletChainId,
            chainId: config.chainId,
            guardian: plan.guardian,
          }),
        simulate: async () =>
          (
            await client.call({
              account: plan.guardian,
              to: built.address,
              data: allowed.data,
              value: built.value,
            })
          ).data ?? "0x",
        estimate: () =>
          client.estimateGas({
            account: plan.guardian,
            to: built.address,
            data: allowed.data,
            value: built.value,
          }),
        readBalance: () => client.getBalance({ address: plan.guardian }),
        readNoted: () => readPotNow(),
        readRegistryWallet: () => readRegistry(client, agentId),
        declare: async () => {
          await declarePot.mutateAsync({
            address: plan.pot,
            saltNonce: plan.saltNonce.toString(),
            ceilingUnits: plan.ceilingUnits.toString(),
            agentWallet: plan.agentWallet,
            declarationVersion: POT_DECLARATION_VERSION,
          });
        },
        account: () => walletNow().address,
        send: (gas) => {
          const req = potSetupCall(config, context, gas);
          if ("ok" in req) return Promise.resolve(req);
          setStage({ at: "sending", plan });
          return writeAllowed(req, ctx);
        },
      });
      if (!life.alive()) return;
      if (!result.ok) {
        // The step was gone at one of the runner's awaits: nothing more was done.
        if (result.problem === "left") return;
        // A refusal of the server that means "sign in" goes there.
        if (
          (result.problem === "record_failed" || result.problem === "pot_unreadable") &&
          kit.routeSignIn(result.cause)
        )
          return;
        const view = potCreateFailureView(result, say);
        setLines(view.lines);
        if (view.reread === "grant") void grantQuery.refetch();
        else if (view.reread !== undefined) latestOnCreated.current();
        if (view.to === "review") setStage({ at: "review", plan, noted: reviewed, declared: true });
        else if (view.to === "form") setStage({ at: "form" });
        else setStage({ at: "problem", problem: result.problem, plan, then: view.then ?? "none" });
        return;
      }
      await afterSend(client, plan, result.hash);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  /** The allowlist refused the plan's own setup: its sentence, and back to the form. */
  function refusedBefore(plan: PotPlan, code: string) {
    setLines([potRefusalSentence(code, say)]);
    setStage({ at: "problem", problem: "refused", plan, then: "form" });
  }

  /** The receipt, then the pot read back. A reverted one moved nothing; none in time may still
   *  land: Check again reads the pot's address. */
  async function afterSend(client: Client, plan: PotPlan, hash: Hex) {
    setStage({ at: "waiting", plan, hash });
    let receipt: { status?: string } | null;
    try {
      receipt = await client.waitForTransactionReceipt({ hash, timeout: REGISTER_RECEIPT_TIMEOUT_MS });
    } catch {
      receipt = null;
    }
    if (!life.alive()) return;
    const outcome = pointerTxStage(receipt);
    if (outcome === "reverted") {
      setLines([POT.problems.reverted]);
      setStage({ at: "problem", problem: "reverted", plan, hash, then: "form" });
      return;
    }
    if (outcome === "no_receipt") {
      setLines([POT.problems.no_receipt]);
      setStage({ at: "problem", problem: "no_receipt", plan, hash, then: "check_again" });
      return;
    }
    await readBack(client, plan, hash);
  }

  /** The created pot as the chain shows it, read against the key it was set up for (for a noted
   *  pot made for its first key, that key, never the registry's new one). */
  async function readBack(client: Client, plan: PotPlan, hash: Hex) {
    const a = potAddresses(config.chainId);
    let raw: PotRaw | null = null;
    if (a !== null) {
      try {
        raw = await readPotRaw(client, a, { pot: plan.pot, agentWallet: plan.agentWallet });
      } catch {
        raw = null;
      }
    }
    if (!life.alive()) return;
    const reading =
      a === null || raw === null
        ? null
        : potReading(raw, { addresses: a, guardian: plan.guardian, agentWallet: plan.agentWallet });
    if (reading === null || reading.state === "absent") {
      setLines([POT.readBackFailed]);
      setStage({ at: "problem", problem: "read_failed", plan, hash, then: "check_again" });
      return;
    }
    const view = potCreatedView(reading, plan.ceilingUnits);
    setLines([]);
    setStage({ at: "created", plan, lines: view.lines, ok: view.ok });
    latestOnCreated.current();
  }

  /** "Check again": the code at the pot's address. Code there: read back as a success; none: the
   *  form again. A read that fails leaves the step as it is. */
  async function onCheckAgain() {
    if (inFlight.current || stage.at !== "problem" || stage.plan === null || !stage.hash) return;
    const { plan, hash } = stage;
    const client = publicClient;
    if (!client) return;
    inFlight.current = true;
    setBusy(true);
    try {
      let code: Hex | undefined;
      try {
        code = await client.getCode({ address: plan.pot });
      } catch {
        return;
      }
      if (!life.alive()) return;
      if (code === undefined || code === "0x") {
        setLines([]);
        setStage({ at: "form" });
        return;
      }
      await readBack(client, plan, hash);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function backToForm() {
    if (inFlight.current) return;
    setLines([]);
    setStage({ at: "form" });
  }

  /** What the stage shows. */
  function body() {
    switch (stage.at) {
      case "form": {
        if (cap === null)
          return grantQuery.isError ? (
            <PotNotice
              tone="warn"
              line={POT.grantUnreadable}
              onRetry={() => void grantQuery.refetch()}
              retrying={grantQuery.isFetching}
            />
          ) : (
            <div className="flex items-center py-6 text-muted">
              <Spinner className="h-3.5 w-3.5" />
            </div>
          );
        const grant = potGrantView(cap);
        if (!grant.form) return <PotNotice tone="info" line={grant.lines.join(" ")} />;
        return (
          <PotFormPanel
            network={networkName(environment)}
            form={form}
            problems={fieldProblems}
            money={potFormMoney({ kind, noted, registryWallet: agentWallet })}
            ceilingHint={potCeilingHint(cap)}
            grantLines={grant.lines}
            lines={lines}
            busy={busy}
            onChange={edit}
            onReview={() => void onReview()}
          />
        );
      }
      case "review": {
        const current = stage;
        return (
          <PotReviewPanel
            lines={potReviewLines(current.plan)}
            note={potReviewNote(current.plan)}
            declared={current.declared}
            busy={busy}
            problems={lines}
            onDeclared={(declared) => {
              if (!inFlight.current) setStage({ ...current, declared });
            }}
            onCreate={() => void onCreate()}
            onBack={backToForm}
          />
        );
      }
      case "checking":
        return <PotStatusPanel text={POT.checkingSend} hash={null} />;
      case "sending":
        return <PotStatusPanel text={POT.sending} hash={null} />;
      case "waiting":
        return <PotStatusPanel text={POT.waiting} hash={stage.hash} />;
      case "created":
        return <PotCreatedPanel ok={stage.ok} lines={stage.lines} />;
      case "problem":
        return (
          <PotProblemPanel
            lines={lines}
            hash={stage.hash ?? null}
            then={stage.then}
            busy={busy}
            onCheckAgain={() => void onCheckAgain()}
            onBack={backToForm}
          />
        );
    }
  }

  return (
    <div>
      <h2 className="text-[16px] font-medium text-ink">{POT.title}</h2>
      <div className="mt-5">{body()}</div>
    </div>
  );
}
