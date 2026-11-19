import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseUnits, toHex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi, formatUnitsShort, probeJobsAbi, publicClient, readJob, revertName, walletClient, ZERO_ADDRESS } from "../shared/chain.ts";
import { checkCase, caseTitle } from "../shared/rules.ts";
import { buildWorkspace, forgeInstalled, forgeTest, prepareWorkspace, run, resolveWorkspacePath, shortFp } from "../shared/forge.ts";
import { generateReportKeyPair, open, type SealedReport } from "../shared/crypto.ts";
import { registrationMessage, reportsMessage, sourceHash, submissionMessage } from "../shared/messages.ts";
import { specHash, validateSpec, type JobSpec, type RegisteredJob } from "../shared/spec.ts";
import type { JobView, PublicSubmission } from "../shared/api.ts";
import { configPath, loadConfig, newOperatorKey, PROBE_HOME, REPO_ROOT, saveConfig } from "./config.ts";
import { agentAvailable, AGENT_MODEL, proposeCases, repairCase, type AgentContext, type ProposedCase } from "./agent.ts";
import { bold, dim, fail, field, hot, note, payout, prompt, task, verdictLine } from "./ui.ts";

const HELP = `${bold("probe")}: test Uniswap v4 hooks, get paid for verified work.

Operator
  probe init [--verifier <url>]       Create an operator key and save settings
  probe whoami                        Show your operator address and verifier
  probe jobs                          List jobs on the verifier
  probe work <job> [options]          Run a job and submit what passes
      --agent / --no-agent            Use the AI agent (default: when credentials exist)
      --cases <n>                     Number of cases to ask the agent for (default 3)
      --dry-run                       Run locally, submit nothing
      --submit-all                    Also submit cases that break a rule (the verifier will reject them)
  probe status <submission-id>        Show a submission's verdict
  probe balance <job>                 Show what you are owed on a job's reward token
  probe withdraw <job>                Withdraw what you are owed

Sponsor
  probe sponsor keygen                Create your report-decryption key pair
  probe sponsor create --spec <file> --token <addr> --reward <amount> --budget <amount> [--days 14]
                       [--eligibility-token <addr> --min-holding <amount>]
  probe sponsor reports <job>         Download and decrypt private failure reports

Environment: PROBE_VERIFIER_URL, PROBE_OPERATOR_KEY, PROBE_SPONSOR_KEY, ANTHROPIC_API_KEY, PROBE_HOME
`;

// ------------------------------------------------------------------ http

