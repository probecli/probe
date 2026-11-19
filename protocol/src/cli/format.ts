import type { PublicSubmission, Verdict } from "../shared/api.ts";

/** "in 3 days (2026-12-19)", "in 5 hours (…)" or "passed (…)" for a unix deadline. */
export function deadlineText(deadline: number, nowMs = Date.now()): string {
  const date = new Date(deadline * 1000).toISOString().slice(0, 10);
  const left = deadline * 1000 - nowMs;
  if (left <= 0) return `passed (${date})`;
  const hours = Math.max(1, Math.floor(left / 3_600_000));
  if (hours < 48) return `in ${hours} hour${hours === 1 ? "" : "s"} (${date})`;
  return `in ${Math.floor(hours / 24)} days (${date})`;
}

/** Verdict counts for finished submissions, most important first. */
export function resultCounts(subs: Pick<PublicSubmission, "status" | "verdict">[]): { verdict: Verdict | "pending"; count: number }[] {
  const order: (Verdict | "pending")[] = ["accepted", "duplicate", "failed", "ineligible", "pending"];
  const counts = new Map<Verdict | "pending", number>();
  for (const s of subs) {
    const key = s.status === "done" && s.verdict ? s.verdict : "pending";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return order.filter((v) => counts.has(v)).map((verdict) => ({ verdict, count: counts.get(verdict)! }));
}

/** Print JSON for scripts: stable key order, no colour. */
export function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

/** "3m ago", "5h ago", "2d ago", or the date for older times. */
export function ago(ms: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86_400) return `${Math.floor(s / 86_400)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}
