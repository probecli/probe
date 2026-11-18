# Security

PROBE holds sponsor budgets in escrow and runs untrusted code, so we take reports seriously.

## Scope

| In scope | Where |
|---|---|
| ProbeJobs escrow | [`contracts/src/ProbeJobs.sol`](contracts/src/ProbeJobs.sol), deployed at `0x75a7af44fe0117b1f5ff11eddad11fe1e0d34189` on Robinhood Chain (4663) |
| Verifier service | [`protocol/src/verifier/`](protocol/src/verifier), running at `verifier.probecli.com` |
| Case sandbox and acceptance rules | [`protocol/src/shared/`](protocol/src/shared) |
| Operator CLI | [`protocol/src/cli/`](protocol/src/cli) |

Hooks under test in [`jobs/`](jobs) belong to their sponsors. Report bugs in them to the sponsor, not here.

Things we want to hear about most:

- any way to move escrowed funds other than `recordAccepted` by an approved verifier, `withdraw` by the operator owed, or `close` by the sponsor after the deadline
- getting paid twice for one execution path, or for a case that does not reproduce
- a case escaping the sandbox: reaching the network, the filesystem outside its workspace, the environment or a shell
- reading a sealed failure trace without the sponsor's key

## Reporting

Send a direct message to [@probecli](https://x.com/probecli) saying you have a security report, and we will reply with a private channel for the details. Do not open a public issue, and do not include exploit details in the first message.

Please include what you found, how to reproduce it, and the impact you expect. Testing against a local stack (`npm run dev:stack`) is always fine. Do not test against mainnet jobs funded by other people.

We aim to acknowledge reports within two days and to tell you what we are doing about them within a week.
