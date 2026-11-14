// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProbeCase} from "../ProbeCase.sol";

/// Withdraw everything, then check the fee window using the machine clock.
contract ZeroLiquidityTickWithdraw is ProbeCase {
    function test_feeWindowByClock() public {
        scheduleFee(9_200);
        uint256 started = vm.unixTime(); // wall-clock time: not reproducible
        nextBlock();
        withdraw(1_000e18);
        assertGt(vm.unixTime(), started - 1, "clock moved");
        assertGt(hookBalance0(), 0, "fee charged");
    }
}
