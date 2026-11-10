import { KLEROS_DEPLOYMENTS, type KlerosDeployment } from "../adapters/kleros/deployments";
import type { CourtClock } from "../adapters/kleros/disputeService";
import {
  KlerosHttpError,
  KlerosRefusal,
  KlerosTransportError,
  KlerosWrongDeploymentError,
} from "../adapters/kleros/errors";
import { FakeDisputeService } from "../adapters/kleros/fakeDisputeService";
import { publicErrorMessage } from "../workflow/publicError";
import type { KlerosStage } from "./composition";
import { withoutEmDash } from "./job";

/**
 * THE KLEROS CHECK: what the stage's Dispute Service answers to the three reads a filing believes,
 * and every problem in the answers. Reads only; nothing here can write.
 *
 *  - `tools/list` must hold the three write tools the key's preset grants.
 *  - The `instructions` string a key answers on `initialize` says, in one sentence, what its
 *    filing sends ("this call sends them: court 8, 5 jurors, on arbitrum-sepolia-testnet"), and
 *    the docs say to believe it over any page. It is printed in full. That sentence must be there,
 *    every copy of it must agree, and its court, juror count and chain must be the stage's; the rest of the string is
 *    general text that names every chain the service reads, the live one included, and is not
 *    held to the stage. On a real deployment a missing string, or one without the sentence, is a
 *    problem, since a filing has nothing to believe then. A stage with no deployment (a
 *    rehearsal) must answer the fake's own string: a rehearsal files with the fake only.
 *  - `court_get` on the stage's own chain and court must answer, with an evidence period of at
 *    least five minutes: the evidence is submitted within it, and a shorter one is not the court
 *    Kleros described.
 *
 * Every read is tried, so one run names every problem. A refused key (HTTP 401) is named once,
 * by a fixed sentence: the key itself never reaches a problem.
 */
export interface KlerosCheckResult {
  deployment: KlerosDeployment | null;
  tools: string[];
  instructions: string | null;
  court: CourtClock | null;
  problems: string[];
}

/** The three writes of a filing, which the key's preset must grant. */
export const WRITE_TOOLS: readonly string[] = Object.freeze([
  "evidence_pin",
  "dispute_create",
  "evidence_submit",
]);

/** The shortest evidence period a filing accepts, in seconds. */
export const MIN_EVIDENCE_PERIOD_SECONDS = 300;

/** The one problem a refused key gives, whichever read met it. */
export const UNAUTHORIZED_PROBLEM =
  "the Dispute Service refused this stage's key (HTTP 401): the key is wrong or revoked";

/** The most of a Kleros text an event, a row or an outcome keeps, by default. */
const KLEROS_TEXT_SHORT = 300;

/**
 * A scheme-ful URL, a credential named by its label, and a hex run longer than a hash: the three
 * shapes `publicErrorMessage` strips from a text, with the same rules.
 */
