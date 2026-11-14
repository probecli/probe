import type { JobSpec } from "./spec.ts";

/**
 * Static rules every case must meet before it is executed. These make results
 * reproducible: no wall clock, no randomness without a seed, no network, no
 * file system, and no rewriting the target instead of testing it.
 * Foundry runs with ffi off and no file-system permissions as a second layer.
 */
export type RuleResult = { ok: true; contractName: string; testCount: number } | { ok: false; reason: string };

const MAX_BYTES = 64 * 1024;

const BANNED: { re: RegExp; reason: string }[] = [
  { re: /\bvm\s*\.\s*unixTime\b/, reason: "reads wall-clock time, not block time" },
  { re: /\bvm\s*\.\s*(ffi|tryFfi)\b/, reason: "runs shell commands (ffi)" },
  { re: /\bvm\s*\.\s*(env\w*|setEnv)\b/, reason: "reads environment variables" },
  { re: /\bvm\s*\.\s*(readFile\w*|writeFile\w*|readDir|readLine|removeFile|fsMetadata|exists|isFile|isDir|projectRoot|copyFile|writeJson|writeToml|closeFile)\b/, reason: "touches the file system" },
  { re: /\bvm\s*\.\s*(rpc\w*|createFork|createSelectFork|selectFork|rollFork|makePersistent|activeFork|transact)\b/, reason: "makes network calls or switches the fork" },
  { re: /\bvm\s*\.\s*(random\w*|setArbitraryStorage)\b/, reason: "uses randomness without a recorded seed" },
  { re: /\bvm\s*\.\s*(etch|store|mockCall\w*|mockFunction|clearMockedCalls|setCode|loadAllocs|cloneAccount)\b/, reason: "rewrites contract code or storage instead of testing it" },
  { re: /\bvm\s*\.\s*(sleep|prompt\w*|breakpoint)\b/, reason: "waits on or asks the operator's machine" },
  { re: /\bdeployCodeTo\b/, reason: "rewrites contract code instead of testing it" },
  { re: /\bassembly\b/, reason: "uses inline assembly, which is not allowed in cases" },
  { re: /7109709ecfa91a80626ff3989d68f67f5b1dd12d/i, reason: "calls the cheatcode address directly" },
  { re: /\bselfdestruct\b|\bdelegatecall\b/, reason: "uses selfdestruct or delegatecall" },
];

const ASSERTION_RE = /\b(assert\w*\s*\(|vm\s*\.\s*expectRevert\b|vm\s*\.\s*expectEmit\b)/;

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

export function checkCase(source: string, spec: Pick<JobSpec, "fixture" | "allowedImports">): RuleResult {
  if (Buffer.byteLength(source, "utf8") > MAX_BYTES) return { ok: false, reason: "case is larger than 64 KB" };
  const code = stripComments(source);

  for (const rule of BANNED) if (rule.re.test(code)) return { ok: false, reason: rule.reason };

  const imports = [...code.matchAll(/\bimport\b[^;]*?["']([^"']+)["']/g)].map((m) => m[1]);
  for (const path of imports) {
    const allowed = path === spec.fixture.import || spec.allowedImports.some((p) => path.startsWith(p));
    if (!allowed) return { ok: false, reason: `imports ${path}, which is outside the job fixture` };
  }
  if (!imports.includes(spec.fixture.import)) {
    return { ok: false, reason: `does not import the job fixture (${spec.fixture.import})` };
  }

  const contracts = [...code.matchAll(/\b(?:abstract\s+)?contract\s+([A-Za-z_]\w*)\s+is\s+([^{]+)\{/g)];
  const concrete = contracts.filter((m) => !/\babstract\b/.test(m[0]));
  if (concrete.length !== 1) return { ok: false, reason: "must define exactly one test contract" };
  const [, contractName, bases] = concrete[0];
  if (!bases.split(",").map((b) => b.trim()).includes(spec.fixture.base)) {
    return { ok: false, reason: `test contract must inherit ${spec.fixture.base}, the job snapshot` };
  }
  if (/\bfunction\s+setUp\s*\(/.test(code) && !/super\s*\.\s*setUp\s*\(/.test(code)) {
    return { ok: false, reason: "overrides setUp without calling super.setUp(), so it skips the snapshot" };
  }

  const tests = [...code.matchAll(/\bfunction\s+(test\w*)\s*\(/g)];
  if (tests.length === 0) return { ok: false, reason: "has no test functions" };
  if (tests.length > 8) return { ok: false, reason: "has more than 8 test functions; submit them as separate cases" };
  // Parameterised tests are fuzzed, so their inputs differ between runs.
  const parameterised = [...code.matchAll(/\bfunction\s+test\w*\s*\(([^)]*)\)/g)].some((m) => m[1].trim().length > 0);
  if (parameterised || /\bfunction\s+invariant\w*\s*\(/.test(code)) {
    return { ok: false, reason: "uses fuzz or invariant tests; cases must be fixed scenarios" };
  }
  if (!ASSERTION_RE.test(code)) return { ok: false, reason: "does not assert any outcome" };
  // Every assertion must be able to fail: no constant or self-comparing checks.
  const asserts = [...code.matchAll(/\bassert(\w*)\s*\(([^;]*)\)\s*;/g)];
  const meaningful = asserts.filter(([, kind, args]) => {
    const parts = args.split(",").map((p) => p.trim());
    if (/^(True)?$/.test(kind) && /^(true|!false|1\s*==\s*1)$/.test(parts[0])) return false;
    if (/^(False)$/.test(kind) && /^(false|!true)$/.test(parts[0])) return false;
    if (/^(Eq|ApproxEqAbs|ApproxEqRel|Le|Ge)$/.test(kind) && parts.length >= 2 && parts[0] === parts[1]) return false;
    if (/^(True)?$/.test(kind) && /^(\w[\w.]*)\s*(==|>=|<=)\s*\1$/.test(parts[0])) return false;
    return true;
  });
  if (asserts.length && meaningful.length === 0 && !/\bvm\s*\.\s*expect(Revert|Emit)\b/.test(code)) {
    return { ok: false, reason: "only asserts constants, so it cannot fail" };
  }

  return { ok: true, contractName, testCount: tests.length };
}

/** The test contract's name, even when the case breaks a rule. */
export function contractNameOf(source: string): string | null {
  return stripComments(source).match(/\bcontract\s+([A-Za-z_]\w*)\s+is\b/)?.[1] ?? null;
}

/** First line of the NatSpec/comment above the contract, used as the case title. */
export function caseTitle(source: string, fallback: string): string {
  const m = source.match(/((?:\s*\/\/\/[^\n]*\n)+)\s*contract\s/);
  if (m) {
    const first = m[1].split("\n").map((l) => l.replace(/^\s*\/\/\/\s?/, "").trim()).find(Boolean);
    if (first) return first.replace(/\.$/, "").slice(0, 140);
  }
  return fallback.replace(/([a-z])([A-Z])/g, "$1 $2");
}
