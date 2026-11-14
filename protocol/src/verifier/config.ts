import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { privateKeyToAccount } from "viem/accounts";

const here = dirname(fileURLToPath(import.meta.url));

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable ${name}. See protocol/README.md.`);
  return v;
}

export type VerifierConfig = ReturnType<typeof loadConfig>;

export function loadConfig() {
  const privateKey = required("VERIFIER_PRIVATE_KEY") as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("VERIFIER_PRIVATE_KEY must be a 32-byte hex key");
  const contract = required("PROBE_JOBS_ADDRESS") as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{40}$/.test(contract)) throw new Error("PROBE_JOBS_ADDRESS must be an address");
  return {
    port: Number(process.env.PORT ?? 8787),
    host: process.env.HOST ?? "127.0.0.1",
    rpcUrl: required("RPC_URL"),
    /** RPC URL given to operators. Defaults to RPC_URL. */
    publicRpcUrl: process.env.PUBLIC_RPC_URL ?? required("RPC_URL"),
    chainId: Number(required("CHAIN_ID")),
    contract,
    privateKey,
    address: privateKeyToAccount(privateKey).address,
    dataDir: resolve(process.env.DATA_DIR ?? resolve(here, "../../.data/verifier")),
    /** Job workspaces given as paths must live under this directory. */
    jobsRoot: resolve(process.env.JOBS_ROOT ?? resolve(here, "../../..")),
    explorerUrl: process.env.EXPLORER_URL,
    networkName: process.env.NETWORK_NAME ?? "Local chain",
    corsOrigin: process.env.CORS_ORIGIN ?? "*",
  };
}