async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const cfg = loadConfig();
  let res: Response;
  try {
    res = await fetch(`${cfg.verifierUrl}${path}`, {
      method: init?.method ?? "GET",
      headers: init?.body ? { "content-type": "application/json" } : undefined,
      body: init?.body ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new Error(`cannot reach the verifier at ${cfg.verifierUrl}. Set it with probe init --verifier <url>.`);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `verifier returned HTTP ${res.status}`);
  return body;
}

function operator() {
  const key = loadConfig().operatorKey;
  if (!key) fail("No operator key. Run probe init first.");
  return privateKeyToAccount(key);
}

function clientFor(job: RegisteredJob): PublicClient {
  return publicClient(job.chain.rpcUrl, job.chain.chainId);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ commands

async function init(args: string[]) {
  const { values } = parseArgs({ args, options: { verifier: { type: "string" }, force: { type: "boolean" } } });
  const cfg = loadConfig();
  if (values.verifier) saveConfig({ verifierUrl: values.verifier.replace(/\/$/, "") });
  if (cfg.operatorKey && !values.force) {
    console.log(`${prompt()} Operator ${privateKeyToAccount(cfg.operatorKey).address} already set up (${configPath}).`);
  } else {
    const { key, address } = newOperatorKey();
    saveConfig({ operatorKey: key });
    console.log(`${prompt()} Created operator ${bold(address)}`);
    note(`  Key saved to ${configPath} (readable only by you). Back it up: rewards are paid to this address.`);
  }
  console.log(`  ${dim("verifier")} ${loadConfig().verifierUrl}`);
}

async function whoami() {
  const cfg = loadConfig();
  console.log(`${dim("operator")} ${cfg.operatorKey ? privateKeyToAccount(cfg.operatorKey).address : "not set (probe init)"}`);
  console.log(`${dim("sponsor ")} ${cfg.sponsorKey ? privateKeyToAccount(cfg.sponsorKey).address : "not set"}`);
  console.log(`${dim("verifier")} ${cfg.verifierUrl}`);
  console.log(`${dim("agent   ")} ${agentAvailable() ? `${AGENT_MODEL} (credentials found)` : "no credentials; seed cases only"}`);
}

async function jobs() {
  const list = await api<JobView[]>("/jobs");
  if (!list.length) return note("No jobs registered on this verifier yet.");
  for (const j of list) {
    const d = j.chain.rewardDecimals;
    console.log(
      `${j.state.status === "open" ? hot("●") : dim("○")} ${bold(j.slug)}  ${j.title}\n    ${dim(
        `${formatUnitsShort(BigInt(j.state.rewardPerAccepted), d)} ${j.chain.rewardSymbol} per accepted case, ${formatUnitsShort(BigInt(j.state.budget), d)} ${j.chain.rewardSymbol} left, ${j.state.accepted} accepted, ${j.state.status}`,
      )}`,
    );
  }
}

/** Workspace copy for local runs. */
async function localWorkspace(job: RegisteredJob): Promise<string> {
  let src: string;
  if (job.workspace.path) {
    src = resolveWorkspacePath(REPO_ROOT, job.workspace.path);
    if (!existsSync(join(src, "foundry.toml"))) throw new Error(`workspace ${job.workspace.path} not found under ${REPO_ROOT}. Set PROBE_REPO_ROOT.`);
  } else {
    src = join(PROBE_HOME, "src", job.slug);
    if (!existsSync(join(src, ".git"))) {
      const r = await run("git", ["clone", "--recurse-submodules", job.workspace.git!, src], { cwd: PROBE_HOME, timeoutMs: 600_000, env: process.env });
      if (r.code !== 0) throw new Error(`git clone failed: ${r.stderr.slice(0, 300)}`);
    }
    await run("git", ["checkout", "--quiet", job.workspace.commit!], { cwd: src, env: process.env });
    await run("git", ["submodule", "update", "--init", "--recursive"], { cwd: src, timeoutMs: 600_000, env: process.env });
  }
  return prepareWorkspace(src, join(PROBE_HOME, "work", job.slug));
}

function seedCases(ws: string, job: JobSpec): ProposedCase[] {
  if (!job.seedCases) return [];
  const dir = join(ws, job.seedCases);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sol"))
    .sort()
    .map((f) => {
      const source = readFileSync(join(dir, f), "utf8");
      const name = f.replace(/\.t\.sol$|\.sol$/, "");
      return { name, title: caseTitle(source, name), source };
    });
}

async function runLocal(ws: string, c: ProposedCase) {
  const dir = join(ws, "test/cases");
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true });
  const rel = `test/cases/${c.name.replace(/[^A-Za-z0-9_]/g, "")}.t.sol`;
  writeFileSync(join(ws, rel), c.source);
  try {
    return await forgeTest(ws, rel, 1);
  } finally {
    rmSync(join(ws, rel), { force: true });
  }
}

