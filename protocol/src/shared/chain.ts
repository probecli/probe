import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  defineChain,
  erc20Abi,
  http,
  type Chain,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { probeJobsAbi } from "./artifacts.ts";

export { probeJobsAbi, erc20Abi };

export function chainFor(chainId: number, rpcUrl: string): Chain {
  return defineChain({
    id: chainId,
    name: `chain-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

export function publicClient(rpcUrl: string, chainId: number): PublicClient {
  return createPublicClient({ chain: chainFor(chainId, rpcUrl), transport: http(rpcUrl) }) as PublicClient;
}

export function walletClient(rpcUrl: string, chainId: number, privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain: chainFor(chainId, rpcUrl), transport: http(rpcUrl) });
}

export const STATUS = ["none", "open", "closed"] as const;

export type OnchainJob = {
  sponsor: `0x${string}`;
  verifier: `0x${string}`;
  rewardToken: `0x${string}`;
  eligibilityToken: `0x${string}`;
  minHolding: bigint;
  rewardPerAccepted: bigint;
  budget: bigint;
  funded: bigint;
  deadline: bigint;
  accepted: number;
  status: number;
  specHash: `0x${string}`;
  reportKey: `0x${string}`;
};

export async function readJob(client: PublicClient, contract: `0x${string}`, jobId: bigint): Promise<OnchainJob> {
  return (await client.readContract({ address: contract, abi: probeJobsAbi, functionName: "getJob", args: [jobId] })) as OnchainJob;
}

export async function tokenMeta(client: PublicClient, token: `0x${string}`) {
  if (token === "0x0000000000000000000000000000000000000000") return { symbol: "ETH", decimals: 18 };
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { symbol, decimals };
}

/** The custom error name from a reverted contract call, if any. */
export function revertName(err: unknown): string | null {
  if (err instanceof BaseError) {
    const reverted = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) return reverted.data?.errorName ?? reverted.reason ?? null;
  }
  return null;
}

export function formatUnitsShort(value: bigint, decimals: number): string {
  const neg = value < 0n;
  const v = neg ? -value : value;
  const base = 10n ** BigInt(decimals);
  const whole = v / base;
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "").slice(0, 6);
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
