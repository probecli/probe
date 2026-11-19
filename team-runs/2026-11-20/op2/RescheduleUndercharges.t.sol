// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProbeCase} from "../ProbeCase.sol";

/// After a 0.92% fee takes effect, scheduling a lower fee makes the hook charge the lower fee in the same block, below the declared 0.92%.
contract RescheduleUndercharges is ProbeCase {
    function test_rescheduleChargesBelowDeclaredFee() public {
        scheduleFee(9_200);
        nextBlock();
        scheduleFee(1_000); // promotes 0.92% to current, schedules 0.10% for the next block
        assertEq(hook.feeForBlock(block.number), 9_200, "declared fee for this block is 0.92%");

        (uint256 received0,) = withdraw(1_000e18);
        uint256 fee0 = hookBalance0();
        uint256 gross0 = received0 + fee0;
        // Finding: the LP is charged the pending 0.10%, not the declared 0.92%.
        assertLt(fee0 * 1_000_000, gross0 * 9_200, "charged below the declared fee");
        assertApproxEqAbs(fee0 * 1_000_000, gross0 * 1_000, 1_000_000, "charged the pending 0.10%");
    }
}
