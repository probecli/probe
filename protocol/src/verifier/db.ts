import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { PublicSubmission, Verdict } from "../shared/api.ts";
import type { RegisteredJob } from "../shared/spec.ts";
import type { JobRequestInput, JobRequestStatus } from "../shared/messages.ts";

export type JobRequestRow = JobRequestInput & {
  id: string;
  wallet: string;
  status: JobRequestStatus;
  note: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SubmissionRow = PublicSubmission & { source: string; sourceHash: string; path: string[] | null };

export class Store {
  db: DatabaseSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS jobs (
        slug TEXT PRIMARY KEY,
        spec TEXT NOT NULL,
        baseline TEXT,
        registered_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submissions (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        operator TEXT NOT NULL,
        nonce INTEGER NOT NULL,
        case_name TEXT NOT NULL,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        verdict TEXT,
        reason TEXT,
        fingerprint TEXT,
        path TEXT,
        new_paths INTEGER,
        tx_hash TEXT,
        reward TEXT,
        report_id TEXT,
        created_at INTEGER NOT NULL,
        finished_at INTEGER,
        UNIQUE (operator, nonce)
      );
      CREATE INDEX IF NOT EXISTS submissions_slug ON submissions (slug, verdict);
      CREATE TABLE IF NOT EXISTS job_requests (
        id TEXT PRIMARY KEY,
        wallet TEXT NOT NULL,
        data TEXT NOT NULL,
        signature TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'new',
        note TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS job_requests_wallet ON job_requests (wallet, created_at);
      CREATE TABLE IF NOT EXISTS reports (
        id TEXT PRIMARY KEY,
        submission_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        sealed TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  // ---------------------------------------------------------- job requests

  insertRequest(r: { id: string; wallet: string; data: JobRequestInput; signature: string }) {
    const now = Date.now();
    this.db
      .prepare("INSERT INTO job_requests (id, wallet, data, signature, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'new', ?, ?)")
      .run(r.id, r.wallet.toLowerCase(), JSON.stringify(r.data), r.signature, now, now);
  }

  countOpenRequests(wallet: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM job_requests WHERE wallet = ? AND status IN ('new', 'reviewing')")
      .get(wallet.toLowerCase()) as { n: number };
    return Number(row.n);
  }

  listRequests(wallet?: string): JobRequestRow[] {
    const rows = (
      wallet
        ? this.db.prepare("SELECT * FROM job_requests WHERE wallet = ? ORDER BY created_at DESC LIMIT 200").all(wallet.toLowerCase())
        : this.db.prepare("SELECT * FROM job_requests ORDER BY created_at DESC LIMIT 500").all()
    ) as { id: string; wallet: string; data: string; status: string; note: string | null; created_at: number; updated_at: number }[];
    return rows.map((r) => ({
      id: r.id,
      wallet: r.wallet,
      ...(JSON.parse(r.data) as JobRequestInput),
      status: r.status as JobRequestStatus,
      note: r.note,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  setRequestStatus(id: string, status: JobRequestStatus, note: string | null): boolean {
    const res = this.db.prepare("UPDATE job_requests SET status = ?, note = ?, updated_at = ? WHERE id = ?").run(status, note, Date.now(), id);
    return Number(res.changes) > 0;
  }

  saveJob(job: RegisteredJob) {
    this.db
      .prepare("INSERT INTO jobs (slug, spec, registered_at) VALUES (?, ?, ?) ON CONFLICT(slug) DO UPDATE SET spec = excluded.spec")
      .run(job.slug, JSON.stringify(job), Date.now());
  }

  setBaseline(slug: string, items: string[]) {
    this.db.prepare("UPDATE jobs SET baseline = ? WHERE slug = ?").run(JSON.stringify(items), slug);
  }

  getJob(slug: string): { job: RegisteredJob; baseline: string[] | null } | null {
    const row = this.db.prepare("SELECT spec, baseline FROM jobs WHERE slug = ?").get(slug) as { spec: string; baseline: string | null } | undefined;
    return row ? { job: JSON.parse(row.spec), baseline: row.baseline ? JSON.parse(row.baseline) : null } : null;
  }

  listJobs(): RegisteredJob[] {
    return (this.db.prepare("SELECT spec FROM jobs ORDER BY registered_at DESC").all() as { spec: string }[]).map((r) => JSON.parse(r.spec));
  }

  insertSubmission(s: { id: string; slug: string; operator: string; nonce: number; caseName: string; title: string; source: string; sourceHash: string }) {
    this.db
      .prepare(
        `INSERT INTO submissions (id, slug, operator, nonce, case_name, title, source, source_hash, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
      )
      .run(s.id, s.slug, s.operator.toLowerCase(), s.nonce, s.caseName, s.title, s.source, s.sourceHash, Date.now());
  }

  setRunning(id: string) {
    this.db.prepare("UPDATE submissions SET status = 'running' WHERE id = ?").run(id);
  }

  finish(
    id: string,
    r: { verdict: Verdict; reason: string; fingerprint?: string | null; path?: string[] | null; newPaths?: number | null; txHash?: string | null; reward?: string | null; reportId?: string | null },
  ) {
    this.db
      .prepare(
        `UPDATE submissions SET status = 'done', verdict = ?, reason = ?, fingerprint = ?, path = ?, new_paths = ?, tx_hash = ?, reward = ?, report_id = ?, finished_at = ? WHERE id = ?`,
      )
      .run(r.verdict, r.reason, r.fingerprint ?? null, r.path ? JSON.stringify(r.path) : null, r.newPaths ?? null, r.txHash ?? null, r.reward ?? null, r.reportId ?? null, Date.now(), id);
  }

  getSubmission(id: string): SubmissionRow | null {
    const row = this.db.prepare("SELECT * FROM submissions WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toRow(row) : null;
  }

  pendingSubmissions(): string[] {
    return (this.db.prepare("SELECT id FROM submissions WHERE status != 'done' ORDER BY created_at").all() as { id: string }[]).map((r) => r.id);
  }

  listSubmissions(slug: string, limit = 100): SubmissionRow[] {
    return (this.db.prepare("SELECT * FROM submissions WHERE slug = ? ORDER BY created_at DESC LIMIT ?").all(slug, limit) as Record<string, unknown>[]).map(toRow);
  }

  accepted(slug: string): SubmissionRow[] {
    return (this.db.prepare("SELECT * FROM submissions WHERE slug = ? AND verdict = 'accepted'").all(slug) as Record<string, unknown>[]).map(toRow);
  }

  saveReport(r: { id: string; submissionId: string; slug: string; sealed: string }) {
    this.db.prepare("INSERT INTO reports (id, submission_id, slug, sealed, created_at) VALUES (?, ?, ?, ?, ?)").run(r.id, r.submissionId, r.slug, r.sealed, Date.now());
  }

  reportsFor(slug: string): { id: string; submissionId: string; sealed: string; createdAt: number }[] {
    return (this.db.prepare("SELECT id, submission_id, sealed, created_at FROM reports WHERE slug = ? ORDER BY created_at").all(slug) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      submissionId: String(r.submission_id),
      sealed: String(r.sealed),
      createdAt: Number(r.created_at),
    }));
  }

  getReport(id: string) {
    return this.db.prepare("SELECT id, slug, sealed FROM reports WHERE id = ?").get(id) as { id: string; slug: string; sealed: string } | undefined;
  }
}

function toRow(r: Record<string, unknown>): SubmissionRow {
  return {
    id: String(r.id),
    slug: String(r.slug),
    operator: String(r.operator) as `0x${string}`,
    caseName: String(r.case_name),
    title: String(r.title),
    status: r.status as SubmissionRow["status"],
    verdict: (r.verdict as Verdict | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    fingerprint: (r.fingerprint as `0x${string}` | null) ?? null,
    newPaths: r.new_paths == null ? null : Number(r.new_paths),
    txHash: (r.tx_hash as `0x${string}` | null) ?? null,
    reward: (r.reward as string | null) ?? null,
    reportId: (r.report_id as string | null) ?? null,
    createdAt: Number(r.created_at),
    finishedAt: r.finished_at == null ? null : Number(r.finished_at),
    source: String(r.source),
    sourceHash: String(r.source_hash),
    path: r.path ? JSON.parse(String(r.path)) : null,
  };
}

export function toPublic(s: SubmissionRow): PublicSubmission {
  const { source: _s, sourceHash: _h, path: _p, ...pub } = s;
  return pub;
}
