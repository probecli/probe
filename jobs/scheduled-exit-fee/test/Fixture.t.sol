// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProbeCase} from "./ProbeCase.sol";

/// Sanity checks that the snapshot is what the job spec says.
contract FixtureTest is ProbeCase {
    function test_snapshotIsPinned() public view {
        assertEq(block.number, 4812330);
        assertEq(hook.currentFee(), INITIAL_FEE);
        assertEq(hook.pendingFee(), 0);
    }

    function test_withdrawChargesDeclaredFee() public {
        (uint256 r0,) = withdraw(100e18);
        uint256 fee0 = hookBalance0();
        // fee = 0.30% of the gross amount
        assertApproxEqAbs(fee0 * 1_000_000, (r0 + fee0) * INITIAL_FEE, 1_000_000);
    }
}
