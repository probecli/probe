import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { keccak256, toHex } from "viem";

/** Locate forge: PATH first, then the default foundryup install. */
export function forgeBin(): string {
  if (process.env.FORGE_BIN) return process.env.FORGE_BIN;
  const fallback = join(homedir(), ".foundry", "bin", "forge");
  return existsSync(fallback) ? fallback : "forge";
}

export type ExecResult = { code: number; stdout: string; stderr: string; timedOut: boolean };

export function run(cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }): Promise<ExecResult> {
  return new Promise((resolvePromise) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 180_000,
        maxBuffer: 64 * 1024 * 1024,
        // Cases never see the caller's secrets, and the sandbox settings below
        // override anything a job's foundry.toml asks for.
        env: opts.env ?? {
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "",
          NO_COLOR: "1",
          FOUNDRY_DISABLE_NIGHTLY_WARNING: "1",
          FOUNDRY_FFI: "false",
          FOUNDRY_FS_PERMISSIONS: "[]",
          FOUNDRY_ETH_RPC_URL: "",
          FOUNDRY_FORK_URL: "",
        },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolvePromise({
          code: e ? (typeof e.code === "number" ? e.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: Boolean(e?.killed),
        });
      },
    );
  });
}

export const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/**
 * Copy a job workspace to an isolated directory so each party (CLI, verifier)
 * runs cases in its own copy. Relative library paths in foundry.toml are
 * rewritten to absolute paths so the copy still compiles.
 */
export function prepareWorkspace(srcDir: string, destDir: string): string {
  const src = resolve(srcDir);
  if (!existsSync(join(src, "foundry.toml"))) throw new Error(`No foundry.toml in ${src}`);
  rmSync(destDir, { recursive: true, force: true });
  mkdirSync(destDir, { recursive: true });
  cpSync(src, destDir, {
    recursive: true,
    filter: (p) => !/[/\\](out|cache|broadcast)([/\\]|$)/.test(p.slice(src.length)) && !/[/\\]test[/\\]cases[/\\]/.test(p.slice(src.length) + "/"),
  });
  const tomlPath = join(destDir, "foundry.toml");
  const toml = readFileSync(tomlPath, "utf8").replace(/(["=])(\.\.?\/[^"\s]*)/g, (_m, pre: string, rel: string) => {
    const abs = resolve(src, rel);
    return `${pre}${abs}${rel.endsWith("/") && !abs.endsWith("/") ? "/" : ""}`;
  });
  // Sandbox: whatever the job asks for, no ffi, no file access, no forking.
  const sandboxed = toml
    .split("\n")
    .filter((l) => !/^\s*(ffi|fs_permissions|eth_rpc_url|fork_url|fork_block_number|rpc_endpoints)\s*=/.test(l))
    .join("\n")
    .replace(/(\[profile\.default\][^\n]*\n)/, "$1ffi = false\nfs_permissions = []\n");
  if (!/ffi = false/.test(sandboxed)) throw new Error("foundry.toml has no [profile.default] section");
  writeFileSync(tomlPath, sandboxed);
  mkdirSync(join(destDir, "test", "cases"), { recursive: true });
  return destDir;
}

export function resolveWorkspacePath(repoRoot: string, path: string) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

// ------------------------------------------------------------------ forge test

export type TestOutcome = {
  passed: boolean;
  tests: { name: string; passed: boolean; reason: string | null; gas: number | null }[];
  compileError: string | null;
  timedOut: boolean;
};

type ForgeJson = Record<string, { test_results: Record<string, { status: string; reason: string | null; kind?: { Unit?: { gas: number } } }> }>;

