// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProbeCase} from "../ProbeCase.sol";

/// Withdraw the full position in the same block a fee spike is scheduled.
/// The declared fee for this block is still 0.30%, so that is what should be charged.
contract SameBlockFullWithdraw is ProbeCase {
    function test_sameBlockWithdrawIsChargedPendingFee() public {
        scheduleFee(9_200); // 0.92%, effective next block
        assertEq(hook.feeForBlock(block.number), INITIAL_FEE, "declared fee for this block");

        (uint256 received0,) = withdraw(1_000e18);
        uint256 fee0 = hookBalance0();
        uint256 gross0 = received0 + fee0;

        // Finding: charged more than the declared fee for this block.
        assertGt(fee0 * 1_000_000, gross0 * INITIAL_FEE, "charged above declared fee");
        assertApproxEqAbs(fee0 * 1_000_000, gross0 * 9_200, 1_000_000, "charged the pending 0.92%");
    }
}
