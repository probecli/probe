# Changelog

Changes to the `probe` CLI and the verifier. The ProbeJobs contract is deployed once and does not change; its address is in [deployments/robinhood-chain.json](deployments/robinhood-chain.json).

## 0.2.0 (2026-11-19)

Operators can now work a job without an AI key, by writing cases themselves.

### Added

- `probe case new <job> <Name>` writes a case that already meets the job's structural rules, with the fixture's helper functions and their docs listed in it.
- `probe case check <job> <file...>` runs the rule check and a local run on your case files, says which test failed and why, and exits 1 when a case would be rejected, so it can gate CI.
- `probe work <job> --case <file>` runs and submits your files instead of the agent's or the seed cases.
- `probe job <job>` prints a job's brief: chain and contract with explorer links, snapshot, reward, budget left, deadline, eligibility, scope, acceptance rules, and verdicts so far with each payout's transaction.
- `probe doctor` checks Node, Foundry, git, the verifier, the chain RPC, the operator key and its gas, and agent credentials, with the fix for each problem. Exits 1 when `probe work` could not run.
- `probe submissions [job]` lists your submissions across jobs, newest first. `--all` shows every operator's.
- `--json` on `probe jobs`, `probe job` and `probe submissions`.
- `probe --version`.

### Fixed

- `probe work` failed on a machine that had never compiled with the job's pinned solc, because it built with `--offline`. It now downloads the compiler once when it is missing.
- Without Foundry, `probe work` said "the job workspace does not compile". It now says Foundry is missing and how to install it.
- A failed build or local run shows forge's error, not a generic message.

## 0.1.0 (2026-11-17)

First release, used for the first paid job on Robinhood Chain mainnet.

- ProbeJobs escrow contract: funding in ETH or ERC-20, one payment per execution path, optional holding requirement, refunds after the deadline.
- Verifier: replays each case twice on the pinned snapshot, fingerprints its path through the hook, settles accepted results on-chain and seals failure traces to the sponsor's key.
- CLI: `init`, `whoami`, `jobs`, `work`, `status`, `balance`, `withdraw`, and `sponsor keygen | create | reports`.
