import Anthropic from "@anthropic-ai/sdk";
import type { JobSpec } from "../shared/spec.ts";

/**
 * The AI agent proposes Foundry test cases for a job. It suggests; the local
 * runner and the verifier decide. Credentials come from the environment
 * (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login` profile).
 */

export const AGENT_MODEL = process.env.PROBE_AGENT_MODEL ?? "claude-opus-5-5";

export type ProposedCase = { name: string; title: string; source: string };

export type AgentContext = {
  spec: JobSpec;
  fixtureSource: string;
  targetSources: { path: string; source: string }[];
  exampleCase?: string;
  /** Titles and verdicts already processed on this job, so the agent avoids duplicates. */
  history: { title: string; verdict: string | null; reason: string | null }[];
};

const SCHEMA = {
  type: "object",
  properties: {
    cases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Solidity contract name, PascalCase" },
          title: { type: "string", description: "One-line scenario description" },
          source: { type: "string", description: "Complete Solidity file" },
        },
        required: ["name", "title", "source"],
        additionalProperties: false,
      },
    },
  },
  required: ["cases"],
  additionalProperties: false,
} as const;

function system(spec: JobSpec) {
  return `You write Foundry test cases for a PROBE testing job on a Uniswap v4 hook.

Each case is one Solidity file that:
- imports {${spec.fixture.base}} from "${spec.fixture.import}" and defines exactly one contract that inherits ${spec.fixture.base} (the pinned job snapshot);
- has 1 to 3 test functions with no parameters, each asserting a concrete balance, fee or state outcome;
- uses only the helpers and state exposed by the fixture, forge-std and the allowed imports (${spec.allowedImports.join(", ")});
- never uses vm.unixTime, vm.ffi, vm.env*, file access, forks or rpc, vm.random*, vm.etch, vm.store, vm.mockCall, deployCodeTo, inline assembly, fuzz or invariant tests;
- starts with \`// SPDX-License-Identifier: MIT\` and \`pragma solidity ^0.8.26;\`, and puts a one-line /// comment describing the scenario directly above the contract.

A case that demonstrates a problem should pass when the problem is present (assert the bad outcome).
A case for coverage should assert the expected correct behavior.
Prefer scenarios that reach code paths the job history has not covered yet. Do not resubmit a scenario that was already accepted or marked duplicate.`;
}

function context(ctx: AgentContext) {
  const s = ctx.spec;
  return [
    `Job: ${s.title}`,
    `Objective: ${s.objective}`,
    `Pays for: ${s.rewardModel}`,
    `In scope:\n- ${s.inScope.join("\n- ")}`,
    `Out of scope:\n- ${s.outOfScope.join("\n- ")}`,
    `Acceptance rules:\n- ${s.acceptanceRules.join("\n- ")}`,
    `Fixture (${s.fixture.import}):\n\`\`\`solidity\n${ctx.fixtureSource}\n\`\`\``,
    ...ctx.targetSources.map((t) => `Target ${t.path}:\n\`\`\`solidity\n${t.source}\n\`\`\``),
    ctx.exampleCase ? `Example of a well-formed case:\n\`\`\`solidity\n${ctx.exampleCase}\n\`\`\`` : "",
    ctx.history.length
      ? `Already processed on this job:\n${ctx.history.map((h) => `- ${h.title}: ${h.verdict ?? "pending"}${h.reason ? ` (${h.reason})` : ""}`).join("\n")}`
      : "No results on this job yet.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function ask(client: Anthropic, ctx: AgentContext, instruction: string): Promise<ProposedCase[]> {
  const stream = client.beta.messages.stream({
    model: AGENT_MODEL,
    max_tokens: 64000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "high", format: { type: "json_schema", schema: SCHEMA } },
    system: system(ctx.spec),
    messages: [{ role: "user", content: `${context(ctx)}\n\n${instruction}` }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") throw new Error("the agent declined to write cases for this job");
  if (message.stop_reason === "max_tokens") throw new Error("the agent's answer was cut off; try fewer cases");
  const text = message.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  let parsed: { cases?: ProposedCase[] };
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("the agent returned malformed output");
  }
  return (parsed.cases ?? []).filter((c) => c && typeof c.source === "string" && typeof c.name === "string");
}

export function agentAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_PROFILE);
}

export async function proposeCases(ctx: AgentContext, count: number): Promise<ProposedCase[]> {
  const client = new Anthropic();
  return ask(client, ctx, `Write ${count} new, distinct cases for this job.`);
}

/** One repair round: give the agent the local error and ask for a fixed file. */
export async function repairCase(ctx: AgentContext, c: ProposedCase, error: string): Promise<ProposedCase | null> {
  const client = new Anthropic();
  const fixed = await ask(
    client,
    ctx,
    `This case failed locally. Fix it so it compiles, follows every rule, and passes on the snapshot while still testing the same scenario. Return exactly one case.\n\nCase ${c.name}:\n\`\`\`solidity\n${c.source}\n\`\`\`\n\nError:\n${error.slice(0, 6000)}`,
  );
  return fixed[0] ?? null;
}
