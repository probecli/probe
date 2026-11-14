/**
 * Long-running local stack for development: anvil, ProbeJobs, MockUSD, the
 * verifier, and one funded job. Optionally runs the seed cases once so the
 * website has real results to show. Stop with Ctrl-C.
 *
 *   npm run dev:stack            # job only
 *   npm run dev:stack -- --seed  # job plus one operator run
 */
import { join } from "node:path";
import { ANVIL_KEYS, PROTOCOL_DIR, REPO_ROOT, probe, startStack } from "./lib/stack.ts";

const seed = process.argv.includes("--seed");
const dataDir = join(PROTOCOL_DIR, ".data", `dev-${Date.now()}`);
const stack = await startStack({ rpcPort: Number(process.env.RPC_PORT ?? 8545), verifierPort: Number(process.env.VERIFIER_PORT ?? 8787), dataDir });
const env = {
  PROBE_HOME: join(dataDir, "probe-home"),
  PROBE_VERIFIER_URL: stack.verifierUrl,
  PROBE_REPO_ROOT: REPO_ROOT,
  RPC_URL: stack.rpcUrl,
  PROBE_SPONSOR_KEY: ANVIL_KEYS.sponsor,
  PROBE_OPERATOR_KEY: ANVIL_KEYS.operator,
};

await probe(["sponsor", "keygen"], env);
const created = await probe(
  ["sponsor", "create", "--spec", join(REPO_ROOT, "jobs/scheduled-exit-fee/job.json"), "--token", stack.usd, "--reward", "100", "--budget", "1000", "--days", "30"],
  env,
);
if (created.code !== 0) {
  stack.stop();
  process.exit(1);
}
if (seed) await probe(["work", "scheduled-exit-fee-withdrawals", "--no-agent", "--submit-all"], { ...env, ANTHROPIC_API_KEY: "" });

console.log(`
Local PROBE stack is running.
  RPC        ${stack.rpcUrl} (chain ${stack.chainId})
  ProbeJobs  ${stack.contract}
  mUSD       ${stack.usd}   (test token, mintable by anyone)
  Verifier   ${stack.verifierUrl}
  Logs       ${dataDir}

Point the website at it:
  PROBE_JOBS_FEED_URL=${stack.verifierUrl}/feed/jobs npm run dev

Run a job as an operator:
  PROBE_HOME=${env.PROBE_HOME} PROBE_VERIFIER_URL=${stack.verifierUrl} PROBE_OPERATOR_KEY=${ANVIL_KEYS.operator} \\
    node ${join(PROTOCOL_DIR, "bin/probe.mjs")} work scheduled-exit-fee-withdrawals

Press Ctrl-C to stop.`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stack.stop();
    process.exit(0);
  });
}
await new Promise(() => {});
