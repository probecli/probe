<p align="center">
  <a href="https://probecli.com"><img src=".github/assets/banner.svg" alt="PROBE: test hooks, get paid for verified work" width="100%"></a>
</p>

<p align="center">
  <a href="https://verifier.probecli.com"><img src="https://img.shields.io/website?url=https%3A%2F%2Fverifier.probecli.com%2Fhealth&style=flat-square&label=verifier&up_message=live&up_color=e83f28&down_message=down&labelColor=141413" alt="Verifier status"></a>
  <a href="https://robinhoodchain.blockscout.com/address/0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189"><img src="https://img.shields.io/badge/ProbeJobs-0x75a7…4189-e83f28?style=flat-square&labelColor=141413" alt="ProbeJobs contract"></a>
  <a href="https://github.com/probecli/probe/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/probecli/probe/ci.yml?branch=main&style=flat-square&label=tests&labelColor=141413" alt="Tests"></a>
  <a href="https://github.com/probecli/probe/actions/workflows/bytecode.yml"><img src="https://img.shields.io/github/actions/workflow/status/probecli/probe/bytecode.yml?branch=main&style=flat-square&label=deployed%20bytecode&labelColor=141413" alt="Deployed bytecode matches source"></a>
  <a href="https://repo.sourcify.dev/4663/0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189"><img src="https://img.shields.io/badge/sourcify-exact_match-2B50AA?style=flat-square&labelColor=141413" alt="Verified on Sourcify, exact match"></a>
  <a href="https://www.npmjs.com/package/@probecli/cli"><img src="https://img.shields.io/npm/v/%40probecli%2Fcli?style=flat-square&label=npm&color=e83f28&labelColor=141413" alt="@probecli/cli on npm"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-141413?style=flat-square" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/solidity-0.8.26-141413?style=flat-square&logo=solidity" alt="Solidity 0.8.26">
  <img src="https://img.shields.io/badge/node-22.18%2B-141413?style=flat-square&logo=nodedotjs" alt="Node 22.18+">
  <a href="https://probecli.com"><img src="https://img.shields.io/badge/probecli.com-141413?style=flat-square" alt="Website"></a>
  <a href="https://x.com/probecli"><img src="https://img.shields.io/badge/@probecli-141413?style=flat-square&logo=x" alt="@probecli on X"></a>
</p>

<br>

**PROBE runs reproducible tests for Uniswap v4 hooks.** A hook team funds a job on-chain. Operators run the `probe` CLI, where an AI agent proposes test cases against a pinned chain snapshot. A deterministic verifier replays every case twice, and the contract pays once for each new execution path it reproduces.

