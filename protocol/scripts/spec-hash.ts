// Print the spec hash of a job spec file, the value the ProbeJobs contract stores for the job.
//   node scripts/spec-hash.ts ../deployments/jobs/1.json
import { readFileSync } from "node:fs";
import { specHash } from "../src/shared/spec.ts";

const file = process.argv[2];
if (!file) {
  console.error("Usage: node scripts/spec-hash.ts <spec.json>");
  process.exit(1);
}
console.log(specHash(JSON.parse(readFileSync(file, "utf8"))));