export async function forgeTest(workspace: string, casePath: string, seed: number): Promise<TestOutcome> {
  const res = await run(forgeBin(), ["test", "--match-path", casePath, "--json", "--fuzz-seed", String(seed), "--offline"], {
    cwd: workspace,
  });
  if (res.timedOut) return { passed: false, tests: [], compileError: null, timedOut: true };
  const jsonStart = res.stdout.indexOf("{");
  if (jsonStart === -1) {
    const msg = stripAnsi(res.stderr || res.stdout).trim();
    return { passed: false, tests: [], compileError: msg.slice(0, 4000) || "forge produced no output", timedOut: false };
  }
  let parsed: ForgeJson;
  try {
    parsed = JSON.parse(res.stdout.slice(jsonStart));
  } catch {
    return { passed: false, tests: [], compileError: stripAnsi(res.stdout + res.stderr).slice(0, 4000), timedOut: false };
  }
  const tests: TestOutcome["tests"] = [];
  for (const suite of Object.values(parsed)) {
    for (const [name, r] of Object.entries(suite.test_results)) {
      tests.push({ name, passed: r.status === "Success", reason: r.reason, gas: r.kind?.Unit?.gas ?? null });
    }
  }
  return { passed: tests.length > 0 && tests.every((t) => t.passed), tests, compileError: null, timedOut: false };
}

/** Full call trace for the sponsor's private report. */
export async function forgeTrace(workspace: string, casePath: string): Promise<string> {
  const res = await run(forgeBin(), ["test", "--match-path", casePath, "-vvvv", "--offline"], { cwd: workspace });
  return stripAnsi(res.stdout + (res.stderr ? `\n${res.stderr}` : ""));
}

// ------------------------------------------------------------------ coverage

/**
 * Coverage items reached in the target files: `L:<file>:<line>` for executed
 * lines and `B:<file>:<line>:<block>:<branch>` for taken branches.
 */
export async function forgeCoverage(workspace: string, casePath: string, targets: string[]): Promise<Set<string>> {
  const reportFile = join(workspace, "cache", `lcov-${Date.now()}-${Math.random().toString(16).slice(2)}.info`);
  mkdirSync(join(workspace, "cache"), { recursive: true });
  const res = await run(forgeBin(), ["coverage", "--match-path", casePath, "--report", "lcov", "--report-file", reportFile, "--offline"], {
    cwd: workspace,
  });
  if (!existsSync(reportFile)) throw new Error(`coverage failed: ${stripAnsi(res.stderr || res.stdout).slice(0, 2000)}`);
  const lcov = readFileSync(reportFile, "utf8");
  rmSync(reportFile, { force: true });
  return parseLcov(lcov, targets);
}

export function parseLcov(lcov: string, targets: string[]): Set<string> {
  const items = new Set<string>();
  let file: string | null = null;
  for (const line of lcov.split("\n")) {
    if (line.startsWith("SF:")) {
      const sf = line.slice(3).trim();
      file = targets.find((t) => sf === t || sf.endsWith(`/${t}`)) ?? null;
    } else if (line === "end_of_record") {
      file = null;
    } else if (file && line.startsWith("DA:")) {
      const [ln, hits] = line.slice(3).split(",");
      if (Number(hits) > 0) items.add(`L:${file}:${ln}`);
    } else if (file && line.startsWith("BRDA:")) {
      const [ln, block, branch, taken] = line.slice(5).split(",");
      if (taken !== "-" && Number(taken) > 0) items.add(`B:${file}:${ln}:${block}:${branch}`);
    }
  }
  return items;
}

/** The execution path a case adds on top of the snapshot setup. */
export function pathDiff(caseItems: Set<string>, baseline: Set<string>): string[] {
  return [...caseItems].filter((i) => !baseline.has(i)).sort();
}

export function fingerprintOf(path: string[]): `0x${string}` {
  return keccak256(toHex(path.join("\n")));
}

export const shortFp = (fp: string) => `${fp.slice(2, 6)}…${fp.slice(-4)}`;

export const BASELINE_CASE = (fixtureImport: string, base: string) => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {${base}} from "${fixtureImport}";

contract ProbeBaseline is ${base} {
    function test_baseline() public {}
}
`;
