// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProbeCase} from "../ProbeCase.sol";

/// The owner tries to schedule a 6% fee, above the 5% cap: the call reverts and a withdrawal still pays the initial 0.30%.
contract FeeAboveCapRejected is ProbeCase {
    function test_feeAboveCapIsRejected() public {
        vm.prank(hookOwner);
        vm.expectRevert(bytes4(keccak256("FeeTooHigh()")));
        hook.scheduleFee(60_000);

        assertEq(hook.feeForBlock(block.number + 1), INITIAL_FEE, "no fee change was scheduled");
        (uint256 received0,) = withdraw(1_000e18);
        uint256 fee0 = hookBalance0();
        assertApproxEqAbs(fee0 * 1_000_000, (received0 + fee0) * INITIAL_FEE, 1_000_000, "charged the initial 0.30%");
    }
}
