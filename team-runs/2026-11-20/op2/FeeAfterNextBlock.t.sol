// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ProbeCase} from "../ProbeCase.sol";

/// Schedule a fee spike, move to the next block, then withdraw: the declared and charged fee are both the new 0.92%.
contract FeeAfterNextBlock is ProbeCase {
    function test_nextBlockChargesDeclaredFee() public {
        scheduleFee(9_200);
        nextBlock();
        assertEq(hook.feeForBlock(block.number), 9_200, "declared fee is the new one from the next block");

        (uint256 received0,) = withdraw(1_000e18);
        uint256 fee0 = hookBalance0();
        assertApproxEqAbs(fee0 * 1_000_000, (received0 + fee0) * 9_200, 1_000_000, "charged the declared 0.92%");
    }
}
