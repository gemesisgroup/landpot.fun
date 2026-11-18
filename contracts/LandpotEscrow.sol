// SPDX-License-Identifier: AGPL-3.0-only
pragma solidity ^0.8.30;

interface IERC20Minimal {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @notice Landpot pot escrow: equal entries, a signed result, a review hold,
///         then winners claim their share (docs/LandpotPot.md).
/// @dev UNAUDITED. Testnet only until reviewed. Deploy only with a reviewed,
///      non-rebasing, fee-free ERC-20.
///      Ported from the Codex prototype (landpot/contracts). Changes:
///      - a frozen result can no longer hold deposits forever (see cancel);
///      - opening and starting rounds is the operator's job (a hot key the
///        game backend automates), so the guardian, who can freeze a result,
///        can stay a cold key or a multisig;
///      - the burn share is sent to the dead address, so any plain ERC-20
///        works, with or without burn().
contract LandpotEscrow {
    enum Phase { None, Funding, Started, Proposed, Final, Refunding }
    struct Round {
        uint128 stake;
        uint64 fundingEnds;
        uint64 resultEnds;
        uint64 releaseAt;
        uint8 minPlayers;
        uint8 maxPlayers;
        Phase phase;
        bool frozen;
        uint256 balance;
        address[] players;
    }

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant RESULT_TYPEHASH =
        keccak256("Result(bytes32 roundId,bytes32 playersHash,bytes32 payoutsHash,bytes32 replayHash)");
    uint256 private constant SECP256K1_HALF_N =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    /// Tokens sent here are gone: nobody holds its key.
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;

    IERC20Minimal public immutable token;
    address public immutable guardian;
    address public immutable operator;
    address public immutable oracle;
    address public immutable treasury;
    uint16 public immutable burnBps;
    uint16 public immutable treasuryBps;
    uint64 public immutable reviewDelay;
    uint256 public immutable maxBank;
    uint256 public immutable dailyCap;
    bool public paused;
    bool private entered;

    mapping(bytes32 => Round) private rounds;
    mapping(bytes32 => mapping(address => uint256)) public deposits;
    mapping(bytes32 => mapping(address => uint256)) public payouts;
    mapping(address => mapping(uint256 => uint256)) public paidPerDay;

    event Opened(bytes32 indexed id, uint256 stake, uint64 fundingEnds, uint64 resultEnds);
    event Deposited(bytes32 indexed id, address indexed player);
    event Started(bytes32 indexed id);
    event Proposed(bytes32 indexed id, bytes32 replayHash, uint64 releaseAt);
    event Review(bytes32 indexed id, bool frozen);
    event Finalized(bytes32 indexed id);
    event Refunding(bytes32 indexed id);
    event Claimed(bytes32 indexed id, address indexed player, uint256 amount);
    event Paused(bool paused);

    error Unauthorized();
    error InvalidInput();
    error WrongPhase();
    error LimitExceeded();
    error TransferFailed();

    modifier onlyGuardian() {
        if (msg.sender != guardian) revert Unauthorized();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert Unauthorized();
        _;
    }

    modifier lock() {
        if (entered) revert WrongPhase();
        entered = true;
        _;
        entered = false;
    }

    constructor(IERC20Minimal asset, address admin, address runner, address signer, address reserve,
        uint16 burn, uint16 reserveFee, uint64 delay, uint256 bankCap, uint256 payoutCap) {
        if (address(asset).code.length == 0 || admin == address(0) || runner == address(0) || signer == address(0)
            || reserve == address(0) || uint256(burn) + reserveFee > 4000
            || delay < 24 hours || delay > 48 hours || bankCap == 0 || payoutCap == 0) {
            revert InvalidInput();
        }
        token = asset;
        guardian = admin;
        operator = runner;
        oracle = signer;
        treasury = reserve;
        burnBps = burn;
        treasuryBps = reserveFee;
        reviewDelay = delay;
        maxBank = bankCap;
        dailyCap = payoutCap;
    }

    function status(bytes32 id) external view returns (Phase, bool, uint256, uint256, uint64) {
        Round storage round = rounds[id];
        return (round.phase, round.frozen, round.players.length, round.balance, round.releaseAt);
    }

    function players(bytes32 id) external view returns (address[] memory) {
        return rounds[id].players;
    }

    function setPaused(bool value) external onlyGuardian {
        paused = value;
        emit Paused(value);
    }

    function open(bytes32 id, uint128 stake, uint8 minPlayers, uint8 maxPlayers,
        uint64 fundingEnds, uint64 resultEnds) external onlyOperator {
        Round storage round = rounds[id];
        if (paused || round.phase != Phase.None) revert WrongPhase();
        if (id == bytes32(0) || stake == 0 || minPlayers < 8 || maxPlayers < minPlayers
            || maxPlayers > 16 || uint256(stake) * maxPlayers > maxBank || fundingEnds <= block.timestamp
            || fundingEnds > block.timestamp + 1 days || resultEnds <= fundingEnds
            || resultEnds > fundingEnds + 2 days) revert InvalidInput();
        round.stake = stake;
        round.minPlayers = minPlayers;
        round.maxPlayers = maxPlayers;
        round.fundingEnds = fundingEnds;
        round.resultEnds = resultEnds;
        round.phase = Phase.Funding;
        emit Opened(id, stake, fundingEnds, resultEnds);
    }

    function deposit(bytes32 id) external lock {
        Round storage round = rounds[id];
        if (paused || round.phase != Phase.Funding || block.timestamp >= round.fundingEnds) revert WrongPhase();
        if (deposits[id][msg.sender] != 0 || round.players.length >= round.maxPlayers) revert LimitExceeded();
        deposits[id][msg.sender] = round.stake;
        round.balance += round.stake;
        round.players.push(msg.sender);
        uint256 beforeBalance = token.balanceOf(address(this));
        if (!token.transferFrom(msg.sender, address(this), round.stake)
            || token.balanceOf(address(this)) - beforeBalance != round.stake) revert TransferFailed();
        emit Deposited(id, msg.sender);
    }

    function start(bytes32 id) external onlyOperator {
        Round storage round = rounds[id];
        if (paused || round.phase != Phase.Funding || block.timestamp >= round.fundingEnds
            || round.players.length < round.minPlayers) revert WrongPhase();
        round.phase = Phase.Started;
        emit Started(id);
    }

    function digest(bytes32 id, uint256[] calldata amounts, bytes32 replayHash) public view returns (bytes32) {
        bytes32 domain = keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("LandpotEscrow"),
            keccak256("1"), block.chainid, address(this)));
        bytes32 result = keccak256(abi.encode(RESULT_TYPEHASH, id,
            keccak256(abi.encode(rounds[id].players)), keccak256(abi.encode(amounts)), replayHash));
        return keccak256(abi.encodePacked(hex"1901", domain, result));
    }

    function propose(bytes32 id, uint256[] calldata amounts, bytes32 replayHash,
        uint8 v, bytes32 r, bytes32 s) external {
        Round storage round = rounds[id];
        if (paused || round.phase != Phase.Started || block.timestamp >= round.resultEnds) revert WrongPhase();
        if (replayHash == bytes32(0) || amounts.length != round.players.length || uint256(s) > SECP256K1_HALF_N
            || (v != 27 && v != 28)) revert InvalidInput();
        if (ecrecover(digest(id, amounts, replayHash), v, r, s) != oracle) revert Unauthorized();
        uint256 total;
        for (uint256 index; index < amounts.length; ++index) {
            total += amounts[index];
            payouts[id][round.players[index]] = amounts[index];
        }
        if (total != round.balance - round.balance * burnBps / 10000
            - round.balance * treasuryBps / 10000) revert InvalidInput();
        round.releaseAt = uint64(block.timestamp) + reviewDelay;
        round.phase = Phase.Proposed;
        emit Proposed(id, replayHash, round.releaseAt);
    }

    function review(bytes32 id, bool freeze) external onlyGuardian {
        Round storage round = rounds[id];
        if (round.phase != Phase.Proposed) revert WrongPhase();
        round.frozen = freeze;
        emit Review(id, freeze);
    }

    function cancel(bytes32 id) external {
        Round storage round = rounds[id];
        // A frozen result is the guardian's to resolve, but not forever: one
        // more review period after release, anyone may refund the round.
        bool timeout = (round.phase == Phase.Funding && block.timestamp >= round.fundingEnds)
            || (round.phase == Phase.Started && block.timestamp >= round.resultEnds)
            || (round.phase == Phase.Proposed && round.frozen
                && block.timestamp >= uint256(round.releaseAt) + reviewDelay);
        bool adminCancel = msg.sender == guardian && (round.phase == Phase.Funding || round.phase == Phase.Started
            || (round.phase == Phase.Proposed && round.frozen));
        // The operator may close a lobby that will not fill before its
        // funding window ends, so entries come back sooner. Only refunds.
        bool lobbyClosed = msg.sender == operator && round.phase == Phase.Funding;
        if (!timeout && !adminCancel && !lobbyClosed) revert WrongPhase();
        round.phase = Phase.Refunding;
        emit Refunding(id);
    }

    function finalize(bytes32 id) external lock {
        Round storage round = rounds[id];
        if (paused || round.phase != Phase.Proposed || round.frozen || block.timestamp < round.releaseAt) revert WrongPhase();
        uint256 burn = round.balance * burnBps / 10000;
        uint256 reserve = round.balance * treasuryBps / 10000;
        round.balance -= burn + reserve;
        round.phase = Phase.Final;
        if (burn != 0 && !token.transfer(BURN_ADDRESS, burn)) revert TransferFailed();
        if (reserve != 0 && !token.transfer(treasury, reserve)) revert TransferFailed();
        emit Finalized(id);
    }

    function claim(bytes32 id) external lock {
        Round storage round = rounds[id];
        uint256 amount;
        if (round.phase == Phase.Refunding) {
            amount = deposits[id][msg.sender];
            deposits[id][msg.sender] = 0;
        } else if (round.phase == Phase.Final) {
            uint256 date = block.timestamp / 1 days;
            uint256 remaining = dailyCap - paidPerDay[msg.sender][date];
            uint256 award = payouts[id][msg.sender];
            amount = award < remaining ? award : remaining;
            payouts[id][msg.sender] = award - amount;
            paidPerDay[msg.sender][date] += amount;
        } else revert WrongPhase();
        if (amount == 0) revert LimitExceeded();
        round.balance -= amount;
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
        emit Claimed(id, msg.sender, amount);
    }
}
