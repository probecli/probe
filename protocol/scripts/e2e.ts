/**
 * End-to-end test of the whole protocol on a local chain:
 * deploy, fund a job, run `probe work`, verify, pay, withdraw, decrypt.
 * Exits non-zero on any failed assertion.
 */
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "viem";
import { publicClient } from "../src/shared/chain.ts";
import type { PublicSubmission } from "../src/shared/api.ts";
import { ANVIL_KEYS, REPO_ROOT, probe, startStack } from "./lib/stack.ts";

const work = mkdtempSync(join(process.env.E2E_TMP ?? tmpdir(), "probe-e2e-"));
let failures = 0;
const check = (ok: boolean, label: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures++;
};

console.log(`\n== Starting local chain and verifier (logs in ${work})`);
const stack = await startStack({ rpcPort: 8599, verifierPort: 8798, dataDir: work });
const env = {
  PROBE_HOME: join(work, "probe-home"),
  PROBE_VERIFIER_URL: stack.verifierUrl,
  PROBE_REPO_ROOT: REPO_ROOT,
  RPC_URL: stack.rpcUrl,
  PROBE_SPONSOR_KEY: ANVIL_KEYS.sponsor,
  PROBE_OPERATOR_KEY: ANVIL_KEYS.operator,
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
};
const slug = "scheduled-exit-fee-withdrawals";
const client = publicClient(stack.rpcUrl, stack.chainId);
const operator = privateKeyToAccount(ANVIL_KEYS.operator).address;

try {
  console.log("\n== Sponsor: report key, fund and register the job");
  check((await probe(["sponsor", "keygen"], env)).code === 0, "sponsor keygen");
  const created = await probe(
    ["sponsor", "create", "--spec", join(REPO_ROOT, "jobs/scheduled-exit-fee/job.json"), "--token", stack.usd, "--reward", "100", "--budget", "1000", "--days", "14"],
    env,
  );
  check(created.code === 0, "sponsor create funds and registers the job");

  console.log("\n== Operator: probe work");
  const worked = await probe(["work", slug, "--no-agent", "--submit-all"], env);
  check(worked.code === 0, "probe work completes");

  const subs = (await (await fetch(`${stack.verifierUrl}/jobs/${slug}/submissions`)).json()) as PublicSubmission[];
  const by = (name: string) => subs.find((s) => s.caseName === name);
  check(by("SameBlockFullWithdraw")?.verdict === "accepted", "full same-block withdrawal is accepted");
  check(by("SameBlockPartialWithdraw")?.verdict === "duplicate", "partial same-block withdrawal is a duplicate");
  check(by("ZeroLiquidityTickWithdraw")?.verdict === "failed" && /wall-clock/.test(by("ZeroLiquidityTickWithdraw")?.reason ?? ""), "wall-clock case fails verification");
  check(Boolean(by("SameBlockFullWithdraw")?.txHash), "accepted case was settled on-chain");

  console.log("\n== Operator: resubmitting the accepted case is a duplicate");
  const again = await probe(["work", slug, "--no-agent"], env);
  check(again.code === 0 && /duplicate/.test(again.output) && !/case \d accepted/.test(again.output), "second run earns nothing new");

  console.log("\n== Operator: withdraw");
  const before = await client.readContract({ address: stack.usd, abi: erc20Abi, functionName: "balanceOf", args: [operator] });
  check((await probe(["withdraw", slug], env)).code === 0, "probe withdraw");
  const after = await client.readContract({ address: stack.usd, abi: erc20Abi, functionName: "balanceOf", args: [operator] });
  check(after - before === 100_000_000n, `operator received exactly 100 mUSD (got ${(after - before).toString()})`);

  console.log("\n== Sponsor: decrypt the private report");
  const reports = await probe(["sponsor", "reports", slug], env);
  check(reports.code === 0, "sponsor reports");
  const file = reports.output.match(/(\S+\.json)/)?.[1];
  const report = file ? JSON.parse(readFileSync(file, "utf8")) : null;
  check(Boolean(report?.source?.includes("SameBlockFullWithdraw")) && Boolean(report?.trace?.includes("afterRemoveLiquidity")), "report decrypts to the case source and trace");

  console.log("\n== Public feed hides the exploit");
  const feedText = await (await fetch(`${stack.verifierUrl}/feed/jobs`)).text();
  check(!feedText.includes("assertGt") && feedText.includes(slug), "feed lists the job without case source");

  console.log("\n== Git workspace: a sponsor job cloned from a repository at a pinned commit");
  {
    const repo = join(work, "sponsor-repo");
    cpSync(join(REPO_ROOT, "jobs/scheduled-exit-fee"), repo, { recursive: true, filter: (p) => !/\/(out|cache)(\/|$)/.test(p) });
    // Vendor the libraries like a real sponsor repo would.
    for (const lib of ["forge-std", "v4-core"]) cpSync(join(REPO_ROOT, "contracts/lib", lib), join(repo, "lib", lib), { recursive: true });
    const toml = readFileSync(join(repo, "foundry.toml"), "utf8").replaceAll("../../contracts/lib", "lib");
    writeFileSync(join(repo, "foundry.toml"), toml);
    const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
    git("init", "-q");
    git("-c", "user.email=e2e@probe.local", "-c", "user.name=e2e", "add", "-A");
    git("-c", "user.email=e2e@probe.local", "-c", "user.name=e2e", "commit", "-q", "-m", "job");
    const commit = git("rev-parse", "HEAD");
    const spec = JSON.parse(readFileSync(join(REPO_ROOT, "jobs/scheduled-exit-fee/job.json"), "utf8"));
    spec.slug = "scheduled-exit-fee-from-git";
    spec.workspace = { git: repo, commit };
    const specFile = join(work, "git-job.json");
    writeFileSync(specFile, JSON.stringify(spec, null, 2));
    const gitHome = { ...env, PROBE_HOME: join(work, "probe-home-git") };
    await probe(["sponsor", "keygen"], gitHome);
    const c = await probe(["sponsor", "create", "--spec", specFile, "--token", stack.usd, "--reward", "50", "--budget", "500", "--days", "7"], gitHome);
    check(c.code === 0, "git-workspace job funds and registers (verifier cloned and compiled it)");
    const wk = await probe(["work", spec.slug, "--no-agent"], gitHome);
    check(wk.code === 0 && /case \d accepted/.test(wk.output), "operator run on the git-workspace job gets an accepted case");
  }

  console.log("\n== Reports are sponsor-only");
  const nosig = await fetch(`${stack.verifierUrl}/jobs/${slug}/reports?nonce=${Date.now()}&signature=0x00`);
  check(nosig.status >= 400, "unsigned report request is rejected");
} catch (e) {
  console.error(e);
  failures++;
} finally {
  stack.stop();
}

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll end-to-end checks passed.");
process.exit(failures ? 1 : 0);
