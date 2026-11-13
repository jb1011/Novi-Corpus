import type { Address, Hex } from "viem";
import { agentTreasuryAbi, legalBodyFactoryAbi } from "../abis/generated";
import { opsLog } from "../observability/opsLog";
import type { AlertSink } from "./alerts";
import type {
  EntityIndex,
  EntityLookup,
  LegalBodyRecord,
  MonitoredEntity,
  WatchedLegalBody,
} from "./entityLookup";
import { indexEntities, indexLegalBodies } from "./entityLookup";
import { standingRoles } from "./events";
import type { MonitorRpc, RawLog } from "./rpc";
import {
  type GrantOp,
  type RuleContext,
  evaluateLog,
  grantNowStandingAlert,
  isPermanentGrant,
  ttlEscalations,
} from "./rules";
import {
  MAX_LOG_ADDRESSES,
  MAX_LOG_RANGE,
  MIN_LOG_RANGE,
  chunkRange,
  coldStartFrom,
  fetchWindow,
  isRangeTooLargeError,
  shrinkRange,
} from "./scan";
import type { MonitorStore, OpenGrant, SeenLegalBody } from "./store";

/**
 * The watcher loop.
 *
 * One invariant governs everything here: THE MONITOR MUST NOT STOP. A watcher that dies on a
 * transient RPC error produces the same observable output as a chain where nothing happened, which
 * is the worst possible failure mode for a security control. So every tick is wrapped, every
 * partial failure degrades a rule rather than the process, and the cursor only advances over
 * blocks that were actually scanned — a failed chunk is re-read on the next tick (the alert dedup
 * key makes that free).
 */

export interface MonitorConfig {
  controller: Address;
  registry: Address;
  /** Configured factory first; extras from MONITOR_WATCH_FACTORIES. */
  factories: Address[];
  /** MONITOR_WATCH_BEACONS; the configured factory's own beacon is added at startup. */
  beacons: Address[];
  /** LegalBodyFactory addresses: the configured one first, then MONITOR_WATCH_LEGAL_BODY_FACTORIES.
   *  Kept apart from `factories`: the beacon logic belongs to the full-product factory only. */
  legalBodyFactories: Address[];
  /** Address of the platform signing key (the executor identity). No key material here. */
  executor: Address;
  pollMs: number;
  grantTtlMs: number;
  lookbackBlocks: number;
  maxLogRange?: bigint;
}

