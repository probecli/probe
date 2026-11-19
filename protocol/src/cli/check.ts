import { parseArgs } from "node:util";
import { getAddress, isAddress } from "viem";
import { publicClient } from "../shared/chain.ts";
import { checkHook, DEFAULT_RPC, sameOutcome, type CheckStatus, type HookReport } from "../shared/hookcheck.ts";
import { api } from "./client.ts";
import { printJson } from "./format.ts";
import { bold, dim, fail, hot, task } from "./ui.ts";

const SITE = process.env.PROBE_SITE_URL ?? "https://probecli.com";

const GLYPH: Record<CheckStatus, (s: string) => string> = {
  pass: () => dim("✓"),
  warn: () => "!",
  fail: () => hot("×"),
  info: () => dim("·"),
};

export function printReport(r: HookReport) {
  console.log("");
  for (const c of r.checks) {
    console.log(`${GLYPH[c.status]("")} ${c.status === "fail" ? hot(c.title) : c.title}`);
    console.log(`  ${dim(c.detail)}`);
  }
  console.log("");
  const s = r.summary;
  const line = `${s.passed} of ${s.total} checks passed${s.failed ? `, ${s.failed} failed` : ""}${s.warnings ? `, ${s.warnings} warning${s.warnings === 1 ? "" : "s"}` : ""}`;
  console.log(`${s.failed ? hot("×") : dim("✓")} ${bold(line)} ${dim(`at block ${Number(r.block).toLocaleString("en-US")}`)}`);
  if (r.checks.length === 1) return;
  if (r.pools.length) console.log(dim(`  Live calls used pool ${r.pools[0].id.slice(0, 10)}…, one of the pools that use this hook.`));
  else console.log(dim("  No pool using this hook was found in the recent blocks scanned; live calls used a sample pool key."));
  console.log(dim("  A passing check is evidence about one property at one block, not an audit."));
}

/** probe check <hook>: run the standard checks locally, optionally have the verifier publish them. */
export async function check(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      rpc: { type: "string" },
      block: { type: "string" },
      json: { type: "boolean", default: false },
      publish: { type: "boolean", default: false },
    },
  });
  const hook = positionals[0];
  if (!hook || !isAddress(hook)) fail("Usage: probe check <hook address> [--rpc <url>] [--block <n>] [--json] [--publish]");

  const rpc = values.rpc ?? process.env.PROBE_RPC_URL ?? DEFAULT_RPC;
  const probeClient = publicClient(rpc, 1);
  const chainId = await probeClient.getChainId().catch(() => fail(`Cannot reach the RPC at ${rpc}. Pass another with --rpc <url>.`));
  const client = publicClient(rpc, chainId);
  const block = values.block ? BigInt(values.block) : await client.getBlockNumber();

  if (values.json && !values.publish) {
    const report = await checkHook(client, hook, { chainId, block });
    printJson(report);
    if (report.summary.failed) process.exitCode = 1;
    return;
  }

  console.log(`${bold("probe check")} ${getAddress(hook)} ${dim(`chain ${chainId}, block ${block.toLocaleString("en-US")}`)}`);
  const report = await task("Running the standard hook checks", () => checkHook(client, hook, { chainId, block }), (r) => `${r.checks.length} checks`);
  printReport(report);

  if (values.publish) {
    const published = await task(
      "Asking the verifier to reproduce and sign the result",
      () => api<{ report: HookReport; signature: string; signer: string }>("/checks", { method: "POST", body: { hook, block: block.toString() } }),
      (p) => `signed by ${p.signer.slice(0, 6)}…${p.signer.slice(-4)}`,
    );
    const same = sameOutcome(published.report, report);
    console.log(same ? dim("  The verifier's run matched yours check for check.") : hot("  The verifier's result differs from your run. Its signed copy is the one published."));
    console.log(`  ${SITE}/hooks/${getAddress(hook)}`);
    if (values.json) printJson(published);
  } else {
    console.log(dim(`  Publish this with a verifier signature: probe check ${getAddress(hook)} --publish`));
  }
  if (report.summary.failed) process.exitCode = 1;
}
