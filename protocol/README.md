# probe

The command-line tool for [PROBE](https://probecli.com): reproducible tests for Uniswap v4 hooks on Robinhood Chain.

- **Check any deployed hook** with nine safety checks at one block. Free, no key needed.
- **Run funded testing jobs.** Write or generate Foundry test cases against a pinned snapshot. The verifier reproduces each one, and the ProbeJobs contract pays once for each new execution path.

```shell
npm install -g @probecli/cli
```

Needs Node 22.18 or later. Running jobs also needs [Foundry](https://getfoundry.sh) and git. Checking hooks needs neither.

## Check a hook

```shell
probe check 0x0af57f62982d03066ef917acad87f771c06528ec
probe check 0x0af57f62982d03066ef917acad87f771c06528ec --publish
```

It reads the chain at one block and checks that:

- the address flags are valid;
- every enabled callback exists;
- the hook is bound to the real PoolManager;
- its callbacks revert for any other caller.

It also reports whether the hook is upgradeable, owned by a single key, uses SELFDESTRUCT or DELEGATECALL, or lacks verified source.

`--publish` has the verifier rerun the check at the same block and sign it. The result then appears at [probecli.com/hooks](https://probecli.com/hooks) with a badge you can put in a README. A pass is evidence about one property at one block, not an audit.

Anyone can check a published result without trusting the website:

```shell
probe hooks                                                     # hooks with a published check
probe verify hook 0x0af57f62982d03066ef917acad87f771c06528ec    # signature, signer, and signer approved on-chain
probe verify hook 0x0af57f62982d03066ef917acad87f771c06528ec --rerun --rpc <archive-rpc>   # also rerun the checks at that block
```

The public RPC keeps recent state only, so `--rerun` on an older check needs an archive RPC.

## Run a job

```shell
probe init                  # creates your operator key; rewards are paid to its address
probe doctor                # checks Node, Foundry, git, the verifier, the chain and your key
probe jobs                  # funded jobs
probe job <job>             # scope, rules, budget and results so far
probe work <job> --dry-run  # run cases locally, submit nothing
probe work <job>            # submit the cases that pass
probe withdraw <job>        # withdraw what you earned
```

On first use, the CLI downloads the job's workspace from the public repository into `~/.probe`. Foundry also fetches the Solidity compiler the job pins.

With `ANTHROPIC_API_KEY` set, an agent proposes new cases. Without it, write your own:

```shell
probe case new <job> FeeAfterNextBlock
probe case check <job> FeeAfterNextBlock.t.sol
probe work <job> --case FeeAfterNextBlock.t.sol
```

Before you work a job, confirm its scope and rules are the ones fixed at funding:

```shell
probe verify job volume-discount-fee-swaps   # recomputes the spec hash and compares it with getJob(id)
```

`probe help` lists every command.

If `npm install -g` fails with EACCES, your Node lives in a folder your user cannot write. Set `npm config set prefix ~/.npm-global`, add `~/.npm-global/bin` to your PATH, and install again, or run `npx @probecli/cli` without installing.

## Links

- Website and docs: [probecli.com](https://probecli.com)
- Source, contract and verifier: [github.com/probecli/probe](https://github.com/probecli/probe)
- Changelog: [CHANGELOG.md](https://github.com/probecli/probe/blob/main/CHANGELOG.md)
- Updates: [@probecli](https://x.com/probecli)

MIT licensed.
