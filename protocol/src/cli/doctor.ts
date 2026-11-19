import { formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicClient } from "../shared/chain.ts";
import { forgeBin, run } from "../shared/forge.ts";
import type { JobView } from "../shared/api.ts";
import { agentAvailable, AGENT_MODEL } from "./agent.ts";
import { api } from "./client.ts";
import { configPath, loadConfig } from "./config.ts";
import { dim, hot } from "./ui.ts";

export const MIN_NODE = "22.18.0";

/** True when version a is at least version b ("22.18.0" >= "22.18"). */
export function atLeast(a: string, b: string): boolean {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

type Level = "ok" | "warn" | "fail";
export type Check = { name: string; level: Level; detail: string; fix?: string };

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = Date.now();
  const v = await fn();
  return [v, Date.now() - t];
}

/** Everything a probe work run depends on, checked in the order it is needed. */
export async function runChecks(): Promise<Check[]> {
  const checks: Check[] = [];
  const cfg = loadConfig();

  const node = process.versions.node;
  checks.push(
    atLeast(node, MIN_NODE)
      ? { name: "node", level: "ok", detail: `v${node}` }
      : { name: "node", level: "fail", detail: `v${node}, needs ${MIN_NODE} or later`, fix: "Install Node 22.18+ from nodejs.org or with your version manager." },
  );

  const forge = await run(forgeBin(), ["--version"], { cwd: process.cwd(), timeoutMs: 30_000 });
  checks.push(
    forge.code === 0
      ? { name: "foundry", level: "ok", detail: forge.stdout.split("\n")[0].replace(/^forge\s*(version:?\s*)?/i, "forge ").trim() }
      : { name: "foundry", level: "fail", detail: "forge not found", fix: "curl -L https://foundry.paradigm.xyz | bash && foundryup" },
  );

  const git = await run("git", ["--version"], { cwd: process.cwd(), timeoutMs: 30_000, env: process.env });
  checks.push(
    git.code === 0
      ? { name: "git", level: "ok", detail: git.stdout.trim().replace(/^git version /, "") }
      : { name: "git", level: "warn", detail: "not found; needed for jobs whose workspace is a git repository", fix: "Install git." },
  );

  let health: { chainId: number; contract: string; verifier: string; network?: string } | null = null;
  try {
    const [h, ms] = await timed(() => api<{ chainId: number; contract: string; verifier: string; network?: string }>("/health"));
    health = h;
    checks.push({ name: "verifier", level: "ok", detail: `${cfg.verifierUrl} answered in ${ms} ms (${h.network ?? `chain ${h.chainId}`})` });
  } catch (e) {
    checks.push({ name: "verifier", level: "fail", detail: (e as Error).message, fix: "Check your connection, or point at another verifier with probe init --verifier <url>." });
  }

  let rpc: { url: string; chainId: number } | null = null;
  if (health) {
    const jobs = await api<JobView[]>("/jobs").catch(() => []);
    const j = jobs.find((x) => x.chain.chainId === health!.chainId);
    if (j) {
      try {
        const client = publicClient(j.chain.rpcUrl, j.chain.chainId);
        const [[chainId, block], ms] = await timed(() => Promise.all([client.getChainId(), client.getBlockNumber()]));
        if (chainId !== health.chainId) {
          checks.push({ name: "chain", level: "fail", detail: `RPC reports chain ${chainId}, the verifier uses ${health.chainId}` });
        } else {
          rpc = { url: j.chain.rpcUrl, chainId };
          checks.push({ name: "chain", level: "ok", detail: `block ${block.toLocaleString("en-US")} in ${ms} ms` });
        }
      } catch (e) {
        checks.push({ name: "chain", level: "fail", detail: `cannot reach ${j.chain.rpcUrl}: ${(e as Error).message.split("\n")[0]}` });
      }
    } else {
      checks.push({ name: "chain", level: "warn", detail: "no jobs on this verifier yet, so no RPC to check" });
    }
  }

  if (!cfg.operatorKey) {
    checks.push({ name: "operator", level: "fail", detail: "no operator key", fix: "probe init" });
  } else {
    const address = privateKeyToAccount(cfg.operatorKey).address;
    if (rpc) {
      const gas = await publicClient(rpc.url, rpc.chainId).getBalance({ address }).catch(() => null);
      if (gas === 0n) {
        checks.push({ name: "operator", level: "warn", detail: `${address}, no gas`, fix: "Rewards are credited without gas, but probe withdraw needs a little native currency at this address." });
      } else {
        checks.push({ name: "operator", level: "ok", detail: `${address}${gas !== null ? `, ${formatEther(gas)} for gas` : ""}` });
      }
    } else {
      checks.push({ name: "operator", level: "ok", detail: address });
    }
  }

  checks.push(
    agentAvailable()
      ? { name: "agent", level: "ok", detail: `${AGENT_MODEL}, credentials found` }
      : { name: "agent", level: "warn", detail: "no credentials; probe work uses seed cases and your own (probe case new)", fix: "Set ANTHROPIC_API_KEY to have the agent write cases." },
  );
  return checks;
}

export async function doctor() {
  const checks = await runChecks();
  const glyph = { ok: dim("✓"), warn: dim("!"), fail: hot("×") };
  for (const c of checks) {
    console.log(`${glyph[c.level]} ${c.name.padEnd(9)} ${c.detail}`);
    if (c.fix && c.level !== "ok") console.log(`  ${" ".repeat(9)} ${dim(c.fix)}`);
  }
  const failed = checks.filter((c) => c.level === "fail").length;
  console.log("");
  console.log(dim(failed ? `${failed} problem${failed === 1 ? "" : "s"} to fix before probe work. Settings: ${configPath}` : `Ready. Settings: ${configPath}`));
  if (failed) process.exitCode = 1;
}
