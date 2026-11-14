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
