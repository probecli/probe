import {
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  toFunctionSelector,
  toHex,
  type Hex,
  type PublicClient,
} from "viem";

/**
 * probe check: a fixed set of safety checks for a deployed Uniswap v4 hook,
 * read from the chain at one pinned block. Every check is deterministic for
 * that block, so anyone with an RPC can rerun it and get the same result.
 *
 * A passing check is evidence about one property at one block, not an audit.
 */

export const CHECK_VERSION = 1;

/** Uniswap v4 PoolManager per chain. Robinhood Chain: verified on-chain (owner, protocolFeeController, 24 KB runtime). */
export const POOL_MANAGERS: Record<number, { address: `0x${string}`; deployBlock: bigint }> = {
  4663: { address: "0x8366a39cc670b4001a1121b8f6a443a643e40951", deployBlock: 9070n },
};

/** Public RPC used when none is given: Robinhood Chain mainnet. */
export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";

/** Same outcome check for check, ignoring wording that depends on which pool was sampled. */
export const sameOutcome = (a: HookReport, b: HookReport) =>
  a.checks.map((c) => `${c.id}:${c.status}`).join() === b.checks.map((c) => `${c.id}:${c.status}`).join();

// ------------------------------------------------------------------ hook flags

/** Bit positions in the hook address, from v4-core Hooks.sol. */
export const FLAGS = [
  { bit: 13, name: "beforeInitialize" },
  { bit: 12, name: "afterInitialize" },
  { bit: 11, name: "beforeAddLiquidity" },
  { bit: 10, name: "afterAddLiquidity" },
  { bit: 9, name: "beforeRemoveLiquidity" },
  { bit: 8, name: "afterRemoveLiquidity" },
  { bit: 7, name: "beforeSwap" },
  { bit: 6, name: "afterSwap" },
  { bit: 5, name: "beforeDonate" },
  { bit: 4, name: "afterDonate" },
  { bit: 3, name: "beforeSwapReturnDelta" },
  { bit: 2, name: "afterSwapReturnDelta" },
  { bit: 1, name: "afterAddLiquidityReturnDelta" },
  { bit: 0, name: "afterRemoveLiquidityReturnDelta" },
] as const;

export type Callback =
  | "beforeInitialize"
  | "afterInitialize"
  | "beforeAddLiquidity"
  | "afterAddLiquidity"
  | "beforeRemoveLiquidity"
  | "afterRemoveLiquidity"
  | "beforeSwap"
  | "afterSwap"
  | "beforeDonate"
  | "afterDonate";

export const CALLBACKS: Callback[] = [
  "beforeInitialize",
  "afterInitialize",
  "beforeAddLiquidity",
  "afterAddLiquidity",
  "beforeRemoveLiquidity",
  "afterRemoveLiquidity",
  "beforeSwap",
  "afterSwap",
  "beforeDonate",
  "afterDonate",
];

/** A ...ReturnDelta flag only works together with its base callback (Hooks.isValidHookAddress). */
const DELTA_NEEDS: [string, Callback][] = [
  ["beforeSwapReturnDelta", "beforeSwap"],
  ["afterSwapReturnDelta", "afterSwap"],
  ["afterAddLiquidityReturnDelta", "afterAddLiquidity"],
  ["afterRemoveLiquidityReturnDelta", "afterRemoveLiquidity"],
];

export function decodeFlags(hook: string): string[] {
  const low = Number(BigInt(hook) & 0x3fffn);
  return FLAGS.filter((f) => (low >> f.bit) & 1).map((f) => f.name);
}

// ------------------------------------------------------------------ IHooks ABI

const KEY = "(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)";
const LIQ = "(int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)";
const SWAP = "(bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96)";

