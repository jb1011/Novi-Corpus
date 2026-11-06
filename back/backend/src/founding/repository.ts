import type Sqlite from "better-sqlite3";

/** The open database handle. `better-sqlite3`'s default export is a namespace, not this. */
export type Database = Sqlite.Database;

export const APPLICATION_STATUSES = ["new", "shortlist", "winner", "rejected", "waitlist"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

export type NewApplication = {
  id: string;
  createdAt: number;
  email: string;
  xHandle: string | null;
  agentName: string;
  description: string;
  utm: Record<string, string> | null;
  ipHash: string | null;
};

export type ApplicationListItem = {
  id: string;
  createdAt: number;
  email: string;
  xHandle: string | null;
  agentName: string;
  status: ApplicationStatus;
  reviewCount: number;
  /** Null until three reviewers have scored it, so one high score cannot float it. */
  averageScore: number | null;
};

export type Review = {
  reviewer: string;
  useCase: number;
  moneyFlow: number;
  builder: number;
  note: string | null;
  updatedAt: number;
};

export type ApplicationDetail = ApplicationListItem & {
  description: string;
  utm: Record<string, string> | null;
  via: "web" | "mcp";
  reviews: Review[];
};

export type ListQuery = {
  status: ApplicationStatus | null;
  sort: "score" | "date";
  dir: "asc" | "desc";
};

type ListRow = {
  id: string;
  created_at: number;
  email: string;
  x_handle: string | null;
  agent_name: string;
  status: ApplicationStatus;
  review_count: number;
  average_score: number | null;
};

const LIST_SELECT = `
  SELECT
    a.id, a.created_at, a.email, a.x_handle, a.agent_name, a.status,
    (SELECT COUNT(*) FROM founding_reviews r WHERE r.application_id = a.id) AS review_count,
    CASE
      WHEN (SELECT COUNT(*) FROM founding_reviews r WHERE r.application_id = a.id) = 3
      THEN (
        SELECT AVG((r.use_case + r.money_flow + r.builder) / 3.0)
        FROM founding_reviews r WHERE r.application_id = a.id
      )
      ELSE NULL
    END AS average_score
  FROM founding_applications a
`;

export function insertApplication(db: Database, row: NewApplication): void {
  db.prepare(
    `INSERT INTO founding_applications (
       id, created_at, email, x_handle, agent_name, description, utm, via, status, ip_hash
     ) VALUES (
       @id, @created_at, @email, @x_handle, @agent_name, @description, @utm, 'web', 'new', @ip_hash
     )`,
  ).run({
    id: row.id,
    created_at: row.createdAt,
    email: row.email,
    x_handle: row.xHandle,
    agent_name: row.agentName,
    description: row.description,
    utm: row.utm ? JSON.stringify(row.utm) : null,
    ip_hash: row.ipHash,
  });
}

export function listApplications(db: Database, query: ListQuery): ApplicationListItem[] {
  const order =
    query.sort === "score"
      ? `ORDER BY average_score IS NULL, average_score ${query.dir === "asc" ? "ASC" : "DESC"}, a.created_at DESC`
      : `ORDER BY a.created_at ${query.dir === "asc" ? "ASC" : "DESC"}`;
  const rows = db
    .prepare(
      `${LIST_SELECT}
       WHERE (@status IS NULL OR a.status = @status)
       ${order}`,
    )
    .all({ status: query.status }) as ListRow[];
  return rows.map(toListItem);
}

export function findApplication(db: Database, id: string): ApplicationDetail | null {
  const row = db.prepare(`${LIST_SELECT} WHERE a.id = ?`).get(id) as ListRow | undefined;
  if (!row) return null;
  // The list projection does not include the long fields. Read them off the same row with a
  // second statement rather than widening every list query.
  const extra = db
    .prepare("SELECT description, utm, via FROM founding_applications WHERE id = ?")
    .get(id) as {
    description: string;
    utm: string | null;
    via: "web" | "mcp";
  };
  const reviews = db
    .prepare(
      `SELECT reviewer, use_case, money_flow, builder, note, updated_at
         FROM founding_reviews WHERE application_id = ? ORDER BY updated_at ASC`,
    )
    .all(id) as {
    reviewer: string;
    use_case: number;
    money_flow: number;
    builder: number;
    note: string | null;
    updated_at: number;
  }[];
  return {
    ...toListItem(row),
    description: extra.description,
    utm: parseJson(extra.utm),
    via: extra.via,
    reviews: reviews.map((review) => ({
      reviewer: review.reviewer,
      useCase: review.use_case,
      moneyFlow: review.money_flow,
      builder: review.builder,
      note: review.note,
      updatedAt: review.updated_at,
    })),
  };
}

export function setApplicationStatus(db: Database, id: string, status: ApplicationStatus): boolean {
  const existing = db.prepare("SELECT id FROM founding_applications WHERE id = ?").get(id);
  if (!existing) return false;
  db.prepare("UPDATE founding_applications SET status = ? WHERE id = ?").run(status, id);
  return true;
}

export function upsertReview(db: Database, review: Review & { applicationId: string }): boolean {
  const existing = db
    .prepare("SELECT id FROM founding_applications WHERE id = ?")
    .get(review.applicationId);
  if (!existing) return false;
  db.prepare(
    `INSERT INTO founding_reviews (
       application_id, reviewer, use_case, money_flow, builder, note, updated_at
     ) VALUES (
       @application_id, @reviewer, @use_case, @money_flow, @builder, @note, @updated_at
     )
     ON CONFLICT(application_id, reviewer) DO UPDATE SET
       use_case = excluded.use_case,
       money_flow = excluded.money_flow,
       builder = excluded.builder,
       note = excluded.note,
       updated_at = excluded.updated_at`,
  ).run({
    application_id: review.applicationId,
    reviewer: review.reviewer,
    use_case: review.useCase,
    money_flow: review.moneyFlow,
    builder: review.builder,
    note: review.note,
    updated_at: review.updatedAt,
  });
  return true;
}

function toListItem(row: ListRow): ApplicationListItem {
  return {
    id: row.id,
    createdAt: row.created_at,
    email: row.email,
    xHandle: row.x_handle,
    agentName: row.agent_name,
    status: row.status,
    reviewCount: row.review_count,
    averageScore: row.average_score === null ? null : Number(row.average_score),
  };
}

function parseJson<T>(raw: string | null): T | null {
  if (!raw) return null;
  return JSON.parse(raw) as T;
}
