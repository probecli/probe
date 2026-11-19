import type { PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { publicClient } from "../shared/chain.ts";
import type { RegisteredJob } from "../shared/spec.ts";
import { loadConfig } from "./config.ts";
import { fail } from "./ui.ts";

/** Call the configured verifier's HTTP API. */
export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
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

/** The operator account, or exit with a hint when there is none. */
export function operator() {
  const key = loadConfig().operatorKey;
  if (!key) fail("No operator key. Run probe init first.");
  return privateKeyToAccount(key);
}

export function clientFor(job: RegisteredJob): PublicClient {
  return publicClient(job.chain.rpcUrl, job.chain.chainId);
}
