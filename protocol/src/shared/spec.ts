import { keccak256, toHex } from "viem";

export type RewardModel = "findings" | "coverage" | "findings-and-coverage";

/** The job definition a sponsor publishes. Its hash is committed on-chain. */
export type JobSpec = {
  slug: string;
  title: string;
  summary: string;
  objective: string;
  inScope: string[];
  outOfScope: string[];
  acceptanceRules: string[];
  network: { id: string; name: string };
  hook: { name: string; callbacks: string[] };
  snapshot: { id: string; block: number; note: string };
  /** Where the Foundry workspace lives: a path relative to the repo root, or a git repo at a commit. */
  workspace: { path?: string; git?: string; commit?: string };
  /** The fixture every case must inherit, and the import path cases use. */
  fixture: { base: string; import: string };
  /** Source files whose coverage defines a case's execution path. */
  targets: string[];
  /** Import prefixes a case may use besides the fixture. */
  allowedImports: string[];
  /** Directory (in the workspace) with seed cases the CLI can run without an AI agent. */
  seedCases?: string;
  rewardModel: RewardModel;
  reward: { headline: string; detail: string };
  sponsor: string;
  /** Sponsor's X25519 public key (base64) for encrypted failure reports. */
  reportKey: string;
};

/** Filled in by the verifier from chain state when the job is registered. */
export type ChainBinding = {
  chainId: number;
  rpcUrl: string;
  contract: `0x${string}`;
  jobId: string;
  rewardToken: `0x${string}`;
  rewardSymbol: string;
  rewardDecimals: number;
  explorerUrl?: string;
};

export type RegisteredJob = JobSpec & { specHash: `0x${string}`; chain: ChainBinding };

/** Deterministic JSON: object keys sorted at every level. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function specHash(spec: JobSpec): `0x${string}` {
  return keccak256(toHex(canonicalJson(spec)));
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

/** Throws with a readable message when the spec is incomplete. */
export function validateSpec(spec: unknown): asserts spec is JobSpec {
  const s = spec as Partial<JobSpec>;
  const fail = (m: string) => {
    throw new Error(`Invalid job spec: ${m}`);
  };
  if (!s || typeof s !== "object") fail("not an object");
  if (!s.slug || !SLUG_RE.test(s.slug)) fail("slug must be 3-64 lowercase letters, digits or dashes");
  for (const k of ["title", "summary", "objective", "sponsor", "reportKey"] as const) {
    if (typeof s[k] !== "string" || !s[k]) fail(`${k} is required`);
  }
  for (const k of ["inScope", "outOfScope", "acceptanceRules", "targets", "allowedImports"] as const) {
    if (!Array.isArray(s[k])) fail(`${k} must be a list`);
  }
  if (!s.targets!.length) fail("targets must name at least one source file");
  if (!s.workspace || (!s.workspace.path && !s.workspace.git)) fail("workspace needs a path or a git url");
  if (s.workspace?.git && !/^[0-9a-f]{40}$/.test(s.workspace.commit ?? "")) fail("git workspaces need a full commit hash");
  if (!s.fixture?.base || !s.fixture?.import) fail("fixture.base and fixture.import are required");
  if (!["findings", "coverage", "findings-and-coverage"].includes(s.rewardModel as string)) fail("rewardModel is invalid");
  if (!s.network?.id || !s.network?.name) fail("network is required");
  if (!s.hook?.name) fail("hook.name is required");
  if (typeof s.snapshot?.block !== "number") fail("snapshot.block is required");
}
