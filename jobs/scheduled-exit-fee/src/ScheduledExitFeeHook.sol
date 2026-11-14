// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {ModifyLiquidityParams} from "v4-core/src/types/PoolOperation.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {BalanceDelta, toBalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {BaseTestHooks} from "v4-core/src/test/BaseTestHooks.sol";

/// @notice Demo target for the PROBE demo job. NOT FOR PRODUCTION.
///
/// Charges an exit fee on liquidity withdrawals. Fee changes are scheduled
/// and only take effect from the next block, so LPs always know the fee for
/// the block they withdraw in. `feeForBlock` is the declared fee.
///
/// It contains a deliberate bug for the demo: `_exitFee` uses a scheduled
/// fee as soon as it is set, instead of waiting for `effectiveFrom`.
contract ScheduledExitFeeHook is BaseTestHooks {
    IPoolManager public immutable manager;
    address public immutable owner;

    uint24 public constant MAX_FEE = 50_000; // 5%, in hundredths of a bip
    uint24 public constant FEE_DENOMINATOR = 1_000_000;

    uint24 public currentFee;
    uint24 public pendingFee;
    uint64 public effectiveFrom;

    event FeeScheduled(uint24 fee, uint64 effectiveFrom);

    error NotOwner();
    error FeeTooHigh();
    error NotManager();

    constructor(IPoolManager _manager, address _owner, uint24 initialFee) {
        manager = _manager;
        owner = _owner;
        currentFee = initialFee;
    }

    /// @notice Schedule a new exit fee. It applies from the next block.
    function scheduleFee(uint24 fee) external {
        if (msg.sender != owner) revert NotOwner();
        if (fee > MAX_FEE) revert FeeTooHigh();
        // Promote an already-effective pending fee before overwriting it.
        if (pendingFee != 0 && block.number >= effectiveFrom) currentFee = pendingFee;
        pendingFee = fee;
        effectiveFrom = uint64(block.number + 1);
        emit FeeScheduled(fee, effectiveFrom);
    }

    /// @notice The declared exit fee for a given block.
    function feeForBlock(uint256 blockNumber) public view returns (uint24) {
        if (pendingFee != 0 && blockNumber >= effectiveFrom) return pendingFee;
        return currentFee;
    }

    function _exitFee() internal view returns (uint24) {
        // BUG (deliberate): ignores effectiveFrom.
        if (pendingFee != 0) return pendingFee;
        return currentFee;
    }

    function afterRemoveLiquidity(
        address,
        PoolKey calldata key,
        ModifyLiquidityParams calldata,
        BalanceDelta delta,
        BalanceDelta,
        bytes calldata
    ) external override returns (bytes4, BalanceDelta) {
        if (msg.sender != address(manager)) revert NotManager();
        uint24 fee = _exitFee();
        if (fee == 0) return (IHooks.afterRemoveLiquidity.selector, toBalanceDelta(0, 0));

        uint128 fee0 = uint128(delta.amount0()) * fee / FEE_DENOMINATOR;
        uint128 fee1 = uint128(delta.amount1()) * fee / FEE_DENOMINATOR;
        if (fee0 > 0) manager.take(key.currency0, address(this), fee0);
        if (fee1 > 0) manager.take(key.currency1, address(this), fee1);
        return (IHooks.afterRemoveLiquidity.selector, toBalanceDelta(int128(fee0), int128(fee1)));
    }

    function hookFlags() external pure returns (uint160) {
        return uint160(Hooks.AFTER_REMOVE_LIQUIDITY_FLAG | Hooks.AFTER_REMOVE_LIQUIDITY_RETURNS_DELTA_FLAG);
    }
}
