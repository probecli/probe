import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCase, caseTitle, contractNameOf } from "../src/shared/rules.ts";
import { canonicalJson, specHash, validateSpec, type JobSpec } from "../src/shared/spec.ts";
import { generateReportKeyPair, open, seal } from "../src/shared/crypto.ts";
import { fingerprintOf, parseLcov, pathDiff, prepareWorkspace } from "../src/shared/forge.ts";

const spec = { fixture: { base: "ProbeCase", import: "../ProbeCase.sol" }, allowedImports: ["forge-std/", "v4-core/"] };

const good = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import {ProbeCase} from "../ProbeCase.sol";
/// Withdraw in the same block as a fee change.
contract Good is ProbeCase {
    function test_it() public {
        scheduleFee(9_200);
        withdraw(1e18);
        assertGt(hookBalance0(), 0);
    }
}`;

const withBody = (body: string, extra = "") => good.replace(/function test_it\(\) public \{[\s\S]*?\n    \}/, `${extra}function test_it() public {\n${body}\n    }`);

test("accepts a well-formed case", () => {
  const r = checkCase(good, spec);
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.contractName, "Good");
});

const rejections: [string, string, RegExp][] = [
  ["wall clock", withBody("uint t = vm.unixTime(); assertGt(t, 0);"), /wall-clock/],
  ["ffi", withBody('string[] memory c; vm.ffi(c); assertTrue(true);'), /ffi/],
  ["env", withBody('vm.envString("PRIVATE_KEY"); assertTrue(true);'), /environment/],
  ["file read", withBody('vm.readFile("/etc/passwd"); assertTrue(true);'), /file system/],
  ["fork", withBody('vm.createSelectFork("mainnet"); assertTrue(true);'), /network/],
  ["randomness", withBody("uint r = vm.randomUint(); assertGt(r, 0);"), /randomness/],
  ["etch", withBody("vm.etch(address(hook), hex\"00\"); assertTrue(true);"), /rewrites/],
  ["store", withBody("vm.store(address(hook), bytes32(0), bytes32(0)); assertTrue(true);"), /rewrites/],
  ["mockCall", withBody('vm.mockCall(address(hook), "", ""); assertTrue(true);'), /rewrites/],
  ["assembly", withBody("assembly { let x := 1 } assertTrue(true);"), /assembly/],
  ["raw cheatcode address", withBody("address(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D).call(\"\"); assertTrue(true);"), /cheatcode address/],
  ["no assertion", withBody("withdraw(1e18);"), /does not assert/],
  ["constant assertion", withBody("withdraw(1e18);\n        assertTrue(true);"), /cannot fail/],
  ["self comparison", withBody("uint a = hookBalance0();\n        assertEq(a, a);"), /cannot fail/],
  ["fuzz test", good.replace("function test_it()", "function test_it(uint256 x)"), /fuzz/],
  ["skips setUp", withBody("assertTrue(true);", "function setUp() public override {}\n    "), /super\.setUp/],
  ["foreign import", good.replace('import {ProbeCase} from "../ProbeCase.sol";', 'import {ProbeCase} from "../ProbeCase.sol";\nimport {X} from "../../src/Secret.sol";'), /outside the job fixture/],
  ["not inheriting fixture", good.replace("is ProbeCase", "is Test"), /must inherit/],
  ["two contracts", good + "\ncontract Other is ProbeCase { function test_b() public { assertTrue(true); } }", /exactly one/],
];

for (const [name, source, reason] of rejections) {
  test(`rejects: ${name}`, () => {
    const r = checkCase(source, spec);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, reason);
  });
}

test("banned calls inside comments are ignored", () => {
  const r = checkCase(good.replace("scheduleFee(9_200);", "// do not use vm.unixTime() here\n        scheduleFee(9_200);"), spec);
  assert.equal(r.ok, true);
});

test("case title and contract name", () => {
  assert.equal(caseTitle(good, "Good"), "Withdraw in the same block as a fee change");
  assert.equal(contractNameOf(withBody("vm.unixTime();")), "Good");
});

test("spec hash is stable under key order and validates", () => {
  const s: JobSpec = JSON.parse(readFileSync(new URL("../../jobs/scheduled-exit-fee/job.json", import.meta.url), "utf8"));
  s.reportKey = generateReportKeyPair().publicKey;
  validateSpec(s);
  const shuffled = Object.fromEntries(Object.entries(s).reverse()) as JobSpec;
  assert.equal(specHash(s), specHash(shuffled));
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
  assert.throws(() => validateSpec({ ...s, slug: "Bad Slug" }), /slug/);
});

test("sealed reports open only with the sponsor key", () => {
  const sponsor = generateReportKeyPair();
  const other = generateReportKeyPair();
  const sealed = seal("exploit trace", sponsor.publicKey);
  assert.equal(open(sealed, sponsor.secretKey), "exploit trace");
  assert.throws(() => open(sealed, other.secretKey), /could not decrypt/);
  assert.ok(!JSON.stringify(sealed).includes("exploit"));
});

test("lcov parsing, path diff and fingerprint", () => {
  const lcov = ["SF:src/Hook.sol", "DA:10,1", "DA:11,0", "BRDA:12,0,0,1", "BRDA:12,0,1,-", "end_of_record", "SF:test/X.sol", "DA:1,1", "end_of_record"].join("\n");
  const items = parseLcov(lcov, ["src/Hook.sol"]);
  assert.deepEqual([...items].sort(), ["B:src/Hook.sol:12:0:0", "L:src/Hook.sol:10"]);
  const path = pathDiff(items, new Set(["L:src/Hook.sol:10"]));
  assert.deepEqual(path, ["B:src/Hook.sol:12:0:0"]);
  assert.equal(fingerprintOf(path), fingerprintOf([...path]));
  assert.notEqual(fingerprintOf(path), fingerprintOf(["L:src/Hook.sol:10"]));
});

test("workspace copies are sandboxed even if the job enables ffi", () => {
  const root = mkdtempSync(join(tmpdir(), "probe-ws-"));
  const src = join(root, "job");
  mkdirSync(join(src, "test"), { recursive: true });
  writeFileSync(
    join(src, "foundry.toml"),
    '[profile.default]\nsrc = "src"\nffi = true\nfs_permissions = [{ access = "read-write", path = "/"}]\neth_rpc_url = "https://x"\nlibs = ["../lib"]\nremappings = ["a/=../lib/a/"]\n',
  );
  const dest = prepareWorkspace(src, join(root, "copy"));
  const toml = readFileSync(join(dest, "foundry.toml"), "utf8");
  assert.match(toml, /ffi = false/);
  assert.doesNotMatch(toml, /ffi = true/);
  assert.match(toml, /fs_permissions = \[\]/);
  assert.doesNotMatch(toml, /read-write|eth_rpc_url/);
  assert.match(toml, new RegExp(`"${join(root, "lib").replace(/[/\\]/g, "\\/")}"`));
});

// ------------------------------------------------------------ operator-written cases

import { caseName, caseTemplate, fixtureHelpers } from "../src/cli/cases.ts";

const realFixture = readFileSync(new URL("../../jobs/scheduled-exit-fee/test/ProbeCase.sol", import.meta.url), "utf8");
const realJob = JSON.parse(readFileSync(new URL("../../jobs/scheduled-exit-fee/job.json", import.meta.url), "utf8"));

test("lists the fixture's helpers, not setUp", () => {
  const helpers = fixtureHelpers(realFixture);
  assert.deepEqual(
    helpers.map((h) => h.signature.split("(")[0]),
    ["scheduleFee", "nextBlock", "withdraw", "hookBalance0"],
  );
  const withdraw = helpers.find((h) => h.signature.startsWith("withdraw"))!;
  assert.equal(withdraw.signature, "withdraw(int256 liquidity) returns (uint256 received0, uint256 received1)");
  assert.equal(withdraw.doc, "Token amounts the LP received.");
});

test("turns typed names into Solidity identifiers", () => {
  assert.equal(caseName("fee spike withdraw"), "FeeSpikeWithdraw");
  assert.equal(caseName("TwoBlockExit.t.sol"), "TwoBlockExit");
  assert.throws(() => caseName("9lives"), /not a usable case name/);
  assert.throws(() => caseName("---"), /not a usable case name/);
});

test("a new case meets the job's rules before it is written", () => {
  const src = caseTemplate(realJob, "TwoBlockExit", fixtureHelpers(realFixture));
  const r = checkCase(src, realJob);
  assert.equal(r.ok, true, r.ok ? "" : r.reason);
  assert.match(src, /contract TwoBlockExit is ProbeCase/);
  assert.match(src, /scheduleFee\(uint24 fee\)/);
  assert.equal(contractNameOf(src), "TwoBlockExit");
});

// ------------------------------------------------------------ job details

import { ago, deadlineText, resultCounts } from "../src/cli/format.ts";

test("describes a deadline relative to now", () => {
  const now = Date.UTC(2026, 10, 19, 12);
  assert.equal(deadlineText(now / 1000 + 30 * 86400, now), "in 30 days (2026-12-19)");
  assert.equal(deadlineText(now / 1000 + 5 * 3600, now), "in 5 hours (2026-11-19)");
  assert.equal(deadlineText(now / 1000 + 600, now), "in 1 hour (2026-11-19)");
  assert.equal(deadlineText(now / 1000 - 1, now), "passed (2026-11-19)");
});

test("counts verdicts, most important first, with unfinished ones as pending", () => {
  const subs = [
    { status: "done", verdict: "duplicate" },
    { status: "running", verdict: null },
    { status: "done", verdict: "accepted" },
    { status: "done", verdict: "duplicate" },
  ] as const;
  assert.deepEqual(resultCounts([...subs]), [
    { verdict: "accepted", count: 1 },
    { verdict: "duplicate", count: 2 },
    { verdict: "pending", count: 1 },
  ]);
});

// ------------------------------------------------------------ doctor

import { atLeast, MIN_NODE } from "../src/cli/doctor.ts";

test("compares tool versions", () => {
  assert.equal(atLeast("22.18.0", MIN_NODE), true);
  assert.equal(atLeast("v24.1.0", MIN_NODE), true);
  assert.equal(atLeast("22.17.9", MIN_NODE), false);
  assert.equal(atLeast("22.18", "22.18.0"), true);
  assert.equal(atLeast("20.19.0", MIN_NODE), false);
});

test("says how long ago something happened", () => {
  const now = Date.UTC(2026, 10, 19, 12);
  assert.equal(ago(now - 20_000, now), "just now");
  assert.equal(ago(now - 5 * 60_000, now), "5m ago");
  assert.equal(ago(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(ago(now - 2 * 86_400_000, now), "2d ago");
  assert.equal(ago(Date.UTC(2026, 8, 1), now), "2026-09-01");
});
