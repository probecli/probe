import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export const PROBE_HOME = resolve(process.env.PROBE_HOME ?? join(homedir(), ".probe"));
const CONFIG = join(PROBE_HOME, "config.json");
const here = dirname(fileURLToPath(import.meta.url));
/** Repo root, used to resolve job workspaces given as paths during local development. */
export const REPO_ROOT = resolve(process.env.PROBE_REPO_ROOT ?? join(here, "../../.."));

export type CliConfig = {
  verifierUrl: string;
  operatorKey?: `0x${string}`;
  sponsorKey?: `0x${string}`;
  sponsorReportKey?: { publicKey: string; secretKey: string };
};

export function loadConfig(): CliConfig {
  const file: Partial<CliConfig> = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
  return {
    verifierUrl: process.env.PROBE_VERIFIER_URL ?? file.verifierUrl ?? "https://verifier.probecli.com",
    operatorKey: (process.env.PROBE_OPERATOR_KEY as `0x${string}` | undefined) ?? file.operatorKey,
    sponsorKey: (process.env.PROBE_SPONSOR_KEY as `0x${string}` | undefined) ?? file.sponsorKey,
    sponsorReportKey: file.sponsorReportKey,
  };
}

export function saveConfig(patch: Partial<CliConfig>) {
  mkdirSync(PROBE_HOME, { recursive: true, mode: 0o700 });
  const current = existsSync(CONFIG) ? JSON.parse(readFileSync(CONFIG, "utf8")) : {};
  writeFileSync(CONFIG, JSON.stringify({ ...current, ...patch }, null, 2), { mode: 0o600 });
  chmodSync(CONFIG, 0o600);
}

export function newOperatorKey() {
  const key = generatePrivateKey();
  return { key, address: privateKeyToAccount(key).address };
}

export const configPath = CONFIG;