/** `addresses` with case-insensitive duplicates dropped, first occurrence and order kept. */
export function uniqueAddresses(addresses: readonly Address[]): Address[] {
  const seen = new Set<string>();
  return addresses.filter((a) => {
    const key = a.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The LegalBodyFactory addresses the monitor watches: the configured LEGAL_BODY_FACTORY_ADDRESS
 * (when set) and MONITOR_WATCH_LEGAL_BODY_FACTORIES. After a factory redeploy the old factory goes
 * on the watch list, so its ownership events and the bodies it created stay watched.
 */
export function watchedLegalBodyFactories(
  configured: Address | undefined,
  watch: readonly Address[],
): Address[] {
  return uniqueAddresses([...(configured ? [configured] : []), ...watch]);
}

export interface MonitorDeps {
  rpc: MonitorRpc;
  store: MonitorStore;
  entities: EntityLookup;
  sink: AlertSink;
  cfg: MonitorConfig;
  now?: () => number;
  log?: (event: string, fields?: Record<string, unknown>) => void;
  /** The factory whose `beacon()` is resolved lazily. Absent = nothing to resolve. */
  beaconSource?: Address;
  /** Injected for tests; production passes viem's `beacon()` read. */
  readBeacon?: (factory: Address) => Promise<Address>;
}

export class Monitor {
  private readonly now: () => number;
  private readonly log: (event: string, fields?: Record<string, unknown>) => void;
  /** Adaptive: starts at the configured ceiling, halves whenever the RPC refuses a window wider
   *  than MIN_LOG_RANGE. Different Arc endpoints enforce different limits (see scan.ts). */
  private currentRange: bigint;
  /** Adaptive, for the node's other limit: how many of our addresses go in one getLogs. Starts at
   *  MAX_LOG_ADDRESSES and halves (never below 1) when the node refuses a window already too small
   *  to be the problem. Neither this nor `currentRange` grows back by itself: a restart resets
   *  both. */
  private currentAddressChunk: number = MAX_LOG_ADDRESSES;
  /** Beacons discovered from `factory.beacon()`, merged with the configured list. */
  private resolvedBeacons: Address[] = [];
  private beaconResolved = false;
  private lastEntities: MonitoredEntity[] = [];
  /** The API's legal bodies as last read; reused when a read fails, like `lastEntities`. */
  private lastRecordedBodies: LegalBodyRecord[] = [];
  /** Bodies seen created on chain: the store's table, plus any sighting the store failed to
   *  write, so a full disk cannot drop a body from the watch for the life of the process. */
  private sightedBodies = new Map<string, SeenLegalBody>();
  private stopped = false;
  private timer?: NodeJS.Timeout;

  constructor(private readonly deps: MonitorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? opsLog;
    this.currentRange = deps.cfg.maxLogRange ?? MAX_LOG_RANGE;
  }

  /** The window size currently in use — exposed for tests and for the ops log. */
  logRange(): bigint {
    return this.currentRange;
  }

  /**
   * The configured factory's beacon is not an env var — it is a fact on the chain. Resolved once,
   * but RETRIED every tick until it succeeds: if the RPC was down at startup we must not silently
   * run forever with rule 6 disabled on the beacon that matters most.
   */
  private async ensureBeacon(): Promise<void> {
    if (this.beaconResolved || !this.deps.beaconSource || !this.deps.readBeacon) {
      this.beaconResolved = true;
      return;
    }
    try {
      const beacon = await this.deps.readBeacon(this.deps.beaconSource);
      this.resolvedBeacons = [beacon];
      this.beaconResolved = true;
      this.log("monitor_beacon_resolved", { factory: this.deps.beaconSource, beacon });
    } catch (err) {
      this.log("monitor_beacon_unresolved", {
        factory: this.deps.beaconSource,
        message: (err as Error).message,
      });
    }
  }

  /**
   * Entities drive three rules. A lookup failure degrades those rules for one tick — the last
   * known set is reused rather than dropped, so a locked DB does not blind the treasury watch.
   *
   * EVERY mid-run failure is treated this way, a schema error included (review F4). A column that
   * vanishes under a running monitor means the file was replaced (a restore, a litestream
   * recovery) and the next tick reconnects; dropping the entity set because of it would blind the
   * watch at exactly the moment the box is being operated on. The deploy-order case — starting
   * against a database the API has not migrated — is caught before the loop starts, by
   * `assertLookupSchema` in the composition root, where it is fatal.
   */
  private refreshEntities(): MonitoredEntity[] {
    try {
      this.lastEntities = this.deps.entities.all();
    } catch (err) {
      this.log("monitor_entity_lookup_failed", {
        message: (err as Error).message,
        usingCached: this.lastEntities.length,
      });
    }
    return this.lastEntities;
  }

  /**
   * The legal-body watch set, rebuilt each tick from the API's `legal_bodies` and the monitor's
   * own `legal_bodies_seen`. A failure on either side keeps that side's last known set, for the
   * reason `refreshEntities` gives.
   */
  private refreshLegalBodies(): Map<string, WatchedLegalBody> {
    try {
      this.lastRecordedBodies = this.deps.entities.legalBodies();
    } catch (err) {
      this.log("monitor_legal_body_lookup_failed", {
        message: (err as Error).message,
        usingCached: this.lastRecordedBodies.length,
      });
    }
    try {
      for (const b of this.deps.store.listLegalBodies()) this.sightedBodies.set(b.address, b);
    } catch (err) {
      this.log("monitor_legal_body_sightings_read_failed", {
        message: (err as Error).message,
        usingCached: this.sightedBodies.size,
      });
    }
    return indexLegalBodies(this.lastRecordedBodies, [...this.sightedBodies.values()]);
  }

  private buildContext(
    index: EntityIndex,
    legalBodies: Map<string, WatchedLegalBody>,
  ): RuleContext {
    const { cfg } = this.deps;
    return {
      controller: cfg.controller,
      registry: cfg.registry,
      factories: new Set(cfg.factories.map((a) => a.toLowerCase())),
      beacons: new Set([...cfg.beacons, ...this.resolvedBeacons].map((a) => a.toLowerCase())),
      legalBodyFactories: new Set(cfg.legalBodyFactories.map((a) => a.toLowerCase())),
      legalBodies,
      executor: cfg.executor,
      standingRoles: standingRoles(),
      entities: index,
    };
  }

  /** One poll: resolve the beacon, refresh entities, scan new blocks, sweep grant TTLs. */
  async tick(): Promise<void> {
    await this.ensureBeacon();
    const entities = this.refreshEntities();
    const index = indexEntities(entities);
    const ctx = this.buildContext(index, this.refreshLegalBodies());

    await this.scan(ctx, index);
    await this.sweepGrantTtl(ctx);
  }

  /**
   * Run each log through the rules and apply what they return. Returns the legal bodies whose
   * creation the logs recorded, already added to the monitor's own set.
   */
  private async evaluateLogs(logs: readonly RawLog[], ctx: RuleContext): Promise<SeenLegalBody[]> {
    const created: SeenLegalBody[] = [];
    for (const log of logs) {
      try {
        const outcome = await evaluateLog(log, ctx, {
          now: this.now,
          currentPayout: (t) => this.readPayoutAddress(t),
          pendingAmendment: (factory, body) => this.readPendingAmendment(factory, body),
        });
        for (const body of outcome.legalBodies ?? []) {
          this.recordLegalBody(body);
          created.push(body);
        }
        const grants = await this.stampGrantTimestamps(outcome.grants);
        this.applyGrants(grants);
        for (const alert of outcome.alerts) await this.deps.sink.emit(alert);
      } catch (err) {
        // A single undecodable log must not abort the window; record it and move on.
        this.log("monitor_log_eval_failed", {
          tx: log.transactionHash,
          logIndex: log.logIndex,
          message: (err as Error).message,
        });
      }
    }
    return created;
  }

  /** In memory first, so a store that cannot be written still leaves the body watched. */
  private recordLegalBody(body: SeenLegalBody): void {
    if (!this.sightedBodies.has(body.address)) this.sightedBodies.set(body.address, body);
    try {
      this.deps.store.recordLegalBody(body);
    } catch (err) {
      this.log("monitor_legal_body_record_failed", {
        body: body.address,
        message: (err as Error).message,
      });
    }
  }

  private async scan(initialCtx: RuleContext, index: EntityIndex): Promise<void> {
    let ctx = initialCtx;
    const { rpc, store, cfg } = this.deps;
    let latest: bigint;
    try {
      latest = await rpc.getBlockNumber();
    } catch (err) {
      this.log("monitor_head_read_failed", { message: (err as Error).message });
      return;
    }

    const cursor = store.getCursor();
    const from = cursor === undefined ? coldStartFrom(latest, cfg.lookbackBlocks) : cursor + 1n;
    if (from > latest) return; // no new blocks since the last tick.

    let own: Address[] = uniqueAddresses([
      cfg.controller,
      ...cfg.factories,
      ...cfg.legalBodyFactories,
      ...cfg.beacons,
      ...this.resolvedBeacons,
      ...[...index.byTreasury.values()].map((e) => e.treasury as Address),
      // The LegalManager proxies (design §8). Until PR 3 they were unwatched, which meant the OA
      // amendment path — the one governance action with a timelock and a guardian veto — emitted
      // its events into a monitor that was not looking.
      ...[...index.byProxy.values()].map((e) => e.proxy as Address),
      // The legal bodies: the guardian's dissolution path and the amendment path of the product
      // where the customer keeps their own company.
      ...[...ctx.legalBodies.keys()].map((a) => a as Address),
    ]);
    const agentIds = [...index.byAgentId.keys()];

    for (const range of chunkRange(from, latest, this.currentRange)) {
      let logs: Awaited<ReturnType<typeof fetchWindow>>;
      try {
        logs = await fetchWindow(
          rpc,
          { own, registry: cfg.registry, agentIds },
          range,
          this.currentAddressChunk,
        );
      } catch (err) {
        // "Query too large" is not a chain problem, it is OUR request — shrink it so the next tick
        // can actually make progress. Without this the monitor stays up, logs forever and never
        // advances its cursor, which looks exactly like a quiet chain.
        //
        // The node answers with the same error for two different limits: a block window that is
        // too wide, and too many addresses in one query (see scan.ts). The window that was refused
        // tells them apart, not `currentRange`: one wider than MIN_LOG_RANGE shrinks the window, as
        // it always has; one already that small cannot be refused for its blocks, so the address
        // chunk is halved instead. Shrinking the window there would walk it down to the floor
        // without ever advancing. Either way the tick stops here and the cursor stays.
        if (isRangeTooLargeError(err)) {
          const width = range.to - range.from + 1n;
          // A window wider than the floor implies `currentRange` is too, so this is never
          // undefined when the window is wide.
          const nextRange = width > MIN_LOG_RANGE ? shrinkRange(this.currentRange) : undefined;
          if (nextRange !== undefined) {
            this.currentRange = nextRange;
            this.log("monitor_range_reduced", {
              range: nextRange.toString(),
              reason: "rpc rejected the block range",
            });
          } else if (this.currentAddressChunk > 1) {
            this.currentAddressChunk = Math.max(1, Math.floor(this.currentAddressChunk / 2));
            this.log("monitor_address_chunk_reduced", {
              addressChunk: this.currentAddressChunk,
              reason: "rpc rejected a small window: too many addresses in one query",
            });
          } else {
            this.log("monitor_range_floor_reached", {
              level: "error",
              range: this.currentRange.toString(),
              message: (err as Error).message,
            });
          }
          return;
        }
        // Stop here, keep the cursor where it is: the next tick retries THIS chunk. Continuing to
        // the next chunk would advance past blocks we never read.
        this.log("monitor_scan_failed", {
          from: range.from.toString(),
          to: range.to.toString(),
          message: (err as Error).message,
        });
        return;
      }

      const created = await this.evaluateLogs(logs, ctx);

      // A body created inside this window was not in `own` when the window was read, so anything
      // it emitted later in the same window (a dissolution started right after creation, say)
      // was not fetched. Read those bodies over the same window before the cursor passes it. If
      // the read fails the cursor stays, and the next tick re-reads the window with the bodies in
      // `own`; the alert dedup key makes the repeat free.
      const unwatched = uniqueAddresses(
        created.map((b) => b.address as Address).filter((a) => !ctx.legalBodies.has(a)),
      );
      if (unwatched.length > 0) {
        const legalBodies = new Map(ctx.legalBodies);
        for (const b of created)
          if (!legalBodies.has(b.address))
            legalBodies.set(b.address, {
              address: b.address,
              factory: b.factory,
              agentId: b.agentId,
              guardian: b.guardian,
            });
        ctx = { ...ctx, legalBodies };
        let late: Awaited<ReturnType<typeof fetchWindow>>;
        try {
          late = await fetchWindow(
            rpc,
            { own: unwatched, registry: cfg.registry, agentIds: [] },
            range,
            this.currentAddressChunk,
          );
        } catch (err) {
          this.log("monitor_new_legal_body_scan_failed", {
            from: range.from.toString(),
            to: range.to.toString(),
            bodies: unwatched,
            message: (err as Error).message,
          });
          return;
        }
        // Only the new bodies' own logs: the registry query fetchWindow always adds was already
        // read with the window.
        const lowered = new Set(unwatched.map((a) => a.toLowerCase()));
        await this.evaluateLogs(
          late.filter((l) => lowered.has(l.address.toLowerCase())),
          ctx,
        );
        // Later windows of this tick read them with everything else.
        own = uniqueAddresses([...own, ...unwatched]);
      }

      store.setCursor(range.to);
    }
    this.log("monitor_scanned", {
      from: from.toString(),
      to: latest.toString(),
      watched: own.length,
      agents: agentIds.length,
      range: this.currentRange.toString(),
      addressChunk: this.currentAddressChunk,
    });
  }

  /**
   * Replace the observation time on new grants with the BLOCK time. Matters after downtime: a
   * grant made 40 minutes ago must page immediately on restart, not 15 minutes after we noticed it.
   * One read per distinct block, and the observation time stands if the read fails.
   */
  private async stampGrantTimestamps(grants: readonly GrantOp[]): Promise<GrantOp[]> {
    const cache = new Map<string, number>();
    const out: GrantOp[] = [];
    for (const g of grants) {
      if (g.kind !== "open") {
        out.push(g);
        continue;
      }
      const key = g.block.toString();
      let ts = cache.get(key);
      if (ts === undefined) {
        try {
          ts = Number(await this.deps.rpc.getBlockTimestamp(g.block)) * 1000;
        } catch {
          ts = g.ts;
        }
        cache.set(key, ts);
      }
      out.push({ ...g, ts });
    }
    return out;
  }

  private applyGrants(grants: readonly GrantOp[]): void {
    for (const g of grants) {
      if (g.kind === "open")
        this.deps.store.openGrant({
          role: g.role,
          account: g.account,
          grantedAtBlock: g.block,
          grantedAtTs: g.ts,
        });
      else this.deps.store.closeGrant(g.role, g.account);
    }
  }

  private async readPayoutAddress(treasury: Address): Promise<Address | undefined> {
    try {
      return (await this.deps.rpc.readContract({
        address: treasury,
        abi: agentTreasuryAbi,
        functionName: "payoutAddress",
      })) as Address;
    } catch (err) {
      // Unreadable, not unchanged: the alert says "unreadable" and stays at WARN rather than
      // claiming the payout address is fine.
      this.log("monitor_payout_read_failed", { treasury, message: (err as Error).message });
      return undefined;
    }
  }

  private async readPendingAmendment(factory: Address, body: Address): Promise<Hex | undefined> {
    try {
      return (await this.deps.rpc.readContract({
        address: factory,
        abi: legalBodyFactoryAbi,
        functionName: "pendingAmendment",
        args: [body],
      })) as Hex;
    } catch (err) {
      // Unreadable, not matching: the amendment rule escalates rather than trusting a guess.
      this.log("monitor_pending_amendment_read_failed", {
        factory,
        body,
        message: (err as Error).message,
      });
      return undefined;
    }
  }

  private async sweepGrantTtl(ctx: RuleContext): Promise<void> {
    const { store, cfg, sink } = this.deps;
    // A row can become permanent after it was opened: the standing set grows with a release (the
    // two legal-body grants joined it this way), and a grant made while an older build was running
    // was stored as a ceremony grant. The executor never revokes a standing grant, and a revoke is
    // the only other thing that closes a row, so such a row would page CRITICAL every interval,
    // forever. It is closed instead, with one trail line and an INFO record, and no page.
    const permanent: OpenGrant[] = [];
    const open: OpenGrant[] = [];
    for (const g of store.listOpenGrants())
      (isPermanentGrant(g.role, g.account, ctx) ? permanent : open).push(g);

    // Page FIRST. Closing a row is a write, and a store that cannot be written (a full disk, a
    // read-only remount) must not be able to stop a page for a grant that is still overdue.
    const escalations = ttlEscalations(open, this.now(), cfg.grantTtlMs, cfg.controller);
    for (const e of escalations) {
      await sink.emit(e.alert);
      store.setGrantAlertedCount(e.role, e.account, e.alertedCount);
    }

    // Only then the housekeeping, one row at a time: a close that fails is logged and the row is
    // left in place, so the next tick tries again and the other rows are still closed. The INFO
    // alert is what stays in the alert log to explain why the TTL pages for this grant stopped.
    for (const g of permanent) {
      try {
        store.closeGrant(g.role, g.account);
        this.log("monitor_grant_now_standing", { role: g.role, account: g.account });
        await sink.emit(grantNowStandingAlert(g, cfg.controller, this.now()));
      } catch (err) {
        this.log("monitor_grant_now_standing_failed", {
          role: g.role,
          account: g.account,
          message: (err as Error).message,
        });
      }
    }
  }

  /** Poll forever. Each tick is fully guarded — the loop is scheduled again no matter what. */
  start(): void {
    const loop = async () => {
      if (this.stopped) return;
      try {
        await this.tick();
      } catch (err) {
        this.log("monitor_tick_failed", { message: (err as Error).message });
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.deps.cfg.pollMs);
    };
    void loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }
}
