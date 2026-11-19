import { readFileSync } from "node:fs";

// Replaced with a string literal by scripts/build-cli.ts; read from package.json when running the sources.
declare const __PROBE_VERSION__: string | undefined;

export const VERSION: string =
  typeof __PROBE_VERSION__ === "string"
    ? __PROBE_VERSION__
    : (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
