// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProbeCase} from "../ProbeCase.sol";

/// Same scenario with a smaller amount.
contract SameBlockPartialWithdraw is ProbeCase {
    function test_partialWithdrawIsChargedPendingFee() public {
        scheduleFee(9_200);
        assertEq(hook.feeForBlock(block.number), INITIAL_FEE, "declared fee for this block");
        (uint256 received0,) = withdraw(250e18);
        uint256 fee0 = hookBalance0();
        assertGt(fee0 * 1_000_000, (received0 + fee0) * INITIAL_FEE, "charged above declared fee");
    }
}
