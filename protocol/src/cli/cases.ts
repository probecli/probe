import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { caseTitle, contractNameOf } from "../shared/rules.ts";
import type { JobSpec } from "../shared/spec.ts";
import type { ProposedCase } from "./agent.ts";

/** A helper the job fixture offers to cases: its signature and doc comment. */
export type FixtureHelper = { signature: string; doc: string | null };

/**
 * Internal and public helpers declared in the fixture, so a case author can
 * see what the snapshot offers without reading Solidity first. setUp is left
 * out: cases inherit it.
 */
export function fixtureHelpers(source: string): FixtureHelper[] {
  const out: FixtureHelper[] = [];
  const re = /((?:[ \t]*\/\/\/[^\n]*\n)*)[ \t]*function\s+(\w+)\s*\(([^)]*)\)\s*([^{;]*)[{;]/g;
  for (const m of source.matchAll(re)) {
    const [, docBlock, name, params, rest] = m;
    if (name === "setUp" || /\bprivate\b/.test(rest)) continue;
    const returns = rest.match(/returns\s*\(([^)]*)\)/)?.[1];
    const signature = `${name}(${params.replace(/\s+/g, " ").trim()})${returns ? ` returns (${returns.replace(/\s+/g, " ").trim()})` : ""}`;
    // NatSpec "@return a b Text" repeats the return names; keep only the text.
    const returnNames = new Set((returns ?? "").split(",").map((r) => r.trim().split(/\s+/).at(-1)).filter(Boolean));
    const doc = docBlock
      .split("\n")
      .map((l) => {
        const line = l.replace(/^\s*\/\/\/\s?/, "");
        const words = line.replace(/^@\w+\s*/, "").trim().split(/\s+/);
        if (/^@return\b/.test(line)) while (words.length && returnNames.has(words[0])) words.shift();
        return words.join(" ");
      })
      .filter(Boolean)
      .join(" ");
    out.push({ signature, doc: doc || null });
  }
  return out;
}

/** Solidity identifier from what the operator typed: "fee spike" -> "FeeSpike". */
export function caseName(input: string): string {
  const name = input
    .replace(/\.t\.sol$|\.sol$/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("");
  if (!name || /^[0-9]/.test(name)) throw new Error(`"${input}" is not a usable case name. Use letters, like FeeSpikeWithdraw.`);
  return name;
}

/**
 * A new case that already meets the job's structural rules: it imports and
 * inherits the fixture and has one fixed test with an assertion. It fails
 * on purpose until the author replaces the placeholder.
 */
export function caseTemplate(job: Pick<JobSpec, "slug" | "hook" | "fixture">, name: string, helpers: FixtureHelper[]): string {
  const fn = `test_${name[0].toLowerCase()}${name.slice(1)}`;
  const helperLines = helpers.length
    ? [
        `    // Helpers from ${job.fixture.base}:`,
        ...helpers.map((h) => `    //   ${h.signature}${h.doc ? `  ${h.doc}` : ""}`),
        `    //`,
      ]
    : [];
  return [
    "// SPDX-License-Identifier: MIT",
    "pragma solidity ^0.8.26;",
    "",
    `import {${job.fixture.base}} from "${job.fixture.import}";`,
    "",
    "/// TODO: one line saying what this case shows. It becomes the case title.",
    `/// Job ${job.slug}, hook ${job.hook.name} (${job.hook.callbacks.join(", ")}).`,
    `contract ${name} is ${job.fixture.base} {`,
    ...helperLines,
    "    // Set up the scenario with the helpers, then assert a concrete balance or fee",
    "    // outcome. No wall clock, randomness, network, files or env reads.",
    `    function ${fn}() public {`,
    `        assertTrue(false, "TODO: write this case");`,
    "    }",
    "}",
    "",
  ].join("\n");
}

/** Read case files the operator wrote, named after their test contract. */
export function loadCaseFiles(paths: string[]): ProposedCase[] {
  return paths.map((p) => {
    const source = readFileSync(p, "utf8");
    const name = contractNameOf(source) ?? basename(p).replace(/\.t\.sol$|\.sol$/, "");
    return { name, title: caseTitle(source, name), source };
  });
}
