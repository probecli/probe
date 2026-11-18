import { keccak256, toHex } from "viem";

/** Messages signed with EIP-191 (personal_sign). Plain text so wallets show what is being signed. */

export const sourceHash = (source: string) => keccak256(toHex(source));

export function submissionMessage(p: { slug: string; sourceHash: string; nonce: number }) {
  return `PROBE case submission\njob: ${p.slug}\ncase: ${p.sourceHash}\nnonce: ${p.nonce}`;
}

export function registrationMessage(p: { slug: string; specHash: string; jobId: string; contract: string; chainId: number }) {
  return `PROBE job registration\njob: ${p.slug}\nspec: ${p.specHash}\nonchain: ${p.chainId}/${p.contract}/${p.jobId}`;
}

export function reportsMessage(p: { slug: string; nonce: number }) {
  return `PROBE sponsor reports\njob: ${p.slug}\nnonce: ${p.nonce}`;
}

// ------------------------------------------------------------ job requests

/** A team asking PROBE to open a testing job. Stored by the verifier, reviewed by the protocol owner. */
export type JobRequestInput = {
  team: string;
  hook: string;
  repo: string;
  network: string;
  pays: string;
  budget: string;
  scenarios: string;
  valid: string;
  contact: string;
  /** How the requester signed in (email or X handle), as reported by their browser. */
  login: string;
};

export const JOB_REQUEST_FIELDS = ["team", "hook", "repo", "network", "pays", "budget", "scenarios", "valid", "contact", "login"] as const;

export const JOB_REQUEST_STATUSES = ["new", "reviewing", "scoped", "live", "declined"] as const;
export type JobRequestStatus = (typeof JOB_REQUEST_STATUSES)[number];

/** Hash over the fields in a fixed order, so browser and verifier agree byte for byte. */
export function requestHash(r: JobRequestInput) {
  return keccak256(toHex(JSON.stringify(JOB_REQUEST_FIELDS.map((k) => r[k] ?? ""))));
}

export function requestMessage(p: { team: string; hash: string; issued: number }) {
  return `PROBE job request\nteam: ${p.team.replace(/\s+/g, " ").slice(0, 80)}\nrequest: ${p.hash}\nissued: ${p.issued}`;
}

export function requestsListMessage(p: { nonce: number }) {
  return `PROBE view job requests\nnonce: ${p.nonce}`;
}

export function requestStatusMessage(p: { id: string; status: string; nonce: number }) {
  return `PROBE update job request\nrequest: ${p.id}\nstatus: ${p.status}\nnonce: ${p.nonce}`;
}