export const hooksAbi = parseAbi([
  `function beforeInitialize(address sender, ${KEY} key, uint160 sqrtPriceX96) returns (bytes4)`,
  `function afterInitialize(address sender, ${KEY} key, uint160 sqrtPriceX96, int24 tick) returns (bytes4)`,
  `function beforeAddLiquidity(address sender, ${KEY} key, ${LIQ} params, bytes hookData) returns (bytes4)`,
  `function afterAddLiquidity(address sender, ${KEY} key, ${LIQ} params, int256 delta, int256 feesAccrued, bytes hookData) returns (bytes4, int256)`,
  `function beforeRemoveLiquidity(address sender, ${KEY} key, ${LIQ} params, bytes hookData) returns (bytes4)`,
  `function afterRemoveLiquidity(address sender, ${KEY} key, ${LIQ} params, int256 delta, int256 feesAccrued, bytes hookData) returns (bytes4, int256)`,
  `function beforeSwap(address sender, ${KEY} key, ${SWAP} params, bytes hookData) returns (bytes4, int256, uint24)`,
  `function afterSwap(address sender, ${KEY} key, ${SWAP} params, int256 delta, bytes hookData) returns (bytes4, int128)`,
  `function beforeDonate(address sender, ${KEY} key, uint256 amount0, uint256 amount1, bytes hookData) returns (bytes4)`,
  `function afterDonate(address sender, ${KEY} key, uint256 amount0, uint256 amount1, bytes hookData) returns (bytes4)`,
]);

export const SELECTORS: Record<Callback, Hex> = Object.fromEntries(
  CALLBACKS.map((name) => [name, toFunctionSelector(hooksAbi.find((f) => f.name === name)!)]),
) as Record<Callback, Hex>;

const viewAbi = parseAbi([
  "function poolManager() view returns (address)",
  "function owner() view returns (address)",
]);

// ------------------------------------------------------------------ bytecode

/** Opcodes in runtime code, skipping PUSH data, plus every 3- and 4-byte PUSH value (function selectors). */
export function scanBytecode(code: Hex) {
  const all = Buffer.from(code.slice(2), "hex");
  // solc appends CBOR metadata whose length is the last two bytes; its bytes are not code.
  const metaLen = all.length >= 2 ? all.readUInt16BE(all.length - 2) : 0;
  const metaStart = all.length - 2 - metaLen;
  const bytes = metaLen > 0 && metaStart >= 0 && [0xa1, 0xa2, 0xa3].includes(all[metaStart]) ? all.subarray(0, metaStart) : all;
  const pushed = new Set<string>();
  const ops = new Set<number>();
  for (let i = 0; i < bytes.length; i++) {
    const op = bytes[i];
    ops.add(op);
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (n === 3 || n === 4) pushed.add(`0x${bytes.subarray(i + 1, i + 1 + n).toString("hex").padStart(8, "0")}`);
      i += n;
    }
  }
  return { pushed, ops, size: all.length };
}

const SLOT_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const SLOT_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582cfb8b5d50";

const slotAddress = (v: Hex | undefined) => {
  if (!v || BigInt(v) === 0n) return null;
  return getAddress(`0x${v.slice(-40)}`);
};

/** EIP-1167 minimal proxy: the target is embedded in the runtime code. */
export function minimalProxyTarget(code: Hex): `0x${string}` | null {
  const m = code.toLowerCase().match(/^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/);
  return m ? getAddress(`0x${m[1]}`) : null;
}

// ------------------------------------------------------------------ pools

export type PoolKey = { currency0: `0x${string}`; currency1: `0x${string}`; fee: number; tickSpacing: number; hooks: `0x${string}` };
export type PoolRef = PoolKey & { id: Hex; block: string };

export const INITIALIZE_TOPIC = keccak256(toHex("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"));

export function decodeInitialize(log: { topics: Hex[]; data: Hex; blockNumber: bigint | null }): PoolRef {
  const d = log.data.slice(2);
  const word = (i: number) => d.slice(i * 64, (i + 1) * 64);
  const int = (hex: string, bits: number) => {
    const v = BigInt(`0x${hex}`) & ((1n << BigInt(bits)) - 1n);
    return Number(v >= 1n << BigInt(bits - 1) ? v - (1n << BigInt(bits)) : v);
  };
  return {
    id: log.topics[1],
    currency0: getAddress(`0x${log.topics[2].slice(-40)}`),
    currency1: getAddress(`0x${log.topics[3].slice(-40)}`),
    fee: Number(BigInt(`0x${word(0)}`)),
    tickSpacing: int(word(1), 24),
    hooks: getAddress(`0x${word(2).slice(-40)}`),
    block: String(log.blockNumber ?? 0n),
  };
}

