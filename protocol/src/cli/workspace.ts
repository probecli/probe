import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forgeTest, prepareWorkspace, run, resolveWorkspacePath } from "../shared/forge.ts";
import { caseTitle } from "../shared/rules.ts";
import type { JobSpec, RegisteredJob } from "../shared/spec.ts";
import type { ProposedCase } from "./agent.ts";
import { PROBE_HOME, REPO_ROOT } from "./config.ts";

const REPO_URL = process.env.PROBE_REPO_URL ?? "https://github.com/probecli/probe";

/**
 * A shallow checkout of the public repository, where path-based job
 * workspaces live when the CLI was installed from npm rather than cloned.
 * Refreshed to the latest main on each run; an offline run uses what is there.
 */
async function publicRepo(): Promise<string> {
  const dir = join(PROBE_HOME, "repo");
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(PROBE_HOME, { recursive: true });
    const r = await run("git", ["clone", "--quiet", "--depth", "1", REPO_URL, dir], { cwd: PROBE_HOME, timeoutMs: 600_000, env: process.env });
    if (r.code !== 0) throw new Error(`could not download job workspaces from ${REPO_URL}: ${r.stderr.trim().split("\n").pop() ?? "git clone failed"}`);
  } else {
    const f = await run("git", ["fetch", "--quiet", "--depth", "1", "origin", "main"], { cwd: dir, timeoutMs: 300_000, env: process.env });
    if (f.code === 0) await run("git", ["reset", "--quiet", "--hard", "FETCH_HEAD"], { cwd: dir, env: process.env });
  }
  return dir;
}

/** Workspace copy for local runs. */
export async function localWorkspace(job: RegisteredJob): Promise<string> {
  let src: string;
  if (job.workspace.path) {
    src = resolveWorkspacePath(REPO_ROOT, job.workspace.path);
    if (!existsSync(join(src, "foundry.toml"))) {
      const repo = await publicRepo();
      src = resolveWorkspacePath(repo, job.workspace.path);
      if (!existsSync(join(src, "foundry.toml"))) throw new Error(`workspace ${job.workspace.path} is not in ${REPO_URL}. Set PROBE_REPO_ROOT to a checkout that has it.`);
    }
  } else {
    src = join(PROBE_HOME, "src", job.slug);
    if (!existsSync(join(src, ".git"))) {
      const r = await run("git", ["clone", "--recurse-submodules", job.workspace.git!, src], { cwd: PROBE_HOME, timeoutMs: 600_000, env: process.env });
      if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.slice(0, 300)}`);
    }
    await run("git", ["checkout", "--quiet", job.workspace.commit!], { cwd: src, env: process.env });
    await run("git", ["submodule", "update", "--init", "--recursive"], { cwd: src, timeoutMs: 600_000, env: process.env });
  }
  return prepareWorkspace(src, join(PROBE_HOME, "work", job.slug));
}

export function seedCases(ws: string, job: JobSpec): ProposedCase[] {
  if (!job.seedCases) return [];
  const dir = join(ws, job.seedCases);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sol"))
    .sort()
    .map((f) => {
      const source = readFileSync(join(dir, f), "utf8");
      const name = f.replace(/\.t\.sol$|\.sol$/, "");
      return { name, title: caseTitle(source, name), source };
    });
}

/** Run one case in the workspace, where the verifier would put it. */
export async function runLocal(ws: string, c: ProposedCase) {
  const dir = join(ws, "test/cases");
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  const rel = `test/cases/${c.name.replace(/[^A-Za-z0-9_]/g, "")}.t.sol`;
  writeFileSync(join(ws, rel), c.source);
  try {
    return await forgeTest(ws, rel, 1);
  } finally {
    rmSync(join(ws, rel), { force: true });
  }
}
