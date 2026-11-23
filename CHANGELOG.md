# Changelog

Changes to the `probe` CLI and the verifier. The ProbeJobs contract is deployed once and does not change; its address is in [deployments/robinhood-chain.json](deployments/robinhood-chain.json).

## 0.5.0 (2026-11-23)

Check PROBE's claims from your terminal instead of trusting the website.

### Added

- `probe verify job <job>` recomputes a job's spec hash from the spec the verifier serves and compares it with the hash the ProbeJobs contract stored at funding, so you can confirm the scope and rules have not changed. Exits 1 on a mismatch.
- `probe verify hook <address>` rebuilds the signed message from a published hook check's results, recovers the signer from the signature, and reads `approvedVerifier(signer)` on ProbeJobs. Exits 1 if any of the three does not hold.
- `probe hooks` lists hooks with a published, signed check. `--json` on both.

### Changed

- The hook report page shows the `probe verify hook` command beside the rerun command.
- Troubleshooting and the npm README explain the EACCES error from `npm install -g` and how to install without sudo.

## 0.4.0 (2026-11-19)

The CLI is on npm: `npm install -g @probecli/cli`.

### Added

- Published as [`@probecli/cli`](https://www.npmjs.com/package/@probecli/cli), which installs the `probe` command. The package ships a bundled JavaScript build, so it runs from `node_modules` like any other CLI.
- Jobs whose workspace is a path in this repository now run from an npm install: the CLI keeps a shallow checkout of the public repository in `~/.probe/repo` and refreshes it on each run.
- CI packs the CLI, installs the tarball globally and runs it on every push.

## 0.3.0 (2026-11-19)

Hook checks: a free, signed safety check for any deployed Uniswap v4 hook on Robinhood Chain.

### Added

- `probe check <hook>` runs nine checks against the chain at one block: contract code (followed through proxies), valid permission flags, every enabled callback implemented, `poolManager()` returning the canonical PoolManager, callbacks reverting for any caller other than the PoolManager (live `eth_call` with a real pool's key), upgradeability, single-key ownership, SELFDESTRUCT and DELEGATECALL in the code, and a Sourcify source match. `--block`, `--rpc` and `--json` are supported; it exits 1 when a check fails.
- `probe check <hook> --publish` asks the verifier to rerun the checks at the same block and sign the result, and tells you whether its run matched yours.
- Verifier: `POST /checks`, `GET /hooks`, `GET /hooks/<address>` (report, signed EIP-191 message and signature) and `GET /hooks/<address>/badge.svg`.

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
