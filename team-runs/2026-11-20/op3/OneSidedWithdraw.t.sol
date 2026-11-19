// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProbeCase} from "../ProbeCase.sol";

/// Push the price below the position's range, then withdraw: the position is all token0, so the fee is taken in token0 only.
contract OneSidedWithdraw is ProbeCase {
    function test_outOfRangeWithdrawChargesOneToken() public {
        swap(key, true, -50e18, ZERO_BYTES);
        (uint256 received0, uint256 received1) = withdraw(1_000e18);
        assertEq(received1, 0, "position held no token1");
        uint256 fee0 = hookBalance0();
        assertGt(fee0, 0, "fee taken in token0");
        assertApproxEqAbs(fee0 * 1_000_000, (received0 + fee0) * INITIAL_FEE, 1_000_000, "charged 0.30% on token0");
    }
}
