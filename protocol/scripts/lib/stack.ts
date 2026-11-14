/**
 * Local stack: anvil + ProbeJobs + MockUSD + verifier. Shared by the e2e test
 * and the dev stack. Uses anvil's well-known public test keys. Never use these
 * keys anywhere real.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mockUsdAbi, mockUsdBytecode, probeJobsAbi, probeJobsBytecode } from "../../src/shared/artifacts.ts";
import { publicClient, walletClient } from "../../src/shared/chain.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const PROTOCOL_DIR = resolve(here, "../..");
export const REPO_ROOT = resolve(PROTOCOL_DIR, "..");

export const ANVIL_KEYS = {
  owner: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  verifier: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  sponsor: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  operator: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
} as const;

export function bin(name: string) {
  const p = join(homedir(), ".foundry", "bin", name);
  return existsSync(p) ? p : name;
}

export type Stack = {
  rpcUrl: string;
  chainId: number;
  contract: `0x${string}`;
  usd: `0x${string}`;
  verifierUrl: string;
  dataDir: string;
  stop: () => void;
};

const procs: ChildProcess[] = [];
process.on("exit", () => procs.forEach((p) => p.kill()));

function startProcess(cmd: string, args: string[], env: NodeJS.ProcessEnv, logFile: string) {
  const out = createWriteStream(logFile);
  const p = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  p.stdout!.pipe(out);
  p.stderr!.pipe(out);
  procs.push(p);
  return p;
}

async function waitFor(fn: () => Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`timed out waiting for ${what}`);
}

export async function startStack(opts: { rpcPort: number; verifierPort: number; dataDir: string; host?: string }): Promise<Stack> {
  mkdirSync(opts.dataDir, { recursive: true });
  const rpcUrl = `http://127.0.0.1:${opts.rpcPort}`;
  const chainId = 31337;
  startProcess(bin("anvil"), ["--port", String(opts.rpcPort), "--chain-id", String(chainId), "--silent"], process.env, join(opts.dataDir, "anvil.log"));
  const client = publicClient(rpcUrl, chainId);
  await waitFor(async () => (await client.getChainId()) === chainId, "anvil");

  const owner = walletClient(rpcUrl, chainId, ANVIL_KEYS.owner);
  const deploy = async (abi: readonly unknown[], bytecode: `0x${string}`, args: unknown[]) => {
    const hash = await owner.deployContract({ abi, bytecode, args } as Parameters<typeof owner.deployContract>[0]);
    const r = await client.waitForTransactionReceipt({ hash });
    return r.contractAddress!;
  };
  const contract = await deploy(probeJobsAbi, probeJobsBytecode, [owner.account.address]);
  const usd = await deploy(mockUsdAbi, mockUsdBytecode, []);
  const verifierAddr = privateKeyToAccount(ANVIL_KEYS.verifier).address;
  await client.waitForTransactionReceipt({
    hash: await owner.writeContract({ address: contract, abi: probeJobsAbi, functionName: "setVerifier", args: [verifierAddr, true] }),
  });
  const sponsorAddr = privateKeyToAccount(ANVIL_KEYS.sponsor).address;
  await client.waitForTransactionReceipt({
    hash: await owner.writeContract({ address: usd, abi: mockUsdAbi, functionName: "mint", args: [sponsorAddr, parseUnits("100000", 6)] }),
  });

  const verifierUrl = `http://127.0.0.1:${opts.verifierPort}`;
  startProcess(
    process.execPath,
    [join(PROTOCOL_DIR, "src/verifier/server.ts")],
    {
      ...process.env,
      PORT: String(opts.verifierPort),
      HOST: opts.host ?? "127.0.0.1",
      RPC_URL: rpcUrl,
      CHAIN_ID: String(chainId),
      PROBE_JOBS_ADDRESS: contract,
      VERIFIER_PRIVATE_KEY: ANVIL_KEYS.verifier,
      DATA_DIR: join(opts.dataDir, "verifier"),
      JOBS_ROOT: REPO_ROOT,
      NETWORK_NAME: "Local test chain",
    },
    join(opts.dataDir, "verifier.log"),
  );
  await waitFor(async () => (await fetch(`${verifierUrl}/health`)).ok, "verifier");

  return {
    rpcUrl,
    chainId,
    contract,
    usd,
    verifierUrl,
    dataDir: opts.dataDir,
    stop: () => procs.forEach((p) => p.kill()),
  };
}

/** Run the probe CLI and stream its output. Resolves with combined output. */
export function probe(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; output: string }> {
  return new Promise((resolvePromise) => {
    const p = spawn(process.execPath, [join(PROTOCOL_DIR, "bin/probe.mjs"), ...args], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    p.stdout!.on("data", (d) => {
      output += d;
      process.stdout.write(d);
    });
    p.stderr!.on("data", (d) => {
      output += d;
      process.stderr.write(d);
    });
    p.on("close", (code) => resolvePromise({ code: code ?? 1, output }));
  });
}
