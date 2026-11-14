import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { keccak256, toHex, type PublicClient } from "viem";
import { canonicalJson, type JobSpec, type RegisteredJob } from "../shared/spec.ts";
import { checkCase } from "../shared/rules.ts";
import {
  BASELINE_CASE,
  fingerprintOf,
  forgeBin,
  forgeCoverage,
  forgeTest,
  forgeTrace,
  pathDiff,
  prepareWorkspace,
  run,
  shortFp,
  stripAnsi,
} from "../shared/forge.ts";
import { seal } from "../shared/crypto.ts";
import { formatUnitsShort, probeJobsAbi, readJob, revertName, walletClient } from "../shared/chain.ts";
import type { Verdict } from "../shared/api.ts";
import type { Store, SubmissionRow } from "./db.ts";
import type { VerifierConfig } from "./config.ts";

export type Outcome = {
  verdict: Verdict;
  reason: string;
  fingerprint?: `0x${string}`;
  path?: string[];
  newPaths?: number;
  txHash?: `0x${string}`;
  reward?: string;
  reportId?: string;
};

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

export class Pipeline {
  private queue: Promise<void> = Promise.resolve();
  private cfg: VerifierConfig;
  private store: Store;
  private client: PublicClient;
  private wallet: ReturnType<typeof walletClient>;

  constructor(cfg: VerifierConfig, store: Store, client: PublicClient) {
    this.cfg = cfg;
    this.store = store;
    this.client = client;
    this.wallet = walletClient(cfg.rpcUrl, cfg.chainId, cfg.privateKey);
  }

  workspaceDir(slug: string) {
    return join(this.cfg.dataDir, "workspaces", slug);
  }

  /** Source checkout for a job: a path under JOBS_ROOT, or a pinned git commit. */
  async sourceDir(spec: JobSpec): Promise<string> {
    if (spec.workspace.path) {
      const dir = resolve(this.cfg.jobsRoot, spec.workspace.path);
      if (!dir.startsWith(this.cfg.jobsRoot + "/") && dir !== this.cfg.jobsRoot) throw new Error("workspace.path must stay inside JOBS_ROOT");
      if (!existsSync(join(dir, "foundry.toml"))) throw new Error(`workspace ${spec.workspace.path} has no foundry.toml`);
      return dir;
    }
    const dir = join(this.cfg.dataDir, "sources", spec.slug);
    if (!existsSync(join(dir, ".git"))) {
      mkdirSync(dir, { recursive: true });
      const clone = await run("git", ["clone", "--recurse-submodules", spec.workspace.git!, dir], { cwd: this.cfg.dataDir, timeoutMs: 600_000, env: process.env });
      if (clone.code !== 0) throw new Error(`git clone failed: ${clone.stderr.slice(0, 500)}`);
    }
    const co = await run("git", ["checkout", "--quiet", spec.workspace.commit!], { cwd: dir, env: process.env });
    if (co.code !== 0) throw new Error(`git checkout ${spec.workspace.commit} failed: ${co.stderr.slice(0, 500)}`);
    await run("git", ["submodule", "update", "--init", "--recursive"], { cwd: dir, timeoutMs: 600_000, env: process.env });
    return dir;
  }

  /** Copy, compile and measure the snapshot baseline for a job. Serialised with submissions. */
  prepareJob(job: RegisteredJob): Promise<string[]> {
    return this.enqueue(async () => {
      const ws = prepareWorkspace(await this.sourceDir(job), this.workspaceDir(job.slug));
      const build = await run(forgeBin(), ["build", "--offline"], { cwd: ws, timeoutMs: 600_000 });
      if (build.code !== 0) throw new Error(`job workspace does not compile: ${stripAnsi(build.stderr || build.stdout).slice(0, 1500)}`);
      const casePath = this.writeCase(ws, "ProbeBaseline", BASELINE_CASE(job.fixture.import, job.fixture.base));
      try {
        const t = await forgeTest(ws, casePath, 1);
        if (!t.passed) throw new Error(`the job fixture's setUp fails: ${t.compileError ?? t.tests.map((x) => x.reason).join("; ")}`);
        const baseline = [...(await forgeCoverage(ws, casePath, job.targets))].sort();
        this.store.setBaseline(job.slug, baseline);
        log(`prepared ${job.slug}: baseline ${baseline.length} coverage items`);
        return baseline;
      } finally {
        this.clearCases(ws);
      }
    });
  }

