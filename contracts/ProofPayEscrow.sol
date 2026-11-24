// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title ProofPayEscrow
/// @notice Holds a client's USD₮ for one payout until the client decides.
///         Only the client who paid in can release it (to the ProofPay agent, which
///         converts it and pays the freelancer) or refund it (back to themselves).
///         There is no owner, no admin and no way for anyone else to move a deposit.
contract ProofPayEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum State {
        None,
        Held,
        Released,
        Refunded
    }

    struct Deposit {
        address funder;
        uint96 amount;
        State state;
    }

    /// @notice The stablecoin this escrow holds (USD₮ on Celo).
    IERC20 public immutable token;
    /// @notice The ProofPay agent wallet that receives released deposits for conversion.
    address public immutable agent;

    /// @notice Deposits by payout id (keccak256 of the ProofPay payout id).
    mapping(bytes32 => Deposit) public deposits;

    event Funded(bytes32 indexed id, address indexed funder, uint256 amount);
    event Released(bytes32 indexed id, address indexed funder, address indexed agent, uint256 amount);
    event Refunded(bytes32 indexed id, address indexed funder, uint256 amount);

    error AlreadyFunded();
    error NotHeld();
    error NotFunder();
    error ZeroAmount();
    error AmountTooLarge();
    error ZeroAddress();

    constructor(IERC20 token_, address agent_) {
        if (address(token_) == address(0) || agent_ == address(0)) revert ZeroAddress();
        token = token_;
        agent = agent_;
    }

    /// @notice Locks `amount` of the token for payout `id`. The caller must approve this contract first.
    function fund(bytes32 id, uint256 amount) external nonReentrant {
        if (deposits[id].state != State.None) revert AlreadyFunded();
        if (amount == 0) revert ZeroAmount();

        // Record what actually arrived, in case the token ever takes a fee on transfer.
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received == 0) revert ZeroAmount();
        if (received > type(uint96).max) revert AmountTooLarge();

        deposits[id] = Deposit({funder: msg.sender, amount: uint96(received), state: State.Held});
        emit Funded(id, msg.sender, received);
    }

    /// @notice The client approves the work: the deposit goes to the agent, which pays the freelancer.
    function release(bytes32 id) external nonReentrant {
        Deposit storage d = deposits[id];
        if (d.state != State.Held) revert NotHeld();
        if (msg.sender != d.funder) revert NotFunder();
        d.state = State.Released;
        token.safeTransfer(agent, d.amount);
        emit Released(id, d.funder, agent, d.amount);
    }

    /// @notice The client rejects the work: the deposit goes back to them.
    function refund(bytes32 id) external nonReentrant {
        Deposit storage d = deposits[id];
        if (d.state != State.Held) revert NotHeld();
        if (msg.sender != d.funder) revert NotFunder();
        d.state = State.Refunded;
        token.safeTransfer(d.funder, d.amount);
        emit Refunded(id, d.funder, d.amount);
    }
}