async function work(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      agent: { type: "boolean" },
      "no-agent": { type: "boolean" },
      cases: { type: "string", default: "3" },
      "dry-run": { type: "boolean" },
      "submit-all": { type: "boolean" },
    },
  });
  const slug = positionals[0];
  if (!slug) fail("Usage: probe work <job>");
  const account = values["dry-run"] ? null : operator();

  console.log(`${prompt()} probe work ${slug}`);
  const job = await api<JobView>(`/jobs/${slug}`);
  const d = job.chain.rewardDecimals;
  const sym = job.chain.rewardSymbol;
  field("job", job.title);
  field("chain", `${job.network.name} (chain ${job.chain.chainId}), job #${job.chain.jobId}, snapshot #${job.snapshot.block.toLocaleString("en-US")}`);
  field("hook", `${job.hook.name} (${job.hook.callbacks.join(", ")})`);
  field("reward", `${formatUnitsShort(BigInt(job.state.rewardPerAccepted), d)} ${sym} per accepted case, ${formatUnitsShort(BigInt(job.state.budget), d)} ${sym} left`);
  if (account) field("operator", account.address);
  if (job.state.status !== "open") fail("This job is closed.");
  console.log("");
  if (!(await forgeInstalled())) {
    fail("Foundry is not installed. Install it with: curl -L https://foundry.paradigm.xyz | bash && foundryup, then run this again.");
  }

  const ws = await task(`Preparing workspace ${dim(job.snapshot.id)}`, () => localWorkspace(job), () => "ok");
  await task("Compiling the snapshot", async () => {
    const b = await buildWorkspace(ws);
    if (!b.ok) throw new Error(`the job workspace does not compile: ${b.error}`);
  }, () => "ok");

  const useAgent = values["no-agent"] ? false : values.agent ? true : agentAvailable();
  let cases: ProposedCase[];
  let ctx: AgentContext | null = null;
  if (useAgent) {
    const history = await api<PublicSubmission[]>(`/jobs/${slug}/submissions`).catch(() => []);
    ctx = {
      spec: job,
      fixtureSource: readFileSync(join(ws, "test", job.fixture.import.replace(/^\.\.\//, "")), "utf8"),
      targetSources: job.targets.map((p) => ({ path: p, source: readFileSync(join(ws, p), "utf8") })),
      exampleCase: seedCases(ws, job)[0]?.source,
      history: history.map((h) => ({ title: h.title, verdict: h.verdict, reason: h.reason })),
    };
    const n = Math.max(1, Math.min(8, Number(values.cases) || 3));
    cases = await task(`Agent proposing cases for ${job.hook.callbacks.at(-1)} ${dim(`(${AGENT_MODEL})`)}`, () => proposeCases(ctx!, n), (v) => `${v.length} cases`);
  } else {
    cases = seedCases(ws, job);
    note(`  No AI agent configured (set ANTHROPIC_API_KEY or run ant auth login). Using ${cases.length} seed cases from the job.`);
  }
  if (!cases.length) fail("No cases to run.");

  const toSubmit: ProposedCase[] = [];
  for (let i = 0; i < cases.length; i++) {
    let c = cases[i];
    let rules = checkCase(c.source, job);
    let local = rules.ok ? await runLocal(ws, c) : null;
    // One repair round with the agent for cases that fail locally.
    if (ctx && (!rules.ok || !local?.passed)) {
      const error = !rules.ok ? `Rule violation: ${rules.reason}` : local!.compileError ?? local!.tests.filter((t) => !t.passed).map((t) => `${t.name}: ${t.reason}`).join("\n");
      const fixed = await repairCase(ctx, c, error).catch(() => null);
      if (fixed) {
        c = fixed;
        rules = checkCase(c.source, job);
        local = rules.ok ? await runLocal(ws, c) : null;
      }
    }
    const label = `${dim(`case ${i + 1}/${cases.length}`)} ${c.title}`;
    if (local?.passed && rules.ok) {
      console.log(`${dim("·")} ${label} ${dim("passed locally")}`);
      toSubmit.push(c);
    } else if (!rules.ok) {
      const ran = await runLocal(ws, c).catch(() => null);
      console.log(`${dim("·")} ${label} ${dim(`${ran?.passed ? "passed locally, " : ""}breaks a rule: ${rules.reason}`)}`);
      if (values["submit-all"] && ran?.passed) toSubmit.push(c);
    } else {
      const why = local?.compileError ? "does not compile" : local?.tests.filter((t) => !t.passed).map((t) => t.name).join(", ") + " failed";
      console.log(`${dim("·")} ${label} ${dim(`failed locally: ${why}`)}`);
    }
  }

  if (values["dry-run"]) return note("\nDry run: nothing submitted.");
  if (!toSubmit.length) return note("\nNothing to submit.");

  console.log("");
  const submissions = await task(`Submitting ${toSubmit.length} case${toSubmit.length === 1 ? "" : "s"} to the verifier`, async () => {
    const out: { c: ProposedCase; sub: PublicSubmission }[] = [];
    for (const c of toSubmit) {
      const nonce = Date.now() + out.length;
      const signature = await account!.signMessage({ message: submissionMessage({ slug, sourceHash: sourceHash(c.source), nonce }) });
      const sub = await api<PublicSubmission>("/submissions", { method: "POST", body: { slug, source: c.source, operator: account!.address, nonce, signature } });
      out.push({ c, sub });
    }
    return out;
  }, () => "sent");

  const final = await task(`Verifier replaying ${submissions.length} case${submissions.length === 1 ? "" : "s"} on ${job.snapshot.id}`, async () => {
    const deadline = Date.now() + 15 * 60_000;
    while (Date.now() < deadline) {
      const latest = await Promise.all(submissions.map((s) => api<PublicSubmission>(`/submissions/${s.sub.id}`)));
      if (latest.every((s) => s.status === "done")) return latest;
      await sleep(1500);
    }
    throw new Error("still running after 15 minutes; check later with probe status");
  }, () => "done");
  final.forEach((s, i) => verdictLine(i + 1, s.verdict ?? "failed", s.reason ?? ""));

  const accepted = final.filter((s) => s.verdict === "accepted");
  console.log("");
  if (accepted.length) {
    const owed = await clientFor(job).readContract({ address: job.chain.contract, abi: probeJobsAbi, functionName: "owed", args: [job.chain.rewardToken, account!.address] });
    payout(`Payout step reached: ${accepted.map((a) => a.reward).join(" + ")} credited on-chain. You are owed ${formatUnitsShort(owed, d)} ${sym}.`);
    note(`  Claim it with: probe withdraw ${slug}`);
    for (const a of accepted) if (a.txHash) note(`  tx ${a.txHash}`);
  } else {
    note("No case was accepted this run. Read the verdicts above, then try a different path.");
  }
}

async function status(args: string[]) {
  const id = args[0];
  if (!id) fail("Usage: probe status <submission-id>");
  const s = await api<PublicSubmission>(`/submissions/${id}`);
  console.log(`${bold(s.title)} ${dim(`(${s.slug})`)}`);
  if (s.status !== "done") return note(`  ${s.status}`);
  verdictLine(1, s.verdict ?? "failed", s.reason ?? "");
  if (s.fingerprint) note(`  fingerprint ${shortFp(s.fingerprint)}`);
  if (s.txHash) note(`  tx ${s.txHash}`);
}

async function balance(args: string[]) {
  const slug = args[0];
  if (!slug) fail("Usage: probe balance <job>");
  const job = await api<JobView>(`/jobs/${slug}`);
  const account = operator();
  const owed = await clientFor(job).readContract({ address: job.chain.contract, abi: probeJobsAbi, functionName: "owed", args: [job.chain.rewardToken, account.address] });
  console.log(`${formatUnitsShort(owed, job.chain.rewardDecimals)} ${job.chain.rewardSymbol} owed to ${account.address}`);
}

async function withdraw(args: string[]) {
  const slug = args[0];
  if (!slug) fail("Usage: probe withdraw <job>");
  const job = await api<JobView>(`/jobs/${slug}`);
  const cfg = loadConfig();
  const account = operator();
  const client = clientFor(job);
  const owed = await client.readContract({ address: job.chain.contract, abi: probeJobsAbi, functionName: "owed", args: [job.chain.rewardToken, account.address] });
  if (owed === 0n) return note("Nothing to withdraw.");
  const wallet = walletClient(job.chain.rpcUrl, job.chain.chainId, cfg.operatorKey!);
  await task(`Withdrawing ${formatUnitsShort(owed, job.chain.rewardDecimals)} ${job.chain.rewardSymbol}`, async () => {
    try {
      const hash = await wallet.writeContract({ address: job.chain.contract, abi: probeJobsAbi, functionName: "withdraw", args: [job.chain.rewardToken] });
      const r = await client.waitForTransactionReceipt({ hash });
      if (r.status !== "success") throw new Error("transaction reverted");
      return hash;
    } catch (e) {
      const name = revertName(e);
      if (/insufficient funds/i.test(String(e))) throw new Error(`${account.address} needs a little native currency for gas`);
      throw new Error(name ?? (e as Error).message.split("\n")[0]);
    }
  }, (h) => `tx ${h}`);
}

// ------------------------------------------------------------------ sponsor

function sponsorAccount() {
  const key = loadConfig().sponsorKey;
  if (!key) fail("No sponsor key. Set PROBE_SPONSOR_KEY to the funding wallet's private key.");
  return { key, account: privateKeyToAccount(key) };
}

async function sponsorKeygen() {
  const cfg = loadConfig();
  if (cfg.sponsorReportKey) {
    console.log(`${prompt()} Report key already exists: ${cfg.sponsorReportKey.publicKey}`);
    return;
  }
  const kp = generateReportKeyPair();
  saveConfig({ sponsorReportKey: kp });
  console.log(`${prompt()} Report public key: ${bold(kp.publicKey)}`);
  note(`  Put it in your job spec as "reportKey". The secret key is in ${configPath}. Only it can open your reports.`);
}

async function sponsorCreate(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      spec: { type: "string" },
      token: { type: "string" },
      reward: { type: "string" },
      budget: { type: "string" },
      days: { type: "string", default: "14" },
      "eligibility-token": { type: "string" },
      "min-holding": { type: "string", default: "0" },
    },
  });
  if (!values.spec || !values.token || !values.reward || !values.budget) fail("Usage: probe sponsor create --spec <file> --token <addr> --reward <amount> --budget <amount>");
  const spec = JSON.parse(readFileSync(resolve(values.spec), "utf8"));
  const cfg = loadConfig();
  if (!spec.reportKey && cfg.sponsorReportKey) spec.reportKey = cfg.sponsorReportKey.publicKey;
  validateSpec(spec);
  const { key, account } = sponsorAccount();
  const health = await api<{ verifier: `0x${string}`; chainId: number; contract: `0x${string}` }>("/health");
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) fail("Set RPC_URL to the chain's RPC endpoint to send the funding transaction.");
  const client = publicClient(rpcUrl, health.chainId);
  const wallet = walletClient(rpcUrl, health.chainId, key);
  const token = values.token as `0x${string}`;
  const decimals = token === ZERO_ADDRESS ? 18 : await client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" });
  const reward = parseUnits(values.reward, decimals);
  const budget = parseUnits(values.budget, decimals);
  const eligibilityToken = (values["eligibility-token"] ?? ZERO_ADDRESS) as `0x${string}`;
  const minHolding = eligibilityToken === ZERO_ADDRESS ? 0n : parseUnits(values["min-holding"]!, await client.readContract({ address: eligibilityToken, abi: erc20Abi, functionName: "decimals" }));
  const hash = specHash(spec);
  const reportKey = toHex(new Uint8Array(Buffer.from(spec.reportKey, "base64")));

  console.log(`${prompt()} Creating job ${bold(spec.slug)} as ${account.address}`);
  if (token !== ZERO_ADDRESS) {
    await task("Approving the budget", async () => {
      const tx = await wallet.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [health.contract, budget] });
      await client.waitForTransactionReceipt({ hash: tx });
    }, () => "ok");
  }
  const jobId = await task("Funding the job on-chain", async () => {
    const { request, result } = await client.simulateContract({
      account,
      address: health.contract,
      abi: probeJobsAbi,
      functionName: "createJob",
      value: token === ZERO_ADDRESS ? budget : 0n,
      args: [{ verifier: health.verifier, rewardToken: token, eligibilityToken, minHolding, rewardPerAccepted: reward, budget, deadline: BigInt(Math.floor(Date.now() / 1000) + Number(values.days) * 86400), specHash: hash, reportKey }],
    });
    const tx = await wallet.writeContract(request);
    const r = await client.waitForTransactionReceipt({ hash: tx });
    if (r.status !== "success") throw new Error("createJob reverted");
    return result.toString();
  }, (id) => `job #${id}`);
  await task("Registering the spec with the verifier", async () => {
    const signature = await account.signMessage({ message: registrationMessage({ slug: spec.slug, specHash: hash, jobId, contract: health.contract, chainId: health.chainId }) });
    await api("/jobs", { method: "POST", body: { spec, jobId, signature } });
  }, () => "ready");
  const onchain = await readJob(client, health.contract, BigInt(jobId));
  payout(`Job ${spec.slug} is open with ${formatUnitsShort(onchain.budget, decimals)} funded. Operators can run: probe work ${spec.slug}`);
}

