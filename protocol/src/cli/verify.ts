import { parseArgs } from "node:util";
import { getAddress, isAddress } from "viem";
import type { JobView } from "../shared/api.ts";
import { probeJobsAbi, publicClient, readJob } from "../shared/chain.ts";
import { checkHook, DEFAULT_RPC, type HookReport } from "../shared/hookcheck.ts";
import { compareRerun, PROBE_JOBS, verifyHookCheck, verifyJobSpec, type Finding, type SignedHookCheck } from "../shared/verify.ts";
import { api, clientFor } from "./client.ts";
import { printJson } from "./format.ts";
import { bold, dim, fail, hot, task } from "./ui.ts";

const SITE = process.env.PROBE_SITE_URL ?? "https://probecli.com";

const USAGE = "Usage: probe verify job <job> | probe verify hook <address> [--rerun] [--rpc <url>] [--json]";

function printFindings(findings: Finding[]) {
  console.log("");
  for (const f of findings) {
    console.log(`${f.ok ? dim("✓") : hot("×")} ${f.ok ? f.title : hot(f.title)}`);
    console.log(`  ${dim(f.detail)}`);
  }
  console.log("");
  const failed = findings.filter((f) => !f.ok).length;
  console.log(failed ? `${hot("×")} ${bold(`${failed} of ${findings.length} did not hold`)}` : `${dim("✓")} ${bold(`All ${findings.length} held`)}`);
  if (failed) process.exitCode = 1;
}

/** probe verify job <job>: the spec the verifier serves is the one whose hash was stored at funding. */
async function verifyJob(slug: string, json: boolean) {
  const job = await api<JobView>(`/jobs/${slug}`);
  const onchain = await readJob(clientFor(job), job.chain.contract, BigInt(job.chain.jobId));
  const { computed, findings } = verifyJobSpec(job, onchain.specHash);
  if (json) {
    printJson({ job: slug, jobId: job.chain.jobId, contract: job.chain.contract, computed, verifier: job.specHash, onchain: onchain.specHash, findings });
    if (findings.some((f) => !f.ok)) process.exitCode = 1;
    return;
  }
  console.log(`${bold("probe verify job")} ${slug} ${dim(`job #${job.chain.jobId} on chain ${job.chain.chainId}`)}`);
  printFindings(findings);
  console.log(dim("  The scope and rules you work under cannot have changed since the job was funded."));
}

/** probe verify hook <address>: the published check was signed by an approved verifier over these exact results. */
async function verifyHook(address: string, json: boolean, rpc: string, rerun: boolean) {
  if (!isAddress(address)) fail(USAGE);
  const hook = getAddress(address);
  const published = await api<SignedHookCheck & { createdAt: number }>(`/hooks/${hook}`).catch((e: Error) =>
    fail(/not found|404|not been checked/i.test(e.message) ? `No published check for ${hook}. Publish one with: probe check ${hook} --publish` : e.message),
  );
  const report = published.report as HookReport;
  const contract = PROBE_JOBS[report.chainId];
  if (!contract) fail(`No ProbeJobs deployment known for chain ${report.chainId}.`);
  const client = publicClient(rpc, report.chainId);
  const approved = (signer: `0x${string}`) =>
    client.readContract({ address: contract, abi: probeJobsAbi, functionName: "approvedVerifier", args: [signer] }) as Promise<boolean>;
  const findings = json ? await verifyHookCheck(published, approved) : await task("Checking the signature and the signer", () => verifyHookCheck(published, approved), () => "done");
  if (rerun) {
    const at = Number(report.block).toLocaleString("en-US");
    const run = () => checkHook(client, hook, { chainId: report.chainId, block: BigInt(report.block) }).catch((e: Error) => e);
    const mine = json ? await run() : await task(`Rerunning the checks at block ${at}`, run, (r) => (r instanceof Error ? "could not run" : `${r.checks.length} checks`));
    if (mine instanceof Error) {
      const pruned = /historical state|missing trie node|state.*not available|header not found/i.test(mine.message);
      findings.push({
        ok: false,
        title: "Rerunning the checks at the same block gives the same results",
        detail: pruned
          ? `${rpc} no longer has the state for block ${at}. Rerun against an archive RPC: --rpc <url>`
          : `the rerun failed: ${mine.message.split("\n")[0]}`,
      });
    } else findings.push(compareRerun(report, mine));
  }
  if (json) {
    printJson({ hook, block: report.block, chainId: report.chainId, signer: published.signer, findings });
    if (findings.some((f) => !f.ok)) process.exitCode = 1;
    return;
  }
  console.log(`${dim("  hook")} ${hook} ${dim(`at block ${Number(report.block).toLocaleString("en-US")}, ${report.summary.passed} of ${report.summary.total} checks passed`)}`);
  printFindings(findings);
  if (!rerun) console.log(dim(`  Rerun the checks too: probe verify hook ${hook} --rerun`));
  console.log(dim(`  ${SITE}/hooks/${hook}`));
}

export async function verify(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { json: { type: "boolean", default: false }, rpc: { type: "string" }, rerun: { type: "boolean", default: false } },
  });
  const [kind, target] = positionals;
  if (!kind || !target) fail(USAGE);
  if (kind === "job") return verifyJob(target, values.json);
  if (kind === "hook") return verifyHook(target, values.json, values.rpc ?? process.env.PROBE_RPC_URL ?? DEFAULT_RPC, values.rerun);
  fail(USAGE);
}

type HookListing = { hook: string; block: string; flags: string[]; summary: HookReport["summary"]; checkedAt: number };

/** probe hooks: hooks with a published, signed check, newest first. */
export async function hooks(args: string[]) {
  const { values } = parseArgs({ args, options: { json: { type: "boolean", default: false } } });
  const list = await api<HookListing[]>("/hooks");
  if (values.json) return printJson(list);
  if (!list.length) return console.log(dim("No published hook checks yet. Publish one with: probe check <hook> --publish"));
  for (const h of list) {
    const s = h.summary;
    const line = s.failed ? hot(`${s.failed} failed`) : `${s.passed} of ${s.total} passed${s.warnings ? `, ${s.warnings} warning${s.warnings === 1 ? "" : "s"}` : ""}`;
    console.log(`${s.failed ? hot("×") : dim("✓")} ${h.hook}  ${line}  ${dim(`block ${Number(h.block).toLocaleString("en-US")}`)}`);
  }
  console.log(dim(`\n  ${list.length} published. Check one's signature: probe verify hook <address>`));
}
