import { getAddress, isAddressEqual, recoverMessageAddress, type Hex } from "viem";
import type { JobView } from "./api.ts";
import { reportMessage, type HookReport } from "./hookcheck.ts";
import { specHash, type JobSpec } from "./spec.ts";

/** ProbeJobs deployments by chain id (deployments/robinhood-chain.json). */
export const PROBE_JOBS: Record<number, `0x${string}`> = {
  4663: "0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189",
  46630: "0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189",
};

/** One line of a verification: what was compared and whether it held. */
export type Finding = { ok: boolean; title: string; detail: string };

/** The spec a job was registered with: the verifier's job view minus what it adds (hash, chain binding, live state). */
export function registeredSpec(job: JobView | (JobSpec & Record<string, unknown>)): JobSpec {
  const { specHash: _h, chain: _c, state: _s, ...spec } = job as JobView;
  return spec as JobSpec;
}

/**
 * A job's spec is what operators work under. Its hash is stored on-chain at funding, so the
 * verifier cannot change scope or rules afterwards. Recompute it and compare both copies.
 */
export function verifyJobSpec(job: JobView, onchainSpecHash: Hex): { computed: Hex; findings: Finding[] } {
  const computed = specHash(registeredSpec(job));
  return {
    computed,
    findings: [
      {
        ok: computed === job.specHash,
        title: "The verifier's spec hashes to the hash it reports",
        detail: computed === job.specHash ? computed : `computed ${computed}, verifier reports ${job.specHash}`,
      },
      {
        ok: computed === onchainSpecHash.toLowerCase(),
        title: "The hash stored on-chain matches",
        detail: computed === onchainSpecHash.toLowerCase() ? `getJob(${job.chain.jobId}).specHash` : `on-chain ${onchainSpecHash}, computed ${computed}`,
      },
    ],
  };
}

export type SignedHookCheck = { report: HookReport; message: string; signature: Hex; signer: string };

/**
 * A published hook check is the verifier's EIP-191 signature over a message that names the chain,
 * hook, block and a digest of every result. Rebuild the message from the report, recover the signer,
 * and ask the contract whether that signer is an approved verifier.
 */
export async function verifyHookCheck(c: SignedHookCheck, approvedOnChain: (signer: `0x${string}`) => Promise<boolean>): Promise<Finding[]> {
  const rebuilt = reportMessage(c.report);
  const findings: Finding[] = [
    {
      ok: rebuilt === c.message,
      title: "The signed message matches the published results",
      detail: rebuilt === c.message ? (rebuilt.split("\n").find((l) => l.startsWith("digest ")) ?? "") : "the results do not hash to the digest that was signed",
    },
  ];
  let recovered: `0x${string}` | null = null;
  try {
    recovered = await recoverMessageAddress({ message: c.message, signature: c.signature });
  } catch {
    recovered = null;
  }
  const sameSigner = recovered !== null && isAddressEqual(recovered, getAddress(c.signer));
  findings.push({
    ok: sameSigner,
    title: "The signature recovers to the stated signer",
    detail: recovered ? `${recovered}` : "the signature is malformed",
  });
  if (recovered) {
    const approved = await approvedOnChain(recovered);
    findings.push({
      ok: approved,
      title: "The signer is an approved verifier on ProbeJobs",
      detail: approved ? `approvedVerifier(${recovered}) is true` : `approvedVerifier(${recovered}) is false`,
    });
  }
  return findings;
}

/**
 * A signature proves who published a hook check, not that its results are right. Rerunning the
 * checks at the same block against any RPC must give the same status for every check; wording can
 * differ with the pool sampled, so only ids and statuses are compared.
 */
export function compareRerun(published: HookReport, rerun: HookReport): Finding {
  const mine = new Map(rerun.checks.map((c) => [c.id, c.status]));
  const theirs = new Map(published.checks.map((c) => [c.id, c.status]));
  const diffs = [...new Set([...theirs.keys(), ...mine.keys()])]
    .filter((id) => theirs.get(id) !== mine.get(id))
    .map((id) => `${id}: published ${theirs.get(id) ?? "missing"}, rerun ${mine.get(id) ?? "missing"}`);
  return {
    ok: diffs.length === 0,
    title: "Rerunning the checks at the same block gives the same results",
    detail: diffs.length ? diffs.join("; ") : `${rerun.checks.length} of ${published.checks.length} checks match at block ${published.block}`,
  };
}