async function sponsorReports(args: string[]) {
  const slug = args[0];
  if (!slug) fail("Usage: probe sponsor reports <job>");
  const { account } = sponsorAccount();
  const secret = loadConfig().sponsorReportKey?.secretKey;
  if (!secret) fail("No report key on this machine. Reports can only be opened with the key from probe sponsor keygen.");
  const nonce = Date.now();
  const signature = await account.signMessage({ message: reportsMessage({ slug, nonce }) });
  const reports = await api<{ id: string; submissionId: string; sealed: SealedReport; createdAt: number }[]>(`/jobs/${slug}/reports?nonce=${nonce}&signature=${signature}`);
  if (!reports.length) return note("No private reports yet.");
  const dir = join(PROBE_HOME, "reports", slug);
  mkdirSync(dir, { recursive: true });
  for (const r of reports) {
    const body = JSON.parse(open(r.sealed, secret));
    const file = join(dir, `${r.id}.json`);
    writeFileSync(file, JSON.stringify(body, null, 2), { mode: 0o600 });
    console.log(`${hot("●")} ${body.case} ${dim(`fingerprint ${shortFp(body.fingerprint)}, operator ${body.operator}`)}\n  ${dim(file)}`);
  }
}

// ------------------------------------------------------------------ main

const [cmd, ...rest] = process.argv.slice(2);
const commands: Record<string, (a: string[]) => Promise<void>> = {
  init,
  whoami,
  jobs,
  work,
  status,
  balance,
  withdraw,
  sponsor: async (a) => {
    const [sub, ...r] = a;
    if (sub === "keygen") return sponsorKeygen();
    if (sub === "create") return sponsorCreate(r);
    if (sub === "reports") return sponsorReports(r);
    fail("Usage: probe sponsor keygen | create | reports");
  },
};

if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
  console.log(HELP);
} else if (!commands[cmd]) {
  fail(`Unknown command ${cmd}. Run probe help.`);
} else {
  commands[cmd](rest).catch((e) => fail(e instanceof Error ? e.message : String(e)));
}
