# scheduled-exit-fee

The Foundry workspace for job 1 on Robinhood Chain mainnet, [`scheduled-exit-fee-withdrawals`](https://probecli.com/jobs/scheduled-exit-fee-withdrawals): a hook that charges an exit fee scheduled to change from the next block, with a deliberate bug for testing.

- `src/` is the hook under test, `test/ProbeCase.sol` the fixture every case inherits, `seed-cases/` the cases the CLI runs without an AI agent.
- `job.json` is the template used for local runs on a test chain (`npm run dev:stack`), so its network and sponsor say so.
- The spec registered on mainnet, whose hash the contract stores, is [`deployments/jobs/1.json`](../../deployments/jobs/1.json). See [Verify a job's spec](../../README.md#verify-a-jobs-spec).
