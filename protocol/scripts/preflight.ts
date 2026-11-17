/**
 * Launch preflight. Read-only: needs no keys and sends no transactions.
 *
 *   RPC_URL=… CHAIN_ID=… PROBE_JOBS_ADDRESS=0x… VERIFIER_URL=https://… \
 *   [EXPECTED_OWNER=0x…] [SITE_URL=https://…] npm run preflight
 *
 * Exits non-zero if anything a launch depends on is wrong.
 */
import { formatEther, keccak256 } from "viem";
import { probeJobsDeployedBytecode } from "../src/shared/artifacts.ts";
import { probeJobsAbi, publicClient, readJob } from "../src/shared/chain.ts";

let fails = 0;
let warns = 0;
const pass = (m: string) => console.log(`PASS  ${m}`);
const warn = (m: string) => (warns++, console.log(`WARN  ${m}`));
const fail = (m: string) => (fails++, console.log(`FAIL  ${m}`));

const need = (k: string) => {
  const v = process.env[k];
  if (!v) {
    console.error(`Set ${k}. See the header of scripts/preflight.ts.`);
    process.exit(2);
  }
  return v;
};
const rpcUrl = need("RPC_URL");
const chainId = Number(need("CHAIN_ID"));
const contract = need("PROBE_JOBS_ADDRESS") as `0x${string}`;
const verifierUrl = need("VERIFIER_URL").replace(/\/$/, "");
const siteUrl = process.env.SITE_URL?.replace(/\/$/, "");

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

console.log(`\nPROBE launch preflight\n  chain ${chainId}  rpc ${rpcUrl}\n  ProbeJobs ${contract}\n  verifier ${verifierUrl}\n`);

const client = publicClient(rpcUrl, chainId);

// ---- chain
try {
  const id = await client.getChainId();
  if (id === chainId) pass(`RPC answers on chain ${id}`);
  else fail(`RPC is on chain ${id}, expected ${chainId}`);
} catch (e) {
  fail(`RPC unreachable: ${(e as Error).message.split("\n")[0]}`);
  process.exit(1);
}

// ---- contract
const code = await client.getCode({ address: contract });
if (!code || code === "0x") {
  fail("No contract code at PROBE_JOBS_ADDRESS");
} else {
  pass("Contract code is deployed");
  const strip = (hex: string) => hex.slice(0, hex.length - 2 * (parseInt(hex.slice(-4), 16) + 2));
  if (keccak256(code) === keccak256(probeJobsDeployedBytecode)) pass("Deployed bytecode matches this repository's build exactly");
  else if (strip(code) === strip(probeJobsDeployedBytecode)) pass("Deployed bytecode matches this build (metadata differs)");
  else warn("Deployed bytecode differs from this repository's build. Rebuild with the same compiler settings and compare before trusting it.");
  const owner = (await client.readContract({ address: contract, abi: probeJobsAbi, functionName: "owner" })) as string;
  if (process.env.EXPECTED_OWNER) {
    if (owner.toLowerCase() === process.env.EXPECTED_OWNER.toLowerCase()) pass(`Owner is the expected address ${owner}`);
    else fail(`Owner is ${owner}, expected ${process.env.EXPECTED_OWNER}`);
  } else warn(`Owner is ${owner}. Set EXPECTED_OWNER to check it.`);
}

// ---- verifier
type Health = { ok: boolean; verifier: `0x${string}`; chainId: number; contract: string };
const health = await getJson<Health>(`${verifierUrl}/health`);
if (!health?.ok) {
  fail("Verifier /health does not respond");
} else {
  pass(`Verifier is up as ${health.verifier}`);
  if (health.chainId !== chainId) fail(`Verifier is on chain ${health.chainId}, expected ${chainId}`);
  if (health.contract.toLowerCase() !== contract.toLowerCase()) fail(`Verifier points at ${health.contract}, not ${contract}`);
  else pass("Verifier points at this contract");
  if (verifierUrl.startsWith("http://") && !/127\.0\.0\.1|localhost/.test(verifierUrl)) fail("Verifier is served over plain HTTP. Put it behind HTTPS.");
  const approved = await client.readContract({ address: contract, abi: probeJobsAbi, functionName: "approvedVerifier", args: [health.verifier] });
  if (approved) pass("Verifier is approved on-chain");
  else fail("Verifier address is not approved on-chain. Call setVerifier from the owner.");
  const gas = await client.getBalance({ address: health.verifier });
  if (gas === 0n) fail("Verifier has no gas. It cannot settle accepted results.");
  else if (gas < 10n ** 16n) warn(`Verifier gas is low: ${formatEther(gas)}`);
  else pass(`Verifier gas balance ${formatEther(gas)}`);

  type FeedJob = { slug: string; chainJobId: string; status: string; funding: { status: string } };
  const feed = await getJson<FeedJob[]>(`${verifierUrl}/feed/jobs`);
  if (!feed) fail("Verifier /feed/jobs does not respond");
  else {
    pass(`Job feed lists ${feed.length} job${feed.length === 1 ? "" : "s"}`);
    if (!feed.length) warn("No jobs are registered yet. Fund one before announcing launch.");
    for (const j of feed) {
      const s = await readJob(client, contract, BigInt(j.chainJobId));
      const open = s.status === 1 && BigInt(Math.floor(Date.now() / 1000)) <= s.deadline;
      const funded = s.budget >= s.rewardPerAccepted;
      (open && funded ? pass : warn)(`Job ${j.slug} (#${j.chainJobId}): ${open ? "open" : "closed"}, ${funded ? "funded" : "budget used"}`);
    }
  }
  const stats = await getJson<{ ok: boolean }>(`${verifierUrl}/stats`);
  (stats?.ok ? pass : fail)("Verifier /stats responds");
}

// ---- website
if (siteUrl) {
  for (const path of ["/", "/jobs", "/status", "/token", "/app"]) {
    try {
      const r = await fetch(`${siteUrl}${path}`, { signal: AbortSignal.timeout(15_000) });
      (r.ok ? pass : fail)(`Site ${path} returns ${r.status}`);
    } catch {
      fail(`Site ${path} unreachable`);
    }
  }
  const robots = await fetch(`${siteUrl}/robots.txt`).then((r) => r.text()).catch(() => "");
  if (/Disallow: \/\s*$/m.test(robots)) warn("robots.txt blocks search engines. Set SITE_URL and SITE_INDEXABLE=true when ready.");
  else pass("robots.txt allows indexing");
} else warn("SITE_URL not set; website checks skipped");

console.log(`\n${fails ? `${fails} failure(s)` : "No failures"}, ${warns} warning(s).`);
process.exit(fails ? 1 : 0);