/**
 * Pools initialised with this hook, newest first, scanning back from `toBlock`
 * in chunks until `limit` pools are found or `maxBlocks` have been read.
 */
export async function findPools(
  client: PublicClient,
  poolManager: `0x${string}`,
  hook: `0x${string}`,
  opts: { toBlock: bigint; fromBlock: bigint; limit?: number; maxBlocks?: bigint; chunk?: bigint },
): Promise<{ pools: PoolRef[]; scannedFrom: bigint; complete: boolean }> {
  const limit = opts.limit ?? 5;
  let chunk = opts.chunk ?? 2_000_000n;
  const floor = opts.maxBlocks ? (opts.toBlock - opts.maxBlocks > opts.fromBlock ? opts.toBlock - opts.maxBlocks : opts.fromBlock) : opts.fromBlock;
  const want = hook.toLowerCase();
  const pools: PoolRef[] = [];
  let hi = opts.toBlock;
  while (hi >= floor && pools.length < limit) {
    const lo = hi - chunk + 1n > floor ? hi - chunk + 1n : floor;
    let logs;
    try {
      logs = await client.request({
        method: "eth_getLogs",
        params: [{ address: poolManager, topics: [INITIALIZE_TOPIC], fromBlock: toHex(lo), toBlock: toHex(hi) }],
      });
    } catch (e) {
      if (chunk > 50_000n) {
        chunk /= 4n;
        continue;
      }
      throw e;
    }
    const found = (logs as { topics: Hex[]; data: Hex; blockNumber: Hex }[])
      .filter((l) => `0x${l.data.slice(2 + 128 + 24, 2 + 192)}` === want)
      .map((l) => decodeInitialize({ ...l, blockNumber: BigInt(l.blockNumber) }))
      .reverse();
    pools.push(...found);
    hi = lo - 1n;
  }
  return { pools: pools.slice(0, limit), scannedFrom: hi + 1n, complete: hi < opts.fromBlock + 1n || hi + 1n <= opts.fromBlock };
}

// ------------------------------------------------------------------ report

export type CheckStatus = "pass" | "warn" | "fail" | "info";
export type CheckResult = { id: string; title: string; status: CheckStatus; detail: string; evidence?: Record<string, unknown> };

export type HookReport = {
  version: number;
  hook: `0x${string}`;
  chainId: number;
  poolManager: `0x${string}`;
  block: string;
  checkedAt: number;
  flags: string[];
  implementation: `0x${string}` | null;
  pools: PoolRef[];
  checks: CheckResult[];
  summary: { passed: number; total: number; warnings: number; failed: number };
};

const STRANGER = "0x00000000000000000000000000000000000ba5ed" as const;

function sampleArgs(cb: Callback, key: PoolKey) {
  const ts = Math.max(1, Math.abs(key.tickSpacing));
  const liq = (delta: bigint) => ({ tickLower: -ts * 10, tickUpper: ts * 10, liquidityDelta: delta, salt: `0x${"00".repeat(32)}` as Hex });
  const swap = { zeroForOne: true, amountSpecified: -1_000_000_000_000_000n, sqrtPriceLimitX96: 4295128740n };
  const s = STRANGER;
  switch (cb) {
    case "beforeInitialize":
      return [s, key, 1n << 96n] as const;
    case "afterInitialize":
      return [s, key, 1n << 96n, 0] as const;
    case "beforeAddLiquidity":
      return [s, key, liq(10n ** 18n), "0x"] as const;
    case "afterAddLiquidity":
      return [s, key, liq(10n ** 18n), 0n, 0n, "0x"] as const;
    case "beforeRemoveLiquidity":
      return [s, key, liq(-(10n ** 18n)), "0x"] as const;
    case "afterRemoveLiquidity":
      return [s, key, liq(-(10n ** 18n)), 0n, 0n, "0x"] as const;
    case "beforeSwap":
      return [s, key, swap, "0x"] as const;
    case "afterSwap":
      return [s, key, swap, 0n, "0x"] as const;
    case "beforeDonate":
    case "afterDonate":
      return [s, key, 0n, 0n, "0x"] as const;
  }
}

