// Bundle the CLI into dist/probe.mjs for npm. Node does not strip types from
// files under node_modules, so the published package ships JavaScript.
import { readFileSync, rmSync } from "node:fs";
import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
rmSync(new URL("../dist", import.meta.url), { recursive: true, force: true });

await build({
  entryPoints: [new URL("../src/cli/main.ts", import.meta.url).pathname],
  outfile: new URL("../dist/probe.mjs", import.meta.url).pathname,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external",
  define: { __PROBE_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "// probe CLI, bundled from protocol/src/cli. Source: https://github.com/probecli/probe" },
  legalComments: "none",
  logLevel: "warning",
});
console.log(`dist/probe.mjs built for probe ${pkg.version}`);
