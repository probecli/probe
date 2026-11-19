import { test } from "node:test";
import assert from "node:assert/strict";
import type { Hex, PublicClient } from "viem";
import { SELECTORS, checkHook, decodeFlags, decodeInitialize, minimalProxyTarget, reportDigest, scanBytecode } from "../src/shared/hookcheck.ts";

test("hook flags decode from the low 14 address bits", () => {
  // A live Robinhood Chain hook: 0x...a544 -> bits 13, 10, 8, 6, 2.
  assert.deepEqual(decodeFlags("0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544"), [
    "beforeInitialize",
    "afterAddLiquidity",
    "afterRemoveLiquidity",
    "afterSwap",
    "afterSwapReturnDelta",
  ]);
  assert.deepEqual(decodeFlags("0x0000000000000000000000000000000000004000"), []);
});

test("callback selectors match IHooks (forge inspect on v4-core)", () => {
  assert.deepEqual(SELECTORS, {
    beforeInitialize: "0xdc98354e",
    afterInitialize: "0x6fe7e6eb",
    beforeAddLiquidity: "0x259982e5",
    afterAddLiquidity: "0x9f063efc",
    beforeRemoveLiquidity: "0x21d0ee70",
    afterRemoveLiquidity: "0x6c2bbe7e",
    beforeSwap: "0x575e24b4",
    afterSwap: "0xb47b2fb1",
    beforeDonate: "0xb6a8b0fa",
    afterDonate: "0xe1b4af69",
  });
});

test("bytecode scan reads PUSH4 values and skips PUSH data and metadata", () => {
  // PUSH4 575e24b4, PUSH4 ffffffff (0xff inside data is not SELFDESTRUCT), STOP, then a CBOR tail containing 0xf4 0xff.
  const meta = "a26469706673f4ff";
  const code = `0x63575e24b463ffffffff00${meta}${(meta.length / 2).toString(16).padStart(4, "0")}` as Hex;
  const s = scanBytecode(code);
  assert.ok(s.pushed.has("0x575e24b4"));
  assert.ok(!s.ops.has(0xff));
  assert.ok(!s.ops.has(0xf4));
  assert.ok(scanBytecode("0x5af4ff").ops.has(0xff));
});

test("minimal proxies are recognised", () => {
  const target = "bebebebebebebebebebebebebebebebebebebebe";
  assert.equal(minimalProxyTarget(`0x363d3d373d3d3d363d73${target}5af43d82803e903d91602b57fd5bf3`)?.toLowerCase(), `0x${target}`);
  assert.equal(minimalProxyTarget("0x6080"), null);
});

test("Initialize logs decode to a pool key", () => {
  const pad = (h: string) => h.replace(/^0x/, "").padStart(64, "0");
  const neg60 = (2n ** 256n - 60n).toString(16);
  const p = decodeInitialize({
    topics: [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, `0x${pad("0x0")}`, `0x${pad("0x" + "ab".repeat(20))}`],
    data: `0x${pad("0xbb8")}${neg60}${pad("0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544")}${pad("0x1")}${pad("0x0")}` as Hex,
    blockNumber: 7n,
  });
  assert.equal(p.fee, 3000);
  assert.equal(p.tickSpacing, -60);
  assert.equal(p.hooks.toLowerCase(), "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544");
  assert.equal(p.block, "7");
});

// ---------------------------------------------------------------- fake chain

const PM = "0x8366a39cc670b4001a1121b8f6a443a643e40951";

function fakeChain(o: { code: Hex; openToAnyone?: boolean; owner?: string | null; poolManager?: string | null }) {
  const client = {
    getBlockNumber: async () => 100n,
    getCode: async ({ address }: { address: string }) => (address.toLowerCase() === (o.owner ?? "").toLowerCase() ? "0x" : o.code),
    getStorageAt: async () => `0x${"00".repeat(32)}`,
    readContract: async ({ functionName }: { functionName: string }) => {
      if (functionName === "poolManager") {
        if (o.poolManager === null) throw new Error("no getter");
        return o.poolManager ?? PM;
      }
      if (functionName === "owner") {
        if (!o.owner) throw new Error("no owner");
        return o.owner;
      }
      throw new Error("unexpected");
    },
    call: async ({ account }: { account: string }) => {
      if (account.toLowerCase() === PM || o.openToAnyone) return { data: "0x" };
      throw new Error("revert");
    },
    request: async () => [],
  };
  return client as unknown as PublicClient;
}

// Hook address with beforeSwap (bit 7) and afterSwap (bit 6): ...00c0.
const HOOK = "0x00000000000000000000000000000000000000c0";
const codeWith = (...sels: string[]) => `0x${sels.map((s) => `63${s.slice(2)}`).join("")}00` as Hex;

test("a well-formed hook passes every scored check", async () => {
  const r = await checkHook(fakeChain({ code: codeWith(SELECTORS.beforeSwap, SELECTORS.afterSwap) }), HOOK, { chainId: 4663, skipSource: true });
  assert.equal(r.summary.failed, 0, JSON.stringify(r.checks, null, 2));
  assert.equal(r.summary.passed, r.summary.total);
  assert.equal(r.checks.find((c) => c.id === "caller")?.status, "pass");
});

test("a callback anyone can call fails the caller check", async () => {
  const r = await checkHook(fakeChain({ code: codeWith(SELECTORS.beforeSwap, SELECTORS.afterSwap), openToAnyone: true }), HOOK, { chainId: 4663, skipSource: true });
  const c = r.checks.find((x) => x.id === "caller")!;
  assert.equal(c.status, "fail");
  assert.match(c.detail, /beforeSwap, afterSwap run when called/);
});

test("an enabled flag with no function fails the callback check", async () => {
  const r = await checkHook(fakeChain({ code: codeWith(SELECTORS.beforeSwap) }), HOOK, { chainId: 4663, skipSource: true });
  assert.equal(r.checks.find((x) => x.id === "callbacks")?.status, "fail");
});

test("a delta flag without its base callback fails the flags check", async () => {
  // beforeSwapReturnDelta (bit 3) without beforeSwap (bit 7): ...0008.
  const r = await checkHook(fakeChain({ code: codeWith() }), "0x0000000000000000000000000000000000000008", { chainId: 4663, skipSource: true });
  assert.equal(r.checks.find((x) => x.id === "flags")?.status, "fail");
});

test("a wrong PoolManager and a single-key owner are reported", async () => {
  const r = await checkHook(
    fakeChain({ code: codeWith(SELECTORS.beforeSwap, SELECTORS.afterSwap), poolManager: "0x1111111111111111111111111111111111111111", owner: "0x2222222222222222222222222222222222222222" }),
    HOOK,
    { chainId: 4663, skipSource: true },
  );
  assert.equal(r.checks.find((x) => x.id === "pool-manager")?.status, "fail");
  assert.equal(r.checks.find((x) => x.id === "owner")?.status, "warn");
});

test("no code at the address fails and stops", async () => {
  const r = await checkHook(fakeChain({ code: "0x" }), HOOK, { chainId: 4663, skipSource: true });
  assert.equal(r.checks.length, 1);
  assert.equal(r.summary.failed, 1);
});

test("the signed digest ignores the timestamp only", async () => {
  const a = await checkHook(fakeChain({ code: codeWith(SELECTORS.beforeSwap, SELECTORS.afterSwap) }), HOOK, { chainId: 4663, skipSource: true });
  assert.equal(reportDigest(a), reportDigest({ ...a, checkedAt: 1 }));
  assert.notEqual(reportDigest(a), reportDigest({ ...a, block: "101" }));
});
