// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {ScheduledExitFeeHook} from "../src/ScheduledExitFeeHook.sol";

/// @notice The job snapshot. Every case inherits this fixture, so all cases
/// start from the same pool state: a v4 PoolManager, two tokens, the hook at
/// a flag-valid address, and one LP position.
abstract contract ProbeCase is Test, Deployers {
    ScheduledExitFeeHook internal hook;
    address internal hookOwner = address(0xB0B);
    uint24 internal constant INITIAL_FEE = 3_000; // 0.30%

    ModifyLiquidityParams internal POSITION =
        ModifyLiquidityParams({tickLower: -120, tickUpper: 120, liquidityDelta: 1_000e18, salt: 0});

    function setUp() public virtual {
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        address flagged = address(
            uint160(Hooks.AFTER_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG) | (uint160(0x4444) << 144)
        );
        deployCodeTo("ScheduledExitFeeHook.sol:ScheduledExitFeeHook", abi.encode(manager, hookOwner, INITIAL_FEE), flagged);
        hook = ScheduledExitFeeHook(flagged);

        (key,) = initPool(currency0, currency1, IHooks(flagged), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity(key, POSITION, ZERO_BYTES);
    }

    // ------------------------------------------------------------ helpers for cases

    function scheduleFee(uint24 fee) internal {
        vm.prank(hookOwner);
        hook.scheduleFee(fee);
    }

    function nextBlock() internal {
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 2);
    }

    /// @return received0 received1 Token amounts the LP received.
    function withdraw(int256 liquidity) internal returns (uint256 received0, uint256 received1) {
        uint256 b0 = MockERC20(Currency.unwrap(currency0)).balanceOf(address(this));
        uint256 b1 = MockERC20(Currency.unwrap(currency1)).balanceOf(address(this));
        modifyLiquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({tickLower: POSITION.tickLower, tickUpper: POSITION.tickUpper, liquidityDelta: -liquidity, salt: 0}),
            ZERO_BYTES
        );
        received0 = MockERC20(Currency.unwrap(currency0)).balanceOf(address(this)) - b0;
        received1 = MockERC20(Currency.unwrap(currency1)).balanceOf(address(this)) - b1;
    }

    function hookBalance0() internal view returns (uint256) {
        return MockERC20(Currency.unwrap(currency0)).balanceOf(address(hook));
    }
}