const URL_RUN = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)}\\]+/gi;
const LABELLED_SECRET =
  /\b(authorization|bearer|api[-_ ]?key|apikey|x-api-key|token|secret|seed|private[-_ ]?key)\b(\s*["']?\s*[:=]\s*["']?\s*|\s+)([A-Za-z0-9._~+/=-]{12,})/gi;
const LONG_HEX = /0x[0-9a-fA-F]{65,}/g;
/**
 * An absolute file path: a slash that starts no URL and no word, one directory or more, then the
 * file. An IPFS address (`/ipfs/<cid>`) is a content address, not a path of this box, and stays.
 */
const ABSOLUTE_PATH = /(?<![\w.:/~-])\/(?!ipfs\/)(?:[^\s'"`/()<>,;]+\/)+([^\s'"`/()<>,;]+)/g;

/** Every absolute path in `text` cut to its file name: the box's layout is nobody's to read. */
export function withoutPaths(text: string): string {
  return text.replace(ABSOLUTE_PATH, "$1");
}

/** One of the Kleros client's own failures: a refusal of the service, an HTTP status, an answer
 *  it could not read or never got, or a read that names another deployment. */
export type KlerosError =
  | KlerosRefusal
  | KlerosHttpError
  | KlerosTransportError
  | KlerosWrongDeploymentError;

/** Whether `e` is one of the Kleros client's own failures ({KlerosError}): Kleros's answer, or
 *  the lack of one, never the platform's. */
export function isKlerosError(e: unknown): e is KlerosError {
  return (
    e instanceof KlerosRefusal ||
    e instanceof KlerosHttpError ||
    e instanceof KlerosTransportError ||
    e instanceof KlerosWrongDeploymentError
  );
}

/**
 * A Kleros text (a refusal, an HTTP status, an answer the client could not read, an `unknown`
 * result) as an event, a row or an outcome keeps it: the code and the service's own words, with
 * URL paths, labelled credentials and absolute file paths redacted, on one line, cut at `max`
 * characters. Never
 * `publicErrorMessage`'s fixed sentences: a fee wallet's "insufficient funds" is Kleros's, not
 * the platform's. The client keeps up to 4,000 characters of a filing's answer it could not read,
 * where a person finds the dispute's ids, so the create and the submit pass a larger `max`. Any
 * other error goes through `publicErrorMessage` as before.
 */
export function klerosTextOf(e: unknown, max: number = KLEROS_TEXT_SHORT): string {
  const kleros = typeof e === "string" || isKlerosError(e);
  if (!kleros) return withoutEmDash(withoutPaths(publicErrorMessage(e)));
  const text = (typeof e === "string" ? e : e.message)
    .replace(URL_RUN, originOf)
    .replace(LABELLED_SECRET, (_m, label: string, sep: string) => `${label}${sep}<redacted>`)
    .replace(LONG_HEX, (hex) => `${hex.slice(0, 10)}...`)
    .replace(ABSOLUTE_PATH, "$1")
    .replace(/\s+/g, " ")
    .trim();
  const cut = text.length > max ? `${text.slice(0, max - 3)}...` : text;
  return withoutEmDash(cut);
}

/** `https://host`: the scheme and the host, never the path, the query or the user. */
function originOf(raw: string): string {
  try {
    const u = new URL(raw);
    return u.origin !== "null" ? u.origin : `${u.protocol}//${u.host}`;
  } catch {
    return `${raw.split("://")[0]}://(redacted)`;
  }
}

/**
 * The one sentence of a key's instructions that says what its filing sends, as Kleros words it:
 * "The court, juror count and template are fixed for you, and this call sends them: court 8,
 * 5 jurors, on arbitrum-sepolia-testnet." The rest of the string is general text that lists every
 * chain the service reads, the live one included, so only this sentence is held to the stage.
 * The chain ends at a full stop, a comma, a space or the end: a longer name such as
 * "arbitrum-sepolia-testnet_v2" is not read as its first part, and the sentence counts as missing.
 */
const SENDS_SENTENCE =
  /\bthis call sends them:\s*court\s+(\d+)\s*,\s*(\d+)\s+jurors?\s*,\s*on\s+([a-z0-9]+(?:-[a-z0-9]+)*)(?![A-Za-z0-9_]|[.-][A-Za-z0-9_]|\P{ASCII})/giu;

/**
 * The court a stage without a deployment reads: a rehearsal rehearses the testnet stage, which
 * Kleros asks every flow to go through first.
 */
const REHEARSAL_COURT_ID = KLEROS_DEPLOYMENTS.testnet.courtId;

/** tools/list, instructions(), court_get on the stage's chain and court: reads only. */
export async function checkKleros(stage: KlerosStage): Promise<KlerosCheckResult> {
  const { deployment } = stage;
  const problems: string[] = [];
  const result: KlerosCheckResult = {
    deployment,
    tools: [],
    instructions: null,
    court: null,
    problems,
  };
  // A stage with no deployment is a rehearsal's, and only the fake may answer for it: the real
  // client is not even asked.
  if (deployment === null && !(stage.service instanceof FakeDisputeService)) {
    problems.push(
      "a stage with no Kleros deployment answers with the fake Dispute Service only, and this one holds another client: nothing was read",
    );
    return result;
  }
  const failed = (what: string, e: unknown) => {
    if (e instanceof KlerosHttpError && e.status === 401) {
      if (!problems.includes(UNAUTHORIZED_PROBLEM)) problems.push(UNAUTHORIZED_PROBLEM);
    } else problems.push(`${what}: ${klerosTextOf(e)}`);
  };

  try {
    result.tools = await stage.service.listTools();
    const missing = WRITE_TOOLS.filter((t) => !result.tools.includes(t));
    if (missing.length > 0)
      problems.push(
        `tools/list does not list the write tool${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
      );
  } catch (e) {
    failed("tools/list did not answer", e);
  }

  try {
    result.instructions = await stage.service.instructions();
    problems.push(...(await instructionsProblems(result.instructions, deployment)));
  } catch (e) {
    failed("initialize did not answer", e);
  }

  const chain = deployment?.chain ?? "fake";
  const courtId = deployment?.courtId ?? REHEARSAL_COURT_ID;
  try {
    const court = await stage.service.getCourt({ chain, courtId });
    result.court = court;
    const evidence = court.timesPerPeriod[0];
    if (evidence < MIN_EVIDENCE_PERIOD_SECONDS)
      problems.push(
        `the evidence period of court ${courtId} on ${chain} is ${evidence} s, under ${MIN_EVIDENCE_PERIOD_SECONDS} s`,
      );
  } catch (e) {
    failed(`court_get for court ${courtId} on ${chain} did not answer`, e);
  }
  return result;
}

/** What the instructions string says against the stage, as problems; none when it agrees. */
async function instructionsProblems(
  text: string | null,
  deployment: KlerosDeployment | null,
): Promise<string[]> {
  if (deployment === null) {
    const fake = await new FakeDisputeService({ script: "pay" }).instructions();
    return text === fake
      ? []
      : [
          "the rehearsal's Dispute Service does not answer the fake's own instructions: a rehearsal files with the fake only",
        ];
  }
  if (text === null)
    return [
      "the instructions string could not be read: it names the key's deployment and court, and a filing believes it over any document",
    ];
  const said = new Set(
    [...text.matchAll(SENDS_SENTENCE)].map(
      ([, court, jurors, chain]) => `${Number(court)}|${Number(jurors)}|${chain?.toLowerCase()}`,
    ),
  );
  if (said.size === 0)
    return [
      `the instructions never say what this key's filing sends ("this call sends them: court N, J jurors, on CHAIN"), and a filing believes that sentence, so nothing is filed: read the instructions with pilot:kleros check; if Kleros reworded the sentence, the check must follow the new wording, and if it is gone, ask Kleros what the key's preset sends`,
    ];
  if (said.size > 1)
    return [
      `the instructions say what this key's filing sends more than once, and differently (${[
        ...said,
      ]
        .map((s) => {
          const [court, jurors, chain] = s.split("|");
          return `court ${court}, ${jurors} jurors, on ${chain}`;
        })
        .join("; ")}): nothing is filed until they agree`,
    ];
  const [court, jurors, chain] = ([...said][0] as string).split("|") as [string, string, string];
  const found: string[] = [];
  if (chain !== deployment.chain)
    found.push(
      `the instructions say this key files on ${chain}, and this stage files on ${deployment.chain}`,
    );
  if (Number(court) !== deployment.courtId)
    found.push(
      `the instructions say this key files in court ${court}, and this stage files in court ${deployment.courtId}`,
    );
  if (Number(jurors) !== deployment.jurors)
    found.push(
      `the instructions say this key's filing sends ${jurors} juror${jurors === "1" ? "" : "s"}, and this stage expects ${deployment.jurors}`,
    );
  return found;
}
