// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title ProbeJobs
/// @notice Escrow for PROBE testing jobs.
///
/// A sponsor funds a job up front. Only an approved verifier can record an
/// accepted result, and each execution fingerprint can be paid once per job.
/// Rewards are credited to the operator and withdrawn by them (pull payment).
/// After the deadline, the sponsor can close the job and reclaim what is left.
///
/// The contract never decides what is a valid result. It enforces the money
/// rules: funded before work, one payment per fingerprint, eligibility, and
/// budget limits.
contract ProbeJobs is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Closed
    }

    struct Job {
        address sponsor;
        address verifier;
        /// @dev address(0) means the native currency.
        address rewardToken;
        /// @dev address(0) means no holding requirement.
        address eligibilityToken;
        uint256 minHolding;
        uint256 rewardPerAccepted;
        uint256 budget; // remaining, unallocated
        uint256 funded; // total ever funded
        uint64 deadline;
        uint32 accepted;
        Status status;
        /// @dev keccak256 of the canonical job spec JSON.
        bytes32 specHash;
        /// @dev Sponsor X25519 public key for encrypted failure reports.
        bytes32 reportKey;
    }

    struct CreateParams {
        address verifier;
        address rewardToken;
        address eligibilityToken;
        uint256 minHolding;
        uint256 rewardPerAccepted;
        uint256 budget;
        uint64 deadline;
        bytes32 specHash;
        bytes32 reportKey;
    }

    uint256 public nextJobId = 1;
    mapping(uint256 => Job) internal _jobs;
    mapping(uint256 => mapping(bytes32 => bool)) public fingerprintPaid;
    mapping(address => bool) public approvedVerifier;
    /// @notice token => operator => withdrawable amount (address(0) = native)
    mapping(address => mapping(address => uint256)) public owed;

    event VerifierApproved(address indexed verifier, bool approved);
    event JobCreated(
        uint256 indexed jobId,
        address indexed sponsor,
        address indexed verifier,
        address rewardToken,
        uint256 rewardPerAccepted,
        uint256 budget,
        uint64 deadline,
        bytes32 specHash
    );
    event JobFunded(uint256 indexed jobId, address indexed from, uint256 amount, uint256 budget);
    event ResultAccepted(
        uint256 indexed jobId, address indexed operator, bytes32 indexed fingerprint, bytes32 resultHash, uint256 reward
    );
    event JobClosed(uint256 indexed jobId, uint256 refunded);
    event Withdrawn(address indexed operator, address indexed token, uint256 amount);

    error NotVerifier();
    error VerifierNotApproved();
    error NotSponsor();
    error JobNotOpen();
    error InvalidParams();
    error WrongValue();
    error DeadlinePassed();
    error DeadlineNotReached();
    error DuplicateFingerprint();
    error NotEligible();
    error BudgetExhausted();
    error NothingOwed();
    error NativeTransferFailed();

    constructor(address initialOwner) Ownable(initialOwner) {}

    // ----------------------------------------------------------------- admin

    function setVerifier(address verifier, bool approved) external onlyOwner {
        if (verifier == address(0)) revert InvalidParams();
        approvedVerifier[verifier] = approved;
        emit VerifierApproved(verifier, approved);
    }

    // --------------------------------------------------------------- sponsor

    /// @notice Create and fund a job in one transaction. Work opens immediately.
    function createJob(CreateParams calldata p) external payable nonReentrant returns (uint256 jobId) {
        if (!approvedVerifier[p.verifier]) revert VerifierNotApproved();
        if (p.rewardPerAccepted == 0 || p.budget < p.rewardPerAccepted) revert InvalidParams();
        if (p.deadline <= block.timestamp) revert InvalidParams();

        jobId = nextJobId++;
        Job storage j = _jobs[jobId];
        j.sponsor = msg.sender;
        j.verifier = p.verifier;
        j.rewardToken = p.rewardToken;
        j.eligibilityToken = p.eligibilityToken;
        j.minHolding = p.minHolding;
        j.rewardPerAccepted = p.rewardPerAccepted;
        j.deadline = p.deadline;
        j.specHash = p.specHash;
        j.reportKey = p.reportKey;
        j.status = Status.Open;

        uint256 received = _pull(p.rewardToken, p.budget);
        if (received < p.rewardPerAccepted) revert InvalidParams();
        j.budget = received;
        j.funded = received;

        emit JobCreated(jobId, msg.sender, p.verifier, p.rewardToken, p.rewardPerAccepted, received, p.deadline, p.specHash);
        emit JobFunded(jobId, msg.sender, received, received);
    }

    /// @notice Add budget to an open job. Anyone may top up.
    function fund(uint256 jobId, uint256 amount) external payable nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Open) revert JobNotOpen();
        if (amount == 0) revert InvalidParams();
        uint256 received = _pull(j.rewardToken, amount);
        j.budget += received;
        j.funded += received;
        emit JobFunded(jobId, msg.sender, received, j.budget);
    }

    /// @notice Close a job after its deadline and refund the unallocated budget to the sponsor.
    /// The verifier may also close early when the remaining budget cannot cover one more reward.
    function close(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Open) revert JobNotOpen();
        bool exhausted = j.budget < j.rewardPerAccepted;
        if (msg.sender == j.sponsor) {
            if (block.timestamp <= j.deadline && !exhausted) revert DeadlineNotReached();
        } else if (msg.sender == j.verifier) {
            if (!exhausted && block.timestamp <= j.deadline) revert DeadlineNotReached();
        } else {
            revert NotSponsor();
        }
        uint256 refund = j.budget;
        j.budget = 0;
        j.status = Status.Closed;
        if (refund > 0) _push(j.rewardToken, j.sponsor, refund);
        emit JobClosed(jobId, refund);
    }

    // -------------------------------------------------------------- verifier

    /// @notice Record an accepted result and credit the operator.
    /// @param fingerprint Execution-path fingerprint. Paid at most once per job.
    /// @param resultHash Hash of the verifier's public result record.
    function recordAccepted(uint256 jobId, address operator, bytes32 fingerprint, bytes32 resultHash)
        external
        nonReentrant
    {
        Job storage j = _jobs[jobId];
        if (msg.sender != j.verifier) revert NotVerifier();
        if (!approvedVerifier[msg.sender]) revert VerifierNotApproved();
        if (j.status != Status.Open) revert JobNotOpen();
        if (block.timestamp > j.deadline) revert DeadlinePassed();
        if (operator == address(0) || fingerprint == bytes32(0)) revert InvalidParams();
        if (fingerprintPaid[jobId][fingerprint]) revert DuplicateFingerprint();
        if (!isEligible(jobId, operator)) revert NotEligible();
        uint256 reward = j.rewardPerAccepted;
        if (j.budget < reward) revert BudgetExhausted();

        fingerprintPaid[jobId][fingerprint] = true;
        j.budget -= reward;
        j.accepted += 1;
        owed[j.rewardToken][operator] += reward;

        emit ResultAccepted(jobId, operator, fingerprint, resultHash, reward);
    }

    // -------------------------------------------------------------- operator

    function withdraw(address token) external nonReentrant {
        uint256 amount = owed[token][msg.sender];
        if (amount == 0) revert NothingOwed();
        owed[token][msg.sender] = 0;
        _push(token, msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    // ------------------------------------------------------------------ views

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function isEligible(uint256 jobId, address operator) public view returns (bool) {
        Job storage j = _jobs[jobId];
        if (j.eligibilityToken == address(0) || j.minHolding == 0) return true;
        return IERC20(j.eligibilityToken).balanceOf(operator) >= j.minHolding;
    }

    // --------------------------------------------------------------- internal

    /// @dev Returns the amount actually received, so fee-on-transfer tokens cannot inflate a budget.
    function _pull(address token, uint256 amount) internal returns (uint256 received) {
        if (token == address(0)) {
            if (msg.value != amount) revert WrongValue();
            return amount;
        }
        if (msg.value != 0) revert WrongValue();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
    }

    function _push(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }
}
