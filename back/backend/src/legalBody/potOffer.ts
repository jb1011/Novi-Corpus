import { PotContractsNotVerifiedError } from "../adapters/arc/safePotChain";

/**
 * WHETHER THIS PROCESS OFFERS THE COMPANY'S POT (Rulings R1 and R11): one live flag, set only when
 * the start-up check of the seven contracts the pot is built from resolves
 * (`assertPotContracts`). The flag decides both `/config.legalBodies.pot` and whether the pot's
 * note door and the agent's two pot tools answer: they are mounted at boot and answer
 * `pot_not_offered` while it is off. The guardian's read of the body's notes and the off-record
 * door take no flag (Rulings R27 and R15 a): neither reads a chain, and a pot on the record can
 * always be taken off it.
 *
 * The check never stops the server: it is started, never awaited, so legal bodies, formation and
 * everything else boot and run in every outcome, and the pot alone stays off. ANY error turns the
 * pot off. The error's class and reason choose only the log line and whether the check is tried
 * again:
 *  - `PotContractsNotVerifiedError` with reason `unreadable` (a node that could not be read):
 *    tried again once a minute, until the check resolves, when the flag turns on;
 *  - with reason `mismatch` (a contract holds no code or other code, or the check was handed a
 *    table it cannot use), and any other error (a bug): off until a restart.
 * The error's message, which names contracts, addresses and hashes, goes to the boot log only,
 * never into an answer: a door answers the fixed sentence of `pot_not_offered`.
 */

/** How long after a check that could not read the chain the next one starts. */
export const POT_CONTRACTS_RETRY_MS = 60_000;

/** The pot's flag, and its retry. */
export interface PotContractsGate {
  /** True only once a check has resolved: the seven contracts hold the pinned code. */
  offered(): boolean;
  /** Settles when the first check has, whichever way: never rejects. */
  readonly firstCheck: Promise<void>;
  /** Ends the retry: no check starts after it (shutdown). */
  stop(): void;
}

type Log = (level: "info" | "error", line: string) => void;

const consoleLog: Log = (level, line) => {
  if (level === "error") console.error(line);
  else console.log(line);
};

/** The boot line of a check that did not resolve: the named error's own message (it begins with its
 *  reason), or the name and first line of any other. */
function notVerifiedLine(err: unknown): string {
  const why =
    err instanceof PotContractsNotVerifiedError
      ? err.message
      : err instanceof Error
        ? `unexpected ${err.name}: ${err.message.split("\n")[0]}`
        : "unexpected: the check threw something that is not an error";
  return `[boot] pot contracts NOT verified: ${why}`;
}

/**
 * Starts the check at once and answers the flag. `check` is the start-up check of the seven
 * contracts on `chainId`'s table; `log` writes the boot lines (the console unless given); the retry
 * is `retryMs` (once a minute unless given). The retry's timer never keeps the process alive.
 */
export function startPotContractsGate(p: {
  check: () => Promise<void>;
  chainId: number;
  log?: Log;
  retryMs?: number;
}): PotContractsGate {
  const log = p.log ?? consoleLog;
  const retryMs = p.retryMs ?? POT_CONTRACTS_RETRY_MS;
  let verified = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const attempt = async (): Promise<void> => {
    try {
      await p.check();
    } catch (err) {
      log("error", notVerifiedLine(err));
      const retry = err instanceof PotContractsNotVerifiedError && err.reason === "unreadable";
      if (retry && !stopped) {
        timer = setTimeout(() => {
          timer = undefined;
          void attempt();
        }, retryMs);
        timer.unref?.();
      }
      return;
    }
    verified = true;
    log("info", `[boot] pot contracts verified on-chain: 7 code hashes on chain ${p.chainId}`);
  };

  return {
    offered: () => verified,
    firstCheck: attempt(),
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}
