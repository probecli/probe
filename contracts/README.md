# ProbeJobs

The escrow contract behind PROBE jobs, deployed on Robinhood Chain mainnet at `0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189`.

- `createJob` pulls the full budget in one transaction, so a job opens funded or not at all.
- `recordAccepted` can be called only by an approved verifier. It pays each execution-path fingerprint once and reverts on a paid fingerprint, an ineligible operator, a closed job or an empty budget.
- `withdraw` sends an operator everything they are owed in a token, even after the job closes.
- `close` refunds the unallocated budget to the sponsor after the deadline.
- The owner can only approve or revoke verifiers and transfer ownership in two steps. Nobody can move a job's budget any other way.

```shell
forge build
forge test
```

Built with solc 0.8.26, optimizer on at 200 runs, EVM version cancun (see `foundry.toml`).