This repository is everything that touches money or decides what gets paid: the escrow contract, the verifier, the operator CLI and the job specs. The website at [probecli.com](https://probecli.com) is a separate frontend that only reads from these.

<br>

<img src=".github/assets/flow.svg" alt="How a job flows: the sponsor funds it, the operator runs the CLI, the verifier reproduces each case, the contract pays once per new path" width="100%">

## Quickstart

Needs Node 22.18 or later, and [Foundry](https://getfoundry.sh) and git to run jobs.

```shell
npm install -g @probecli/cli
probe init                  # creates your operator key; rewards are paid to its address
probe doctor                # checks Node, Foundry, the verifier, the chain and your key
probe jobs                  # funded jobs on the live verifier
probe job <job>             # scope, acceptance rules, budget and results so far
probe work <job> --dry-run  # build the snapshot and run cases locally, submit nothing
probe work <job>            # run the job, submit the cases that pass
probe balance <job>
probe withdraw <job>
```

The first run downloads the job's workspace from this repository into `~/.probe`, and Foundry fetches the Solidity compiler the job pins (solc 0.8.26). To work on the CLI itself, clone the repository and run `npm install && npm link` in `protocol/`; the linked `probe` then runs the TypeScript sources directly. With `ANTHROPIC_API_KEY` set, the agent writes new cases for you; without it, `probe work` runs the job's seed cases, which are usually paid already, so write your own.

### Write your own case

```shell
probe case new <job> FeeAfterNextBlock          # scaffold, with the fixture's helpers listed
probe case check <job> FeeAfterNextBlock.t.sol  # rule check and local run; exits 1 if it would be rejected
probe work <job> --case FeeAfterNextBlock.t.sol # submit it
probe submissions                               # your verdicts across jobs
```

A case is one Foundry test contract that inherits the job's fixture, asserts a concrete outcome and reads nothing outside the snapshot: no wall clock, randomness, network, files or environment. `probe case new` writes a file that already meets those rules and fails on purpose until you write the scenario.

### Check a deployed hook

```shell
probe check 0x0af57f62982d03066ef917acad87f771c06528ec            # nine checks at the latest block
probe check 0x0af57f62982d03066ef917acad87f771c06528ec --publish  # the verifier reruns and signs it
```

No Foundry or key needed: it reads the chain at one block and checks that the address flags are valid, every enabled callback exists, the hook is bound to the real PoolManager, its callbacks revert for any other caller, and whether it is upgradeable, owned by a single key, uses SELFDESTRUCT or DELEGATECALL, or lacks verified source. Published results are at [probecli.com/hooks](https://probecli.com/hooks), each with the verifier's signature, a rerun command and a README badge. A pass is evidence about one property at one block, not an audit.

`probe help` lists every command. `probe jobs`, `probe job`, `probe submissions` and `probe check` take `--json`.

<img src=".github/assets/terminal.svg" alt="A probe work session: three cases pass locally; the verifier accepts one, marks one a duplicate and fails one for reading wall-clock time" width="100%">

<sub>Output from a real CLI run on a local test chain with a test token (<code>npm run dev:stack</code>). Mainnet jobs pay in whatever the sponsor funded.</sub>

## How it fits together

<img src=".github/assets/arch.svg" alt="Architecture: the CLI on the operator machine sends signed cases to the verifier service, which settles accepted cases on the ProbeJobs contract" width="100%">

| Path | What it does |
|---|---|
| [`contracts/src/ProbeJobs.sol`](contracts/src/ProbeJobs.sol) | Escrow. Pulls the full budget at creation, pays each path fingerprint once, refunds the rest after the deadline. |
| [`protocol/src/verifier/`](protocol/src/verifier) | HTTP service. Replays each case twice on the pinned snapshot, fingerprints its path, seals the trace to the sponsor, settles on-chain. |
| [`protocol/src/cli/`](protocol/src/cli) | The `probe` CLI for operators and sponsors. |
| [`protocol/src/shared/`](protocol/src/shared) | Job spec, acceptance rules, signed messages and chain client, used by both. |
| [`jobs/`](jobs) | Job specs: the hook, its fixture and seed cases. |
| [`deploy/`](deploy) | Docker Compose and Caddy config the public verifier runs with. |

### What gets paid

| Verdict | Meaning | Paid |
|---|---|---|
| ✓ Accepted | Reproduces twice on the snapshot, follows every rule, takes a path nobody was paid for | Yes, once |
| = Duplicate | Reproduces, but takes the same path as an accepted case | No |
| × Failed | Doesn't compile, doesn't reproduce, or breaks a rule (wall clock, network, file access) | No |

### Who can call what

| Role | Functions |
|---|---|
| Sponsor | `createJob`, `fund`, `close` (after the deadline, refunds what is left) |
| Verifier | `recordAccepted` (approved addresses only; reverts on a paid path, a closed job or an empty budget) |
| Operator | `withdraw` (everything owed, even after the job closes) |
| Owner | `setVerifier`, two-step `transferOwnership`. No power over job budgets. |

## Live deployment

| | |
|---|---|
| Network | Robinhood Chain mainnet, chain id `4663` |
| ProbeJobs | [`0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189`](https://robinhoodchain.blockscout.com/address/0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189) |
| Verifier | [`verifier.probecli.com`](https://verifier.probecli.com) · `0xd3c30efc0b0867963193c1d2dfd9fe31a442d746` |
| Owner | `0xfdbf67fbf0d089212189d9b35546962100a0b764` |
| Source | [Verified on Sourcify](https://repo.sourcify.dev/4663/0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189), exact match |
| Job 1 | Funded with 0.002 ETH by the PROBE team ([tx](https://robinhoodchain.blockscout.com/tx/0xeb8b6baaeca17c008e19fbaf96dfa528b1a0b2157381a6b83c20c20da33a38f1)). First accepted case paid 0.0002 ETH ([tx](https://robinhoodchain.blockscout.com/tx/0x1bd71402396b9c4ddb6e01a023c4f8b0ca9da0c4864a60551e65f951371c08f0)) and withdrawn ([tx](https://robinhoodchain.blockscout.com/tx/0x3cff2fe1ddcdfb6541faf89cdd9d23b72dd995ca29593926c9d7ad1626d3f5b2)). 7 cases accepted so far, all by team operators listed in [`team-runs/`](team-runs) |
| Job 2 | Funded with 0.01 ETH by the PROBE team ([tx](https://robinhoodchain.blockscout.com/tx/0x9d1d5f9245237bef9cf927997720c87a5f9be93206793e1d6e989fa1a890f05d)) as an open bounty: 0.002 ETH per accepted case. Workspace: [`probecli/job-volume-discount`](https://github.com/probecli/job-volume-discount) |

Deployment, approval and first-job transactions: [`deployments/robinhood-chain.json`](deployments/robinhood-chain.json). The first job was funded by the PROBE team from the owner wallet to run the full loop on mainnet; see it at [probecli.com/jobs/scheduled-exit-fee-withdrawals](https://probecli.com/jobs/scheduled-exit-fee-withdrawals). Every operator address the team has used is in [`team-runs/`](team-runs).

### Verify a job's spec

The contract stores a hash of each job's spec, so the rules operators work under cannot change after funding. The specs registered for each job are in [`deployments/jobs/`](deployments/jobs), named by job id. Hash one and compare with the chain:

```shell
cd protocol && node scripts/spec-hash.ts ../deployments/jobs/1.json
cast call 0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189 "getJob(uint256)((address,address,address,address,uint256,uint256,uint256,uint256,uint64,uint32,uint8,bytes32,bytes32))" 1 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com   # the second-to-last field is the spec hash
```

For job 1 both print `0x7fe8f1c8bd687ab1a99e5a7c7c4dafdc9dca8a669492b8bb9cde1fe60090ddf3`; for job 2 (`jobs/2.json` and `getJob(uint256)… 2`), `0xcdead47cb3ad4888d4ef30f8981766018ba62e64de142591d758435ef438a326`. [`jobs/scheduled-exit-fee/job.json`](jobs/scheduled-exit-fee/job.json) is the same job's template for local runs on a test chain, so its network and sponsor differ.

### Verify the deployed contract

The bytecode on mainnet is built from [`contracts/`](contracts) with solc 0.8.26, optimizer at 200 runs, EVM cancun:

```shell
scripts/verify-bytecode.sh
# mainnet: 0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189 matches contracts/ (5929 bytes)
# testnet: 0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189 matches contracts/ (5929 bytes)
```

The script needs Foundry and `jq`. The [bytecode workflow](.github/workflows/bytecode.yml) runs the same check every day, so the badge above reflects what is on-chain today.

## Develop

```shell
cd contracts && forge test           # contract tests
cd protocol && npm test              # unit tests
cd protocol && npm run e2e           # full loop on a local chain: fund, run, verify, pay, withdraw
cd protocol && npm run dev:stack     # local chain + contract + verifier + a funded demo job
```

## Security

Cases are untrusted code. The verifier runs them as an unprivileged user with no shell, file or network access and none of the operator's environment. Failure traces can be working exploits, so they are encrypted to the sponsor's key and never published. See [SECURITY.md](SECURITY.md) for scope and how to report a vulnerability privately.

## License

[MIT](LICENSE)

<br>

<p align="center"><sub><a href="https://probecli.com">probecli.com</a> · <a href="https://probecli.com/docs">Docs</a> · <a href="https://probecli.com/operators">Earn as an operator</a> · <a href="https://probecli.com/teams">Fund a job</a></sub></p>
