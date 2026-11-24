// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
    function symbol() external view returns (string memory);
}

/**
 * @title LandpotEscrow
 * @notice Non-custodial BEP-20 match escrow for Landpot on BNB Smart Chain (BSC).
 *         Supports 1v1 Duels (2 players) and FFA / Cup matches (8-16 players).
 *         - 2% burned permanently to 0x000000000000000000000000000000000000dEaD
 *         - 3% sent to treasury
 *         - 95% distributed to winners by oracle-signed replay result
 *         - 100% refundable on unfilled/cancelled/tied rounds
 */
contract LandpotEscrow {
    address public constant BURN_ADDRESS = 0x000000000000000000000000000000000000dEaD;
    uint16 public constant MAX_TOTAL_BPS = 1000; // <= 10% total fee hard cap

    enum Phase {
        None,
        Funding,
        Started,
        Proposed,
        Final,
        Refunding
    }

    struct Round {
        Phase phase;
        bool frozen;
        uint8 minPlayers;
        uint8 maxPlayers;
        uint64 fundingEnds;
        uint64 resultEnds;
        uint64 releaseAt;
        uint256 stake;
        uint256 balance;
        bytes32 replayHash;
        address[] players;
    }

    IERC20 public immutable token;
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
    uint256 private _locked = 1;

    mapping(bytes32 => Round) private _rounds;
    mapping(bytes32 => mapping(address => uint256)) public deposits;
    mapping(bytes32 => mapping(address => uint256)) public payouts;
    mapping(address => mapping(uint64 => uint256)) public claimedByDay;

    event RoundOpened(bytes32 indexed roundId, uint256 stake, uint8 minPlayers, uint8 maxPlayers, uint64 fundingEnds, uint64 resultEnds);
    event Deposited(bytes32 indexed roundId, address indexed player, uint256 amount);
    event RoundStarted(bytes32 indexed roundId, uint256 playerCount);
    event RoundProposed(bytes32 indexed roundId, bytes32 replayHash, uint64 releaseAt);
    event RoundFinalized(bytes32 indexed roundId, uint256 burned, uint256 treasuryFee);
    event RoundCancelled(bytes32 indexed roundId);
    event RoundFrozen(bytes32 indexed roundId, bool frozen);
    event Claimed(bytes32 indexed roundId, address indexed player, uint256 amount, bool isRefund);

    modifier nonReentrant() {
        require(_locked == 1, "reentrant");
        _locked = 2;
        _;
        _locked = 1;
    }

    modifier onlyOperator() {
        require(msg.sender == operator, "not operator");
        _;
    }

    modifier onlyGuardian() {
        require(msg.sender == guardian, "not guardian");
        _;
    }

    constructor(
        address _token,
        address _guardian,
        address _operator,
        address _oracle,
        address _treasury,
        uint16 _burnBps,
        uint16 _treasuryBps,
        uint64 _reviewDelay,
        uint256 _maxBank,
        uint256 _dailyCap
    ) {
        require(_token != address(0), "zero token");
        require(_guardian != address(0) && _operator != address(0) && _oracle != address(0) && _treasury != address(0), "zero role");
        require(_burnBps + _treasuryBps <= MAX_TOTAL_BPS, "fees too high");
        require(_maxBank > 0 && _dailyCap > 0, "zero caps");

        token = IERC20(_token);
        guardian = _guardian;
        operator = _operator;
        oracle = _oracle;
        treasury = _treasury;
        burnBps = _burnBps;
        treasuryBps = _treasuryBps;
        reviewDelay = _reviewDelay;
        maxBank = _maxBank;
        dailyCap = _dailyCap;
    }

    function setPaused(bool _paused) external onlyGuardian {
        paused = _paused;
    }

    function setFrozen(bytes32 roundId, bool _frozen) external onlyGuardian {
        Round storage r = _rounds[roundId];
        require(r.phase != Phase.None && r.phase != Phase.Final, "cannot freeze");
        r.frozen = _frozen;
        emit RoundFrozen(roundId, _frozen);
    }

    function open(
        bytes32 roundId,
        uint256 stake,
        uint8 minPlayers,
        uint8 maxPlayers,
        uint64 fundingEnds,
        uint64 resultEnds
    ) external onlyOperator {
        require(!paused, "paused");
        Round storage r = _rounds[roundId];
        require(r.phase == Phase.None, "exists");
        require(stake > 0, "zero stake");
        require(minPlayers >= 2 && maxPlayers >= minPlayers && maxPlayers <= 16, "bad players");
        require(uint256(maxPlayers) * stake <= maxBank, "exceeds maxBank");
        require(fundingEnds > block.timestamp && resultEnds > fundingEnds, "bad deadlines");

        r.phase = Phase.Funding;
        r.minPlayers = minPlayers;
        r.maxPlayers = maxPlayers;
        r.fundingEnds = fundingEnds;
        r.resultEnds = resultEnds;
        r.stake = stake;

        emit RoundOpened(roundId, stake, minPlayers, maxPlayers, fundingEnds, resultEnds);
    }

    function deposit(bytes32 roundId) external nonReentrant {
        require(!paused, "paused");
        Round storage r = _rounds[roundId];
        require(r.phase == Phase.Funding, "not funding");
        require(!r.frozen, "frozen");
        require(block.timestamp <= r.fundingEnds, "funding closed");
        require(r.players.length < r.maxPlayers, "full");
        require(deposits[roundId][msg.sender] == 0, "already deposited");

        uint256 amt = r.stake;
        uint256 beforeBal = token.balanceOf(address(this));
        require(token.transferFrom(msg.sender, address(this), amt), "transferFrom failed");
        uint256 received = token.balanceOf(address(this)) - beforeBal;
        require(received == amt, "fee-on-transfer unsupported");

        deposits[roundId][msg.sender] = amt;
        r.players.push(msg.sender);
        r.balance += amt;

        emit Deposited(roundId, msg.sender, amt);
    }

    function start(bytes32 roundId) external onlyOperator {
        Round storage r = _rounds[roundId];
        require(r.phase == Phase.Funding, "not funding");
        require(!r.frozen, "frozen");
        require(r.players.length >= r.minPlayers, "too few players");

        r.phase = Phase.Started;
        emit RoundStarted(roundId, r.players.length);
    }

    function cancel(bytes32 roundId) external {
        Round storage r = _rounds[roundId];
        require(r.phase != Phase.None && r.phase != Phase.Final && r.phase != Phase.Refunding, "cannot cancel");
        if (msg.sender == guardian) {
            // Guardian may cancel any non-final round.
        } else if (msg.sender == operator) {
            require(
                r.phase == Phase.Funding ||
                (r.phase == Phase.Started && block.timestamp >= r.resultEnds),
                "operator cannot cancel active round"
            );
        } else {
            // Anyone can trigger refund if deadlines passed without start/result.
            require(
                (r.phase == Phase.Funding && block.timestamp > r.fundingEnds && r.players.length < r.minPlayers) ||
                (r.phase == Phase.Started && block.timestamp >= r.resultEnds),
                "not cancellable yet"
            );
        }

        r.phase = Phase.Refunding;
        r.releaseAt = uint64(block.timestamp);
        emit RoundCancelled(roundId);
    }

    function propose(
        bytes32 roundId,
        uint256[] calldata amounts,
        bytes32 replayHash,
        bytes calldata oracleSig
    ) external onlyOperator {
        Round storage r = _rounds[roundId];
        require(r.phase == Phase.Started, "not started");
        require(!r.frozen, "frozen");
        require(amounts.length == r.players.length, "bad amounts len");

        _verifyOracle(roundId, replayHash, amounts, oracleSig);

        uint256 total = r.balance;
        uint256 net = total - (total * burnBps) / 10_000 - (total * treasuryBps) / 10_000;

        uint256 sum = 0;
        for (uint256 i = 0; i < amounts.length; i++) {
            sum += amounts[i];
            payouts[roundId][r.players[i]] = amounts[i];
        }
        require(sum == net, "payout sum mismatch");

        r.replayHash = replayHash;
        r.releaseAt = uint64(block.timestamp) + reviewDelay;
        r.phase = Phase.Proposed;

        emit RoundProposed(roundId, replayHash, r.releaseAt);
    }

    function finalize(bytes32 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        require(r.phase == Phase.Proposed, "not proposed");
        require(!r.frozen, "frozen");
        require(block.timestamp >= r.releaseAt, "review hold active");

        uint256 total = r.balance;
        uint256 burnAmt = (total * burnBps) / 10_000;
        uint256 treasuryAmt = (total * treasuryBps) / 10_000;

        r.phase = Phase.Final;
        r.balance = total - burnAmt - treasuryAmt;

        if (burnAmt > 0) {
            require(token.transfer(BURN_ADDRESS, burnAmt), "burn transfer failed");
        }
        if (treasuryAmt > 0) {
            require(token.transfer(treasury, treasuryAmt), "treasury transfer failed");
        }

        emit RoundFinalized(roundId, burnAmt, treasuryAmt);
    }

    function claim(bytes32 roundId) external nonReentrant {
        Round storage r = _rounds[roundId];
        require(!r.frozen, "frozen");

        uint256 amount = 0;
        bool isRefund = false;
        if (r.phase == Phase.Final) {
            amount = payouts[roundId][msg.sender];
            require(amount > 0, "nothing to claim");
            payouts[roundId][msg.sender] = 0;
        } else if (r.phase == Phase.Refunding) {
            amount = deposits[roundId][msg.sender];
            require(amount > 0, "nothing to refund");
            deposits[roundId][msg.sender] = 0;
            isRefund = true;
        } else {
            revert("not claimable");
        }

        if (!isRefund) {
            uint64 day = uint64(block.timestamp / 1 days);
            uint256 nextClaimed = claimedByDay[msg.sender][day] + amount;
            require(nextClaimed <= dailyCap, "daily claim cap");
            claimedByDay[msg.sender][day] = nextClaimed;
        }

        r.balance -= amount;
        require(token.transfer(msg.sender, amount), "claim transfer failed");
        emit Claimed(roundId, msg.sender, amount, isRefund);
    }

    function getRound(bytes32 roundId)
        external
        view
        returns (
            Phase phase,
            bool frozen,
            uint8 minPlayers,
            uint8 maxPlayers,
            uint64 fundingEnds,
            uint64 resultEnds,
            uint64 releaseAt,
            uint256 stake,
            uint256 balance,
            uint256 playerCount
        )
    {
        Round storage r = _rounds[roundId];
        return (
            r.phase,
            r.frozen,
            r.minPlayers,
            r.maxPlayers,
            r.fundingEnds,
            r.resultEnds,
            r.releaseAt,
            r.stake,
            r.balance,
            r.players.length
        );
    }

    function getPlayers(bytes32 roundId) external view returns (address[] memory) {
        return _rounds[roundId].players;
    }

    function _verifyOracle(
        bytes32 roundId,
        bytes32 replayHash,
        uint256[] calldata amounts,
        bytes calldata oracleSig
    ) internal view {
        bytes32 digest = keccak256(
            abi.encodePacked(
                "landpot:propose",
                block.chainid,
                address(this),
                roundId,
                replayHash,
                keccak256(abi.encodePacked(amounts))
            )
        );
        bytes32 ethSigned = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        require(_recover(ethSigned, oracleSig) == oracle, "bad oracle sig");
    }

    function _recover(bytes32 hash, bytes memory sig) internal pure returns (address) {
        require(sig.length == 65, "bad sig length");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(sig, 32))
            s := mload(add(sig, 64))
            v := byte(0, mload(add(sig, 96)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad sig v");
        return ecrecover(hash, v, r, s);
    }
}
