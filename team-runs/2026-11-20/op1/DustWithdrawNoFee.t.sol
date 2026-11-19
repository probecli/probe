// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProbeCase} from "../ProbeCase.sol";

/// Withdraw a dust amount of liquidity: the fee rounds down to zero on both tokens and the hook takes nothing.
contract DustWithdrawNoFee is ProbeCase {
    function test_dustWithdrawTakesNoFee() public {
        uint256 before0 = hookBalance0();
        withdraw(1_000);
        assertEq(hookBalance0(), before0, "hook took no token0 on a dust withdrawal");
    }
}