async function tryCall(client: PublicClient, from: `0x${string}`, to: `0x${string}`, data: Hex, blockNumber: bigint) {
  try {
    await client.call({ account: from, to, data, blockNumber });
    return "ok" as const;
  } catch {
    return "revert" as const;
  }
}

async function sourcifyMatch(chainId: number, address: string): Promise<string | null | "unreachable"> {
  try {
    const r = await fetch(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`, { signal: AbortSignal.timeout(10_000) });
    if (r.status === 404) return null;
    if (!r.ok) return "unreachable";
    const j = (await r.json()) as { match?: string | null };
    return j.match ?? null;
  } catch {
    return "unreachable";
  }
}

const isEoaCode = (code: Hex | undefined) => !code || code === "0x" || code.toLowerCase().startsWith("0xef0100");

export type CheckOptions = {
  chainId: number;
  block?: bigint;
  /** Pools to use for live calls; found on-chain when omitted. */
  pools?: PoolRef[];
  /** How far back to look for pools when none are given. */
  poolScanBlocks?: bigint;
  /** Skip the Sourcify lookup (offline or tests). */
  skipSource?: boolean;
};

export async function checkHook(client: PublicClient, hookInput: string, opts: CheckOptions): Promise<HookReport> {
  if (!isAddress(hookInput)) throw new Error(`${hookInput} is not an address.`);
  const hook = getAddress(hookInput);
  const pm = POOL_MANAGERS[opts.chainId];
  if (!pm) throw new Error(`No Uniswap v4 PoolManager is known for chain ${opts.chainId}.`);
  const poolManager = getAddress(pm.address);
  const block = opts.block ?? (await client.getBlockNumber());
  const checks: CheckResult[] = [];
  const at = { blockNumber: block };

  // 1. Code
  const code = (await client.getCode({ address: hook, ...at })) ?? "0x";
  if (code === "0x") {
    checks.push({ id: "code", title: "Contract code at the address", status: "fail", detail: `No contract at ${hook} at block ${block}.` });
    return finish({ hook, chainId: opts.chainId, poolManager, block, flags: decodeFlags(hook), implementation: null, pools: [], checks });
  }

  // Follow proxies so selectors and opcodes come from the code that actually runs.
  const [implSlot, adminSlot, beaconSlot] = await Promise.all(
    [SLOT_IMPL, SLOT_ADMIN, SLOT_BEACON].map((slot) => client.getStorageAt({ address: hook, slot: slot as Hex, ...at })),
  );
  const minimal = minimalProxyTarget(code);
  const impl = slotAddress(implSlot) ?? minimal;
  const admin = slotAddress(adminSlot);
  const beacon = slotAddress(beaconSlot);
  const runCode = impl ? ((await client.getCode({ address: impl, ...at })) ?? "0x") : code;
  const scan = scanBytecode(runCode);
  checks.push({
    id: "code",
    title: "Contract code at the address",
    status: "pass",
    detail: impl ? `Proxy to ${impl}, ${scan.size.toLocaleString("en-US")} bytes of logic.` : `${scan.size.toLocaleString("en-US")} bytes of runtime code.`,
  });

  // 2. Flags
  const flags = decodeFlags(hook);
  const enabled = CALLBACKS.filter((c) => flags.includes(c));
  const badDelta = DELTA_NEEDS.filter(([d, base]) => flags.includes(d) && !flags.includes(base)).map(([d, base]) => `${d} without ${base}`);
  checks.push(
    badDelta.length
      ? { id: "flags", title: "Permission flags are valid", status: "fail", detail: `The PoolManager rejects this address: ${badDelta.join(", ")}.` }
      : flags.length === 0
        ? { id: "flags", title: "Permission flags are valid", status: "warn", detail: "No callback flags are set. Pools can only use this address with a dynamic fee." }
        : { id: "flags", title: "Permission flags are valid", status: "pass", detail: `${flags.length} flag${flags.length === 1 ? "" : "s"} set: ${flags.join(", ")}.` },
  );

  // 3. Every enabled callback is implemented
  const missing = enabled.filter((c) => !scan.pushed.has(SELECTORS[c]));
  checks.push(
    missing.length
      ? {
          id: "callbacks",
          title: "Every enabled callback is implemented",
          status: "fail",
          detail: `Flag set but no ${missing.join(", ")} function in the code. Pool actions that call it would revert.`,
          evidence: { missing },
        }
      : {
          id: "callbacks",
          title: "Every enabled callback is implemented",
          status: "pass",
          detail: `${enabled.length} of ${enabled.length} enabled callbacks found in the code.`,
        },
  );

  // 4. Bound to the canonical PoolManager
  const boundTo = await client.readContract({ address: hook, abi: viewAbi, functionName: "poolManager", ...at }).catch(() => null);
  checks.push(
    boundTo === null
      ? { id: "pool-manager", title: "Bound to the canonical PoolManager", status: "warn", detail: "The hook has no poolManager() getter, so its binding cannot be read." }
      : getAddress(boundTo) === poolManager
        ? { id: "pool-manager", title: "Bound to the canonical PoolManager", status: "pass", detail: `poolManager() returns ${poolManager}.` }
        : { id: "pool-manager", title: "Bound to the canonical PoolManager", status: "fail", detail: `poolManager() returns ${getAddress(boundTo)}, not the canonical ${poolManager}.` },
  );

  // Pools that use this hook, for realistic call arguments.
  let pools = opts.pools ?? [];
  if (!opts.pools) {
    pools = (
      await findPools(client, poolManager, hook, { toBlock: block, fromBlock: pm.deployBlock, limit: 5, maxBlocks: opts.poolScanBlocks ?? 6_000_000n }).catch(() => ({
        pools: [] as PoolRef[],
      }))
    ).pools;
  }
  const key: PoolKey = pools[0] ?? {
    currency0: "0x0000000000000000000000000000000000000000",
    currency1: "0x0000000000000000000000000000000000000001",
    fee: 3000,
    tickSpacing: 60,
    hooks: hook,
  };

  // 5. Callbacks refuse callers other than the PoolManager
  if (enabled.length === 0) {
    checks.push({ id: "caller", title: "Callbacks refuse other callers", status: "info", detail: "No callbacks are enabled." });
  } else {
    const rows = await Promise.all(
      enabled.map(async (cb) => {
        const data = encodeFunctionData({ abi: hooksAbi, functionName: cb, args: sampleArgs(cb, key) as never });
        const [stranger, manager] = await Promise.all([tryCall(client, STRANGER, hook, data, block), tryCall(client, poolManager, hook, data, block)]);
        return { callback: cb, stranger, manager };
      }),
    );
    const open = rows.filter((r) => r.stranger === "ok");
    const confirmed = rows.filter((r) => r.stranger === "revert" && r.manager === "ok").length;
    checks.push(
      open.length
        ? {
            id: "caller",
            title: "Callbacks refuse other callers",
            status: "fail",
            detail: `${open.map((r) => r.callback).join(", ")} ${open.length === 1 ? "runs" : "run"} when called by an address that is not the PoolManager.`,
            evidence: { calls: rows, poolKey: key },
          }
        : {
            id: "caller",
            title: "Callbacks refuse other callers",
            status: "pass",
            detail: `All ${rows.length} enabled callbacks revert for an outside caller${confirmed ? `; ${confirmed} ran normally when the PoolManager called with the same arguments` : ""}.`,
            evidence: { calls: rows, poolKey: key },
          },
    );
  }

  // 6. Upgradeability
  if (impl || beacon) {
    const who = admin ?? (beacon ? `beacon ${beacon}` : null);
    checks.push({
      id: "upgrade",
      title: "Code cannot be replaced",
      status: "warn",
      detail: `Upgradeable proxy${minimal ? " (minimal clone, fixed target)" : ""}. ${who ? `Controlled by ${who}.` : "Upgrade control is in the logic contract."} The hook's behaviour can change after this check.`,
      evidence: { implementation: impl, admin, beacon },
    });
  } else {
    checks.push({ id: "upgrade", title: "Code cannot be replaced", status: "pass", detail: "Not a proxy. The code at this address cannot change." });
  }

  // 7. Owner powers
  const owner = await client.readContract({ address: hook, abi: viewAbi, functionName: "owner", ...at }).catch(() => null);
  if (owner === null) {
    checks.push({ id: "owner", title: "No single key controls the hook", status: "pass", detail: "No owner() function." });
  } else if (BigInt(owner) === 0n) {
    checks.push({ id: "owner", title: "No single key controls the hook", status: "pass", detail: "Ownership has been renounced." });
  } else {
    const ownerCode = await client.getCode({ address: owner, ...at });
    checks.push(
      isEoaCode(ownerCode)
        ? { id: "owner", title: "No single key controls the hook", status: "warn", detail: `Owned by ${owner}, a single key. Whatever owner-only functions the hook has, one signer can call them.` }
        : { id: "owner", title: "No single key controls the hook", status: "info", detail: `Owned by the contract ${owner}, often a multisig or timelock. Check who controls it.` },
    );
  }

  // 8. Opcodes
  const risky = [scan.ops.has(0xff) ? "SELFDESTRUCT" : null, scan.ops.has(0xf4) ? "DELEGATECALL" : null].filter(Boolean) as string[];
  checks.push(
    risky.length
      ? {
          id: "opcodes",
          title: "No self-destruct or delegatecall",
          status: "warn",
          detail: `The code contains ${risky.join(" and ")}. ${risky.includes("DELEGATECALL") ? "It can run code from another contract in its own storage." : ""}`.trim(),
        }
      : { id: "opcodes", title: "No self-destruct or delegatecall", status: "pass", detail: "Neither opcode appears in the code." },
  );

  // 9. Source
  if (!opts.skipSource) {
    const m = await sourcifyMatch(opts.chainId, impl ?? hook);
    checks.push(
      m === "unreachable"
        ? { id: "source", title: "Source code is verified", status: "info", detail: "Sourcify could not be reached." }
        : m
          ? { id: "source", title: "Source code is verified", status: "pass", detail: `Sourcify ${m === "exact_match" ? "exact match" : "match"}${impl ? " for the implementation" : ""}.` }
          : { id: "source", title: "Source code is verified", status: "warn", detail: "No Sourcify match. Nobody can read what this code does without decompiling it." },
    );
  }

  return finish({ hook, chainId: opts.chainId, poolManager, block, flags, implementation: impl, pools, checks });
}

function finish(r: Omit<HookReport, "version" | "checkedAt" | "summary" | "block"> & { block: bigint }): HookReport {
  const scored = r.checks.filter((c) => c.status !== "info");
  return {
    ...r,
    version: CHECK_VERSION,
    block: r.block.toString(),
    checkedAt: Date.now(),
    summary: {
      passed: scored.filter((c) => c.status === "pass").length,
      total: scored.length,
      warnings: scored.filter((c) => c.status === "warn").length,
      failed: scored.filter((c) => c.status === "fail").length,
    },
  };
}

/** The bytes a verifier signs: everything except the timestamp, in a fixed key order. */
export function reportDigest(r: HookReport): Hex {
  const { checkedAt: _t, ...rest } = r;
  return keccak256(toHex(JSON.stringify(rest, (_k, v) => (typeof v === "bigint" ? v.toString() : v))));
}

export const reportMessage = (r: HookReport) => `PROBE hook check v${r.version}\nchain ${r.chainId}\nhook ${r.hook}\nblock ${r.block}\ndigest ${reportDigest(r)}`;
