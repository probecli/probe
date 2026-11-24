import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { JobView } from "../src/shared/api.ts";
import { reportMessage, type HookReport } from "../src/shared/hookcheck.ts";
import { compareRerun, registeredSpec, verifyHookCheck, verifyJobSpec } from "../src/shared/verify.ts";

// Job 2 on Robinhood Chain mainnet: the registered spec and the hash getJob(2) returns.
const JOB2_SPEC = JSON.parse(readFileSync(new URL("../../deployments/jobs/2.json", import.meta.url), "utf8"));
const JOB2_HASH = "0xcdead47cb3ad4888d4ef30f8981766018ba62e64de142591d758435ef438a326" as const;

function job2View(overrides: Partial<JobView> = {}): JobView {
  return {
    ...JOB2_SPEC,
    specHash: JOB2_HASH,
    chain: { chainId: 4663, rpcUrl: "", contract: "0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189", jobId: "2" },
    state: { status: "open", budget: "0", funded: "0", rewardPerAccepted: "0", accepted: 0, deadline: 0 },
    ...overrides,
  } as JobView;
}

test("registeredSpec drops the fields the verifier adds", () => {
  const spec = registeredSpec(job2View()) as Record<string, unknown>;
  assert.equal(spec.specHash, undefined);
  assert.equal(spec.chain, undefined);
  assert.equal(spec.state, undefined);
  assert.equal(spec.slug, "volume-discount-fee-swaps");
});

test("job 2's spec hashes to the value stored on mainnet", () => {
  const { computed, findings } = verifyJobSpec(job2View(), JOB2_HASH);
  assert.equal(computed, JOB2_HASH);
  assert.ok(findings.every((f) => f.ok));
});

test("a spec changed after funding no longer matches the chain", () => {
  const changed = job2View({ objective: "Something easier." } as Partial<JobView>);
  const { findings } = verifyJobSpec(changed, JOB2_HASH);
  assert.equal(findings[0].ok, false, "the verifier's reported hash no longer matches");
  assert.equal(findings[1].ok, false, "the on-chain hash no longer matches");
});

const REPORT: HookReport = {
  version: 1,
  hook: "0x0Af57F62982D03066ef917AcAd87F771c06528Ec",
  chainId: 4663,
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  block: "118485512",
  checkedAt: 1795000000000,
  flags: ["afterSwap"],
  implementation: null,
  pools: [],
  checks: [{ id: "code", title: "Contract code exists", status: "pass", detail: "1,234 bytes" }],
  summary: { passed: 1, total: 1, warnings: 0, failed: 0 },
} as HookReport;

async function signed(report = REPORT) {
  const account = privateKeyToAccount(generatePrivateKey());
  const message = reportMessage(report);
  return { account, check: { report, message, signature: await account.signMessage({ message }), signer: account.address } };
}

test("a genuine signed hook check verifies", async () => {
  const { account, check } = await signed();
  const findings = await verifyHookCheck(check, async (a) => a === account.address);
  assert.deepEqual(findings.map((f) => f.ok), [true, true, true]);
});

test("edited results break the digest", async () => {
  const { check } = await signed();
  const edited = { ...check, report: { ...check.report, summary: { ...check.report.summary, failed: 0, passed: 9, total: 9 } } };
  const findings = await verifyHookCheck(edited, async () => true);
  assert.equal(findings[0].ok, false);
});

test("a signature from an unapproved key is reported", async () => {
  const { check } = await signed();
  const findings = await verifyHookCheck(check, async () => false);
  assert.equal(findings[2].ok, false);
});

test("a signer field that does not match the signature is reported", async () => {
  const { check } = await signed();
  const other = privateKeyToAccount(generatePrivateKey()).address;
  const findings = await verifyHookCheck({ ...check, signer: other }, async () => true);
  assert.equal(findings[1].ok, false);
});

test("a rerun with the same statuses matches, whatever the wording", () => {
  const rerun = { ...REPORT, checks: REPORT.checks.map((c) => ({ ...c, detail: "worded differently" })) };
  assert.equal(compareRerun(REPORT, rerun).ok, true);
});

test("a rerun that disagrees names the check", () => {
  const rerun = { ...REPORT, checks: REPORT.checks.map((c) => ({ ...c, status: "fail" as const })) };
  const f = compareRerun(REPORT, rerun);
  assert.equal(f.ok, false);
  assert.match(f.detail, /code: published pass, rerun fail/);
});

test("a check missing from the rerun is reported", () => {
  const f = compareRerun(REPORT, { ...REPORT, checks: [] });
  assert.equal(f.ok, false);
  assert.match(f.detail, /rerun missing/);
});
