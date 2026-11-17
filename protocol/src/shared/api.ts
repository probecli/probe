import type { RegisteredJob } from "./spec.ts";

/** Wire types shared by the verifier and the CLI. */

export type Verdict = "accepted" | "duplicate" | "failed" | "ineligible";

export type SubmissionStatus = "queued" | "running" | "done";

export type PublicSubmission = {
  id: string;
  slug: string;
  operator: `0x${string}`;
  caseName: string;
  title: string;
  status: SubmissionStatus;
  verdict: Verdict | null;
  reason: string | null;
  fingerprint: `0x${string}` | null;
  newPaths: number | null;
  txHash: `0x${string}` | null;
  reward: string | null;
  reportId: string | null;
  createdAt: number;
  finishedAt: number | null;
};

export type JobView = RegisteredJob & {
  state: {
    status: "open" | "closed";
    budget: string;
    funded: string;
    rewardPerAccepted: string;
    accepted: number;
    deadline: number;
    sponsor: `0x${string}`;
    eligibilityToken: `0x${string}`;
    minHolding: string;
  };
};
