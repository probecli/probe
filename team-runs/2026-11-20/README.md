# Team run, 20 November 2026

Three operators run by the PROBE team worked job #1, [`scheduled-exit-fee-withdrawals`](https://probecli.com/jobs/scheduled-exit-fee-withdrawals), on Robinhood Chain mainnet. The point was to exercise the full path with more than one operator: the CLI installed from npm (`@probecli/cli@0.4.0`), cases written with `probe case new` and checked with `probe case check`, verification, and settlement by the ProbeJobs contract. The budget was funded by the team, so these payouts move team money between team addresses.

Each case takes a different execution path through the hook. Two of them record behaviour of the hook's deliberate bug.

| Operator | Case | Path | Verdict | Settlement |
|---|---|---|---|---|
| 1 | [NoScheduleFullWithdraw](op1/NoScheduleFullWithdraw.t.sol) | No fee ever scheduled; the initial 0.30% is charged | accepted | [`0x8aca…aa83`](https://robinhoodchain.blockscout.com/tx/0x8aca4b4a1f0dea4fa8af7e5de8e66d3499ae5eaa2d7d113946772dee3194aa83) |
| 1 | [DustWithdrawNoFee](op1/DustWithdrawNoFee.t.sol) | Fee rounds to zero on both tokens | accepted | [`0x087e…6f50`](https://robinhoodchain.blockscout.com/tx/0x087e017ae818647e9e30efc4913d4b0ceaa50a15a00c938eda972ba916646f50) |
| 2 | [FeeAfterNextBlock](op2/FeeAfterNextBlock.t.sol) | A scheduled fee takes effect next block, charged as declared | accepted | [`0xa1a6…6438`](https://robinhoodchain.blockscout.com/tx/0xa1a6fa19b5562cfd249efdc5092d9316d7ebac635a2a8a80fc2ee2a8a1236438) |
| 2 | [RescheduleUndercharges](op2/RescheduleUndercharges.t.sol) | Rescheduling promotes the old fee; the LP is charged 0.10% while 0.92% is declared | accepted | [`0x31fc…6979`](https://robinhoodchain.blockscout.com/tx/0x31fc9bdbf8eefb59d4d5c05fc448c0860f965ece098f72059c3ec2aff0756979) |
| 3 | [OneSidedWithdraw](op3/OneSidedWithdraw.t.sol) | Out-of-range position; the fee is taken in token0 only | accepted | [`0xd049…ad84`](https://robinhoodchain.blockscout.com/tx/0xd049d3c476ff9f5f402b6cab21549d1317249de1b83e7814c57f1f8af31aad84) |
| 3 | [FeeAboveCapRejected](op3/FeeAboveCapRejected.t.sol) | A 6% fee is rejected by the 5% cap | accepted | [`0xeda8…c676`](https://robinhoodchain.blockscout.com/tx/0xeda8612cfce502b4ab545b638e10e775d8fda3e1ac9b1a1cab651a197835c676) |

Reproduce any case at the same snapshot:

```shell
npm install -g @probecli/cli
probe case check scheduled-exit-fee-withdrawals team-runs/2026-11-20/op2/RescheduleUndercharges.t.sol
```