  submit(id: string) {
    void this.enqueue(() => this.process(id)).catch((e) => log(`submission ${id} crashed`, e));
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private writeCase(ws: string, name: string, source: string): string {
    this.clearCases(ws);
    const rel = `test/cases/${name}.t.sol`;
    writeFileSync(join(ws, rel), source);
    return rel;
  }

  private clearCases(ws: string) {
    const dir = join(ws, "test", "cases");
    mkdirSync(dir, { recursive: true });
    for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  }

  private async process(id: string) {
    const sub = this.store.getSubmission(id);
    if (!sub || sub.status === "done") return;
    const entry = this.store.getJob(sub.slug);
    if (!entry) {
      this.store.finish(id, { verdict: "failed", reason: "job is not registered with this verifier" });
      return;
    }
    this.store.setRunning(id);
    log(`verifying ${id} (${sub.slug}/${sub.caseName}) from ${sub.operator}`);
    let outcome: Outcome;
    try {
      const baseline = entry.baseline ?? (await this.prepareJobUnqueued(entry.job));
      outcome = await this.verify(entry.job, baseline, sub);
    } catch (e) {
      log(`verifier error on ${id}`, e);
      outcome = { verdict: "failed", reason: `verifier error: ${e instanceof Error ? e.message.slice(0, 300) : "unknown"}` };
    }
    this.store.finish(id, outcome);
    log(`verdict ${id}: ${outcome.verdict} (${outcome.reason})`);
  }

  // Called from inside the queue, so it must not enqueue again.
  private async prepareJobUnqueued(job: RegisteredJob): Promise<string[]> {
    const ws = prepareWorkspace(await this.sourceDir(job), this.workspaceDir(job.slug));
    const casePath = this.writeCase(ws, "ProbeBaseline", BASELINE_CASE(job.fixture.import, job.fixture.base));
    const baseline = [...(await forgeCoverage(ws, casePath, job.targets))].sort();
    this.store.setBaseline(job.slug, baseline);
    this.clearCases(ws);
    return baseline;
  }

  private async verify(job: RegisteredJob, baselineList: string[], sub: SubmissionRow): Promise<Outcome> {
    // 1. Static rules.
    const rules = checkCase(sub.source, job);
    if (!rules.ok) return { verdict: "failed", reason: rules.reason };

    // 2. Job must still be open and funded.
    const state = await readJob(this.client, job.chain.contract, BigInt(job.chain.jobId));
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (state.status !== 1 || now > state.deadline) return { verdict: "failed", reason: "job is closed" };
    if (state.budget < state.rewardPerAccepted) return { verdict: "failed", reason: "job budget is used up" };

    const ws = this.workspaceDir(job.slug);
    if (!existsSync(join(ws, "foundry.toml"))) await this.prepareJobUnqueued(job);
    const casePath = this.writeCase(ws, `Case_${sub.id.replace(/-/g, "").slice(0, 12)}_${rules.contractName}`, sub.source);
    try {
      // 3. Reproduce twice on the pinned snapshot.
      const first = await forgeTest(ws, casePath, 1);
      if (first.timedOut) return { verdict: "failed", reason: "timed out after 180 seconds" };
      if (first.compileError) return { verdict: "failed", reason: `does not compile: ${firstLine(first.compileError)}` };
      if (!first.passed) {
        const f = first.tests.find((t) => !t.passed);
        return { verdict: "failed", reason: `did not reproduce: ${f?.name ?? "test"} failed on the snapshot${f?.reason ? ` (${f.reason})` : ""}` };
      }
      const second = await forgeTest(ws, casePath, 2);
      const same =
        second.passed &&
        second.tests.length === first.tests.length &&
        first.tests.every((t) => second.tests.some((u) => u.name === t.name && u.passed === t.passed && u.gas === t.gas));
      if (!same) return { verdict: "failed", reason: "did not reproduce: the result changed between two runs on the same snapshot" };

      // 4. Execution path through the target, beyond the snapshot setup.
      const path = pathDiff(await forgeCoverage(ws, casePath, job.targets), new Set(baselineList));
      if (path.length === 0) return { verdict: "failed", reason: "reaches no hook code beyond the snapshot setup" };
      const fingerprint = fingerprintOf(path);

      // 5. Duplicates.
      const accepted = this.store.accepted(job.slug);
      const paid = await this.client.readContract({
        address: job.chain.contract,
        abi: probeJobsAbi,
        functionName: "fingerprintPaid",
        args: [BigInt(job.chain.jobId), fingerprint],
      });
      const match = accepted.find((a) => a.fingerprint === fingerprint);
      if (paid || match) {
        return { verdict: "duplicate", reason: `same execution path as accepted case ${shortFp(fingerprint)}`, fingerprint, path };
      }
      let newPaths = path.length;
      if (job.rewardModel === "coverage") {
        const covered = new Set(accepted.flatMap((a) => a.path ?? []));
        newPaths = path.filter((p) => !covered.has(p)).length;
        if (newPaths === 0) return { verdict: "duplicate", reason: "reaches no branches beyond accepted cases", fingerprint, path, newPaths: 0 };
      }

      // 6. Eligibility.
      const eligible = await this.client.readContract({
        address: job.chain.contract,
        abi: probeJobsAbi,
        functionName: "isEligible",
        args: [BigInt(job.chain.jobId), sub.operator],
      });
      if (!eligible) {
        return { verdict: "ineligible", reason: "reproduced, but the operator does not meet the job's holding requirement", fingerprint, path, newPaths };
      }

      // 7. Private report for the sponsor, sealed before anything is published.
      const trace = await forgeTrace(ws, casePath);
      const reportId = randomUUID();
      const sealed = seal(
        JSON.stringify({ submission: sub.id, job: job.slug, case: sub.caseName, operator: sub.operator, fingerprint, path, source: sub.source, trace: trace.slice(0, 400_000) }),
        job.reportKey,
      );
      this.store.saveReport({ id: reportId, submissionId: sub.id, slug: job.slug, sealed: JSON.stringify(sealed) });

      // 8. Settle on-chain.
      const publicRecord = { job: job.slug, submission: sub.id, operator: sub.operator, fingerprint, sourceHash: sub.sourceHash, reportId, verdict: "accepted" };
      const resultHash = keccak256(toHex(canonicalJson(publicRecord)));
      try {
        const { request } = await this.client.simulateContract({
          account: this.wallet.account,
          address: job.chain.contract,
          abi: probeJobsAbi,
          functionName: "recordAccepted",
          args: [BigInt(job.chain.jobId), sub.operator, fingerprint, resultHash],
        });
        const txHash = await this.wallet.writeContract(request);
        const receipt = await this.client.waitForTransactionReceipt({ hash: txHash });
        if (receipt.status !== "success") return { verdict: "failed", reason: "payout transaction reverted", fingerprint, path, reportId };
        const reward = formatUnitsShort(state.rewardPerAccepted, job.chain.rewardDecimals);
        const reason =
          job.rewardModel === "coverage"
            ? `reproduced on the snapshot; reached ${newPaths} new path${newPaths === 1 ? "" : "s"}`
            : "reproduced on the snapshot; details sent privately to the sponsor";
        return { verdict: "accepted", reason, fingerprint, path, newPaths, txHash, reward: `${reward} ${job.chain.rewardSymbol}`, reportId };
      } catch (e) {
        const name = revertName(e);
        if (name === "DuplicateFingerprint") return { verdict: "duplicate", reason: `same execution path as an accepted case ${shortFp(fingerprint)}`, fingerprint, path };
        if (name === "NotEligible") return { verdict: "ineligible", reason: "the operator does not meet the job's holding requirement", fingerprint, path };
        if (name === "BudgetExhausted") return { verdict: "failed", reason: "job budget is used up", fingerprint, path };
        if (name === "DeadlinePassed" || name === "JobNotOpen") return { verdict: "failed", reason: "job is closed", fingerprint, path };
        throw e;
      }
    } finally {
      this.clearCases(ws);
    }
  }
}

function firstLine(s: string) {
  const line = s.split("\n").find((l) => /error/i.test(l)) ?? s.split("\n")[0] ?? "";
  return line.trim().slice(0, 240);
}
