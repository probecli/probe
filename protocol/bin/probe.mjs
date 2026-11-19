#!/usr/bin/env node
// Entry point for the probe CLI. In the repository, Node 22.18+ runs the
// TypeScript sources directly. The npm package ships the bundled dist/probe.mjs.
import { existsSync } from "node:fs";

const src = new URL("../src/cli/main.ts", import.meta.url);
await import(existsSync(src) ? src.href : new URL("../dist/probe.mjs", import.meta.url).href);
