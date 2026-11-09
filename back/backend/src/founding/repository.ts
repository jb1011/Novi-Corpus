import type Sqlite from "better-sqlite3";

/** The open database handle. `better-sqlite3`'s default export is a namespace, not this. */
export type Database = Sqlite.Database;

export type NewApplication = {
  id: string;
  createdAt: number;
  email: string;
  xHandle: string | null;
  agentName: string;
  description: string;
  utm: Record<string, string> | null;
};

export function insertApplication(db: Database, row: NewApplication): void {
  db.prepare(
    `INSERT INTO founding_applications (
       id, created_at, email, x_handle, agent_name, description, utm, via, status
     ) VALUES (
       @id, @created_at, @email, @x_handle, @agent_name, @description, @utm, 'web', 'new'
     )`,
  ).run({
    id: row.id,
    created_at: row.createdAt,
    email: row.email,
    x_handle: row.xHandle,
    agent_name: row.agentName,
    description: row.description,
    utm: row.utm ? JSON.stringify(row.utm) : null,
  });
}
