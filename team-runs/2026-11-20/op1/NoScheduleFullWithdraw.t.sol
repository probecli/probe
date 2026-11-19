// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProbeCase} from "../ProbeCase.sol";

/// Withdraw the full position when no fee change was ever scheduled: the LP pays exactly the initial 0.30%.
contract NoScheduleFullWithdraw is ProbeCase {
    function test_noScheduleChargesInitialFee() public {
        (uint256 received0, uint256 received1) = withdraw(1_000e18);
        uint256 fee0 = hookBalance0();
        uint256 gross0 = received0 + fee0;
        assertGt(fee0, 0, "an exit fee was charged");
        assertGt(received1, 0, "both tokens returned");
        assertApproxEqAbs(fee0 * 1_000_000, gross0 * INITIAL_FEE, 1_000_000, "charged the initial 0.30%");
    }
}
