// Provena provenance graph — SQLite (built-in node:sqlite, zero native deps).
//
// The graph: sources (what the model saw) and artifacts (what it produced) are
// captured automatically by hooks. Links between them are computed on demand by
// the attribution engine (Phase 2). Phase 1 lays down capture + storage + query.

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type SourceType =
  | "file" // a file the model Read
  | "web" // a page fetched via WebFetch
  | "tool_result" // output of some other tool / MCP call
  | "user_msg" // a user instruction
  | "conversation"; // assistant/other turn

export interface SourceRow {
  id: number;
  uri: string;
  type: SourceType;
  content: string;
  content_hash: string;
  captured_at: string;
  session_id: string;
}

export interface ArtifactRow {
  id: number;
  path: string;
  content: string;
  content_hash: string;
  version: number;
  created_at: string;
  generator: string;
  session_id: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  uri          TEXT NOT NULL,
  type         TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  captured_at  TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  UNIQUE(content_hash, session_id)
);
CREATE TABLE IF NOT EXISTS artifact (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT NOT NULL,
  content      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  version      INTEGER NOT NULL,
  created_at   TEXT NOT NULL,
  generator    TEXT NOT NULL,
  session_id   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS span (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id INTEGER NOT NULL REFERENCES artifact(id),
  start_line  INTEGER NOT NULL,
  end_line    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  kind        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS link (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  span_id        INTEGER NOT NULL REFERENCES span(id),
  source_id      INTEGER REFERENCES source(id),
  confidence     REAL NOT NULL,
  method         TEXT NOT NULL,        -- declared | embedding | llm_judge
  evidence_quote TEXT,
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS embedding (
  content_hash TEXT PRIMARY KEY,
  vec          TEXT NOT NULL          -- JSON array of floats
);
CREATE INDEX IF NOT EXISTS idx_artifact_path ON artifact(path);
CREATE INDEX IF NOT EXISTS idx_span_artifact ON span(artifact_id);
`;

export function sha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Resolve the DB path. Per-project under .provena/, overridable by env. */
export function dbPath(cwd = process.cwd()): string {
  if (process.env.PROVENA_DB) return process.env.PROVENA_DB;
  return join(cwd, ".provena", "provenance.db");
}

export class Store {
  private db: DatabaseSync;

  constructor(path = dbPath()) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  /** Record something the model saw. Idempotent per (content, session). */
  addSource(s: {
    uri: string;
    type: SourceType;
    content: string;
    capturedAt: string;
    sessionId: string;
  }): number {
    const hash = sha(s.content);
    const existing = this.db
      .prepare("SELECT id FROM source WHERE content_hash=? AND session_id=?")
      .get(hash, s.sessionId) as { id: number } | undefined;
    if (existing) return existing.id;
    const info = this.db
      .prepare(
        `INSERT INTO source(uri,type,content,content_hash,captured_at,session_id)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(s.uri, s.type, s.content, hash, s.capturedAt, s.sessionId);
    return Number(info.lastInsertRowid);
  }

  /** Snapshot a generated artifact. Auto-increments version per path. */
  addArtifact(a: {
    path: string;
    content: string;
    createdAt: string;
    generator: string;
    sessionId: string;
  }): number {
    const hash = sha(a.content);
    const last = this.db
      .prepare("SELECT MAX(version) AS v FROM artifact WHERE path=?")
      .get(a.path) as { v: number | null };
    // skip if identical to the latest snapshot
    const latest = this.db
      .prepare(
        "SELECT content_hash FROM artifact WHERE path=? ORDER BY version DESC LIMIT 1",
      )
      .get(a.path) as { content_hash: string } | undefined;
    if (latest?.content_hash === hash) return -1;
    const version = (last.v ?? 0) + 1;
    const info = this.db
      .prepare(
        `INSERT INTO artifact(path,content,content_hash,version,created_at,generator,session_id)
         VALUES(?,?,?,?,?,?,?)`,
      )
      .run(a.path, a.content, hash, version, a.createdAt, a.generator, a.sessionId);
    return Number(info.lastInsertRowid);
  }

  latestArtifact(path: string): ArtifactRow | undefined {
    return this.db
      .prepare("SELECT * FROM artifact WHERE path=? ORDER BY version DESC LIMIT 1")
      .get(path) as ArtifactRow | undefined;
  }

  sourcesForSession(sessionId: string): SourceRow[] {
    return this.db
      .prepare("SELECT * FROM source WHERE session_id=? ORDER BY captured_at")
      .all(sessionId) as SourceRow[];
  }

  allSources(): SourceRow[] {
    return this.db
      .prepare("SELECT * FROM source ORDER BY captured_at")
      .all() as SourceRow[];
  }

  /** Record an explicit (model-declared) citation for a line range. */
  addDeclaredCitation(c: {
    path: string;
    startLine: number;
    endLine: number;
    sourceUri: string;
    evidence?: string;
    sessionId: string;
  }): { ok: boolean; reason?: string } {
    const art = this.latestArtifact(c.path);
    if (!art) return { ok: false, reason: `no captured artifact for ${c.path}` };
    const src = this.db
      .prepare("SELECT id FROM source WHERE uri=? ORDER BY captured_at DESC LIMIT 1")
      .get(c.sourceUri) as { id: number } | undefined;
    const text = art.content
      .split("\n")
      .slice(c.startLine - 1, c.endLine)
      .join("\n");
    const spanInfo = this.db
      .prepare(
        `INSERT INTO span(artifact_id,start_line,end_line,text,kind)
         VALUES(?,?,?,?,?)`,
      )
      .run(art.id, c.startLine, c.endLine, text, "block");
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO link(span_id,source_id,confidence,method,evidence_quote,created_at)
         VALUES(?,?,?,?,?,?)`,
      )
      .run(
        Number(spanInfo.lastInsertRowid),
        src?.id ?? null,
        1.0,
        "declared",
        c.evidence ?? null,
        now,
      );
    return { ok: true, reason: src ? undefined : "source uri not in graph; linked by name only" };
  }

  /** What is known about a given line of an artifact? */
  whyLine(path: string, line: number) {
    const art = this.latestArtifact(path);
    if (!art) return { artifact: null, links: [] as any[] };
    const links = this.db
      .prepare(
        `SELECT l.method, l.confidence, l.evidence_quote,
                s.start_line, s.end_line,
                src.uri AS source_uri, src.type AS source_type
           FROM span s
           JOIN link l ON l.span_id = s.id
           LEFT JOIN source src ON src.id = l.source_id
          WHERE s.artifact_id = ? AND ? BETWEEN s.start_line AND s.end_line
          ORDER BY l.confidence DESC`,
      )
      .all(art.id, line);
    return { artifact: art, links };
  }

  /** Embedding cache keyed on content hash. */
  getVec(hash: string): number[] | undefined {
    const row = this.db
      .prepare("SELECT vec FROM embedding WHERE content_hash=?")
      .get(hash) as { vec: string } | undefined;
    return row ? (JSON.parse(row.vec) as number[]) : undefined;
  }
  putVec(hash: string, vec: number[]): void {
    this.db
      .prepare("INSERT OR REPLACE INTO embedding(content_hash,vec) VALUES(?,?)")
      .run(hash, JSON.stringify(vec));
  }

  /** Replace computed (non-declared) attribution for an artifact version. */
  writeAttribution(
    artifactId: number,
    results: Array<{
      startLine: number;
      endLine: number;
      text: string;
      kind: string;
      sourceId: number | null;
      confidence: number;
      method: string; // embedding | llm_judge
      evidence?: string;
    }>,
  ): void {
    // clear prior computed links+spans for this artifact (keep declared ones)
    const spanIds = this.db
      .prepare("SELECT id FROM span WHERE artifact_id=?")
      .all(artifactId) as Array<{ id: number }>;
    for (const { id } of spanIds) {
      this.db.prepare("DELETE FROM link WHERE span_id=? AND method!='declared'").run(id);
    }
    this.db
      .prepare(
        "DELETE FROM span WHERE artifact_id=? AND id NOT IN (SELECT span_id FROM link)",
      )
      .run(artifactId);

    const now = new Date().toISOString();
    const insSpan = this.db.prepare(
      "INSERT INTO span(artifact_id,start_line,end_line,text,kind) VALUES(?,?,?,?,?)",
    );
    const insLink = this.db.prepare(
      `INSERT INTO link(span_id,source_id,confidence,method,evidence_quote,created_at)
       VALUES(?,?,?,?,?,?)`,
    );
    for (const r of results) {
      const sid = Number(
        insSpan.run(artifactId, r.startLine, r.endLine, r.text, r.kind).lastInsertRowid,
      );
      insLink.run(sid, r.sourceId, r.confidence, r.method, r.evidence ?? null, now);
    }
  }

  sourceById(id: number): SourceRow | undefined {
    return this.db.prepare("SELECT * FROM source WHERE id=?").get(id) as
      | SourceRow
      | undefined;
  }

  /** All spans+links for an artifact, ordered by line — for audit reports. */
  attributionFor(path: string) {
    const art = this.latestArtifact(path);
    if (!art) return null;
    const spans = this.db
      .prepare(
        `SELECT s.id, s.start_line, s.end_line, s.kind,
                l.method, l.confidence, l.evidence_quote,
                src.uri AS source_uri, src.type AS source_type
           FROM span s
           LEFT JOIN link l ON l.span_id = s.id
           LEFT JOIN source src ON src.id = l.source_id
          WHERE s.artifact_id = ?
          ORDER BY s.start_line`,
      )
      .all(art.id);
    return { artifact: art, spans };
  }

  counts(): { sources: number; artifacts: number; links: number } {
    const c = (t: string) =>
      (this.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    return { sources: c("source"), artifacts: c("artifact"), links: c("link") };
  }

  close() {
    this.db.close();
  }
}
