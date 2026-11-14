// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ProbeJobs} from "../src/ProbeJobs.sol";

contract MockToken is ERC20 {
    constructor() ERC20("Mock", "MOCK") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 10;
            super._update(from, address(0xdead), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

contract RejectingReceiver {
    receive() external payable {
        revert("no");
    }
}

contract ProbeJobsTest is Test {
    ProbeJobs jobs;
    MockToken usdc;
    MockToken probeToken;

    address owner = makeAddr("owner");
    address sponsor = makeAddr("sponsor");
    address verifier = makeAddr("verifier");
    address operator = makeAddr("operator");
    address other = makeAddr("other");

    uint256 constant REWARD = 100e6;
    uint256 constant BUDGET = 1_000e6;

    function setUp() public {
        jobs = new ProbeJobs(owner);
        usdc = new MockToken();
        probeToken = new MockToken();
        vm.prank(owner);
        jobs.setVerifier(verifier, true);
        usdc.mint(sponsor, 10_000e6);
        vm.prank(sponsor);
        usdc.approve(address(jobs), type(uint256).max);
        vm.deal(sponsor, 100 ether);
    }

    function _params(address rewardToken, uint256 reward, uint256 budget) internal view returns (ProbeJobs.CreateParams memory p) {
        p = ProbeJobs.CreateParams({
            verifier: verifier,
            rewardToken: rewardToken,
            eligibilityToken: address(0),
            minHolding: 0,
            rewardPerAccepted: reward,
            budget: budget,
            deadline: uint64(block.timestamp + 7 days),
            specHash: keccak256("spec"),
            reportKey: bytes32(uint256(1))
        });
    }

    function _createUsdcJob() internal returns (uint256 id) {
        vm.prank(sponsor);
        id = jobs.createJob(_params(address(usdc), REWARD, BUDGET));
    }

    // ------------------------------------------------------------ creation

    function test_createJob_pullsBudgetAndOpens() public {
        uint256 id = _createUsdcJob();
        ProbeJobs.Job memory j = jobs.getJob(id);
        assertEq(uint8(j.status), uint8(ProbeJobs.Status.Open));
        assertEq(j.budget, BUDGET);
        assertEq(j.funded, BUDGET);
        assertEq(j.sponsor, sponsor);
        assertEq(usdc.balanceOf(address(jobs)), BUDGET);
    }

    function test_createJob_native() public {
        vm.prank(sponsor);
        uint256 id = jobs.createJob{value: 1 ether}(_params(address(0), 0.1 ether, 1 ether));
        assertEq(jobs.getJob(id).budget, 1 ether);
        assertEq(address(jobs).balance, 1 ether);
    }

    function test_createJob_revertsOnWrongNativeValue() public {
        vm.prank(sponsor);
        vm.expectRevert(ProbeJobs.WrongValue.selector);
        jobs.createJob{value: 0.5 ether}(_params(address(0), 0.1 ether, 1 ether));
    }

    function test_createJob_revertsWithValueForErc20() public {
        vm.prank(sponsor);
        vm.expectRevert(ProbeJobs.WrongValue.selector);
        jobs.createJob{value: 1}(_params(address(usdc), REWARD, BUDGET));
    }

    function test_createJob_revertsForUnapprovedVerifier() public {
        ProbeJobs.CreateParams memory p = _params(address(usdc), REWARD, BUDGET);
        p.verifier = other;
        vm.prank(sponsor);
        vm.expectRevert(ProbeJobs.VerifierNotApproved.selector);
        jobs.createJob(p);
    }

    function test_createJob_revertsWhenBudgetBelowReward() public {
        vm.prank(sponsor);
        vm.expectRevert(ProbeJobs.InvalidParams.selector);
        jobs.createJob(_params(address(usdc), REWARD, REWARD - 1));
    }

    function test_createJob_revertsForPastDeadline() public {
        ProbeJobs.CreateParams memory p = _params(address(usdc), REWARD, BUDGET);
        p.deadline = uint64(block.timestamp);
        vm.prank(sponsor);
        vm.expectRevert(ProbeJobs.InvalidParams.selector);
        jobs.createJob(p);
    }

    function test_feeOnTransfer_budgetIsAmountReceived() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        fee.mint(sponsor, 1_000e18);
        vm.startPrank(sponsor);
        fee.approve(address(jobs), type(uint256).max);
        uint256 id = jobs.createJob(_params(address(fee), 10e18, 100e18));
        vm.stopPrank();
        assertEq(jobs.getJob(id).budget, 90e18);
        assertEq(fee.balanceOf(address(jobs)), 90e18);
    }

    // ------------------------------------------------------------ settlement

    function test_recordAccepted_creditsOperator() public {
        uint256 id = _createUsdcJob();
        vm.prank(verifier);
        jobs.recordAccepted(id, operator, keccak256("fp1"), keccak256("r1"));
        assertEq(jobs.owed(address(usdc), operator), REWARD);
        assertEq(jobs.getJob(id).budget, BUDGET - REWARD);
        assertEq(jobs.getJob(id).accepted, 1);
        assertTrue(jobs.fingerprintPaid(id, keccak256("fp1")));
    }

    function test_recordAccepted_duplicateFingerprintReverts() public {
        uint256 id = _createUsdcJob();
        vm.startPrank(verifier);
        jobs.recordAccepted(id, operator, keccak256("fp1"), keccak256("r1"));
        vm.expectRevert(ProbeJobs.DuplicateFingerprint.selector);
        jobs.recordAccepted(id, other, keccak256("fp1"), keccak256("r2"));
        vm.stopPrank();
    }

    function test_recordAccepted_onlyJobVerifier() public {
        uint256 id = _createUsdcJob();
        vm.prank(other);
        vm.expectRevert(ProbeJobs.NotVerifier.selector);
        jobs.recordAccepted(id, operator, keccak256("fp1"), keccak256("r1"));
    }

    function test_recordAccepted_revokedVerifierCannotSettle() public {
        uint256 id = _createUsdcJob();
        vm.prank(owner);
        jobs.setVerifier(verifier, false);
        vm.prank(verifier);
        vm.expectRevert(ProbeJobs.VerifierNotApproved.selector);
        jobs.recordAccepted(id, operator, keccak256("fp1"), keccak256("r1"));
    }

    function test_recordAccepted_afterDeadlineReverts() public {
        uint256 id = _createUsdcJob();
        vm.warp(block.timestamp + 8 days);
        vm.prank(verifier);
        vm.expectRevert(ProbeJobs.DeadlinePassed.selector);
        jobs.recordAccepted(id, operator, keccak256("fp1"), keccak256("r1"));
    }

    function test_recordAccepted_enforcesHolding() public {
        ProbeJobs.CreateParams memory p = _params(address(usdc), REWARD, BUDGET);
        p.eligibilityToken = address(probeToken);
        p.minHolding = 1_000e18;
        vm.prank(sponsor);
        uint256 id = jobs.createJob(p);

        vm.prank(verifier);
        vm.expectRevert(ProbeJobs.NotEligible.selector);
        jobs.recordAccepted(id, operator, keccak256("fp1"), keccak256("r1"));

        probeToken.mint(operator, 1_000e18);
        assertTrue(jobs.isEligible(id, operator));
        vm.prank(verifier);
        jobs.recordAccepted(id, operator, keccak256("fp1"), keccak256("r1"));
        assertEq(jobs.owed(address(usdc), operator), REWARD);
    }

    function test_recordAccepted_budgetExhausted() public {
        vm.prank(sponsor);
        uint256 id = jobs.createJob(_params(address(usdc), REWARD, REWARD * 2 + 1));
        vm.startPrank(verifier);
        jobs.recordAccepted(id, operator, keccak256("a"), bytes32(0));
        jobs.recordAccepted(id, operator, keccak256("b"), bytes32(0));
        vm.expectRevert(ProbeJobs.BudgetExhausted.selector);
        jobs.recordAccepted(id, operator, keccak256("c"), bytes32(0));
        vm.stopPrank();
    }

    function test_recordAccepted_rejectsZeroInputs() public {
        uint256 id = _createUsdcJob();
        vm.startPrank(verifier);
        vm.expectRevert(ProbeJobs.InvalidParams.selector);
        jobs.recordAccepted(id, address(0), keccak256("a"), bytes32(0));
        vm.expectRevert(ProbeJobs.InvalidParams.selector);
        jobs.recordAccepted(id, operator, bytes32(0), bytes32(0));
        vm.stopPrank();
    }

    // ------------------------------------------------------------ withdraw

    function test_withdraw_erc20() public {
        uint256 id = _createUsdcJob();
        vm.prank(verifier);
        jobs.recordAccepted(id, operator, keccak256("fp1"), bytes32(0));
        vm.prank(operator);
        jobs.withdraw(address(usdc));
        assertEq(usdc.balanceOf(operator), REWARD);
        assertEq(jobs.owed(address(usdc), operator), 0);
        vm.prank(operator);
        vm.expectRevert(ProbeJobs.NothingOwed.selector);
        jobs.withdraw(address(usdc));
    }

    function test_withdraw_native() public {
        vm.prank(sponsor);
        uint256 id = jobs.createJob{value: 1 ether}(_params(address(0), 0.25 ether, 1 ether));
        vm.prank(verifier);
        jobs.recordAccepted(id, operator, keccak256("fp1"), bytes32(0));
        vm.prank(operator);
        jobs.withdraw(address(0));
        assertEq(operator.balance, 0.25 ether);
    }

    // ------------------------------------------------------------ close

    function test_close_sponsorBeforeDeadlineReverts() public {
        uint256 id = _createUsdcJob();
        vm.prank(sponsor);
        vm.expectRevert(ProbeJobs.DeadlineNotReached.selector);
        jobs.close(id);
    }

    function test_close_afterDeadlineRefundsRemainder() public {
        uint256 id = _createUsdcJob();
        vm.prank(verifier);
        jobs.recordAccepted(id, operator, keccak256("fp1"), bytes32(0));
        uint256 before = usdc.balanceOf(sponsor);
        vm.warp(block.timestamp + 8 days);
        vm.prank(sponsor);
        jobs.close(id);
        assertEq(usdc.balanceOf(sponsor) - before, BUDGET - REWARD);
        assertEq(uint8(jobs.getJob(id).status), uint8(ProbeJobs.Status.Closed));
        // Operator can still withdraw what was earned before closing.
        vm.prank(operator);
        jobs.withdraw(address(usdc));
        assertEq(usdc.balanceOf(operator), REWARD);
        assertEq(usdc.balanceOf(address(jobs)), 0);
    }

    function test_close_verifierWhenExhausted() public {
        vm.prank(sponsor);
        uint256 id = jobs.createJob(_params(address(usdc), REWARD, REWARD + 5));
        vm.startPrank(verifier);
        jobs.recordAccepted(id, operator, keccak256("a"), bytes32(0));
        jobs.close(id);
        vm.stopPrank();
        assertEq(uint8(jobs.getJob(id).status), uint8(ProbeJobs.Status.Closed));
    }

    function test_close_strangerReverts() public {
        uint256 id = _createUsdcJob();
        vm.warp(block.timestamp + 8 days);
        vm.prank(other);
        vm.expectRevert(ProbeJobs.NotSponsor.selector);
        jobs.close(id);
    }

    function test_closedJobRejectsSettlementAndFunding() public {
        uint256 id = _createUsdcJob();
        vm.warp(block.timestamp + 8 days);
        vm.prank(sponsor);
        jobs.close(id);
        vm.prank(verifier);
        vm.expectRevert(ProbeJobs.JobNotOpen.selector);
        jobs.recordAccepted(id, operator, keccak256("a"), bytes32(0));
        vm.prank(sponsor);
        vm.expectRevert(ProbeJobs.JobNotOpen.selector);
        jobs.fund(id, 1);
    }

    function test_fund_topUp() public {
        uint256 id = _createUsdcJob();
        vm.prank(sponsor);
        jobs.fund(id, 500e6);
        assertEq(jobs.getJob(id).budget, BUDGET + 500e6);
        assertEq(jobs.getJob(id).funded, BUDGET + 500e6);
    }

    function test_nativeRefundToRejectingSponsorReverts() public {
        RejectingReceiver bad = new RejectingReceiver();
        vm.deal(address(bad), 1 ether);
        vm.prank(address(bad));
        uint256 id = jobs.createJob{value: 1 ether}(_params(address(0), 0.1 ether, 1 ether));
        vm.warp(block.timestamp + 8 days);
        vm.prank(address(bad));
        vm.expectRevert(ProbeJobs.NativeTransferFailed.selector);
        jobs.close(id);
    }

    function test_onlyOwnerSetsVerifier() public {
        vm.prank(other);
        vm.expectRevert();
        jobs.setVerifier(other, true);
    }

    // ------------------------------------------------------------ invariant-style fuzz

    /// Money is conserved: paid out + refunded + still held == funded.
    function testFuzz_conservation(uint8 acceptedCount, uint96 reward, uint8 extraUnits) public {
        reward = uint96(bound(reward, 1, 1_000e6));
        acceptedCount = uint8(bound(acceptedCount, 0, 20));
        uint256 budget = uint256(reward) * (uint256(acceptedCount) + 1 + extraUnits);
        usdc.mint(sponsor, budget);
        vm.prank(sponsor);
        uint256 id = jobs.createJob(_params(address(usdc), reward, budget));

        vm.startPrank(verifier);
        for (uint256 i; i < acceptedCount; i++) {
            jobs.recordAccepted(id, operator, keccak256(abi.encode(i)), bytes32(0));
        }
        vm.stopPrank();

        uint256 sponsorBefore = usdc.balanceOf(sponsor);
        vm.warp(block.timestamp + 8 days);
        vm.prank(sponsor);
        jobs.close(id);
        uint256 refunded = usdc.balanceOf(sponsor) - sponsorBefore;

        uint256 owedAmt = jobs.owed(address(usdc), operator);
        assertEq(owedAmt, uint256(reward) * acceptedCount);
        assertEq(owedAmt + refunded, budget);
        assertEq(usdc.balanceOf(address(jobs)), owedAmt);
    }
}
