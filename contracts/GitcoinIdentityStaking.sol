// SPDX-License-Identifier: GPL
pragma solidity ^0.8.23;

import {Initializable, AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
// TODO Should we use IERC20 instead? It looks like the ABI matches for the functions we use
import {GTC} from "./mocks/GTC.sol";

// TODO - add extendSelfStake(duration) and extendCommunityStake(stakee, duration) functions
// TODO - add IGitcoinIdentityStaking.sol interface definition (maybe with only the
//          accessors for selfStakes, communityStakes, and userTotalStaked?)
// TODO - docs for each function, example:
//          https://github.com/Uniswap/v3-core/blob/main/contracts/interfaces/IUniswapV3Factory.sol


/**
 * @title GitcoinIdentityStaking
 * @notice This contract is used to stake GTC on self/community identity
 */
contract GitcoinIdentityStaking is
  Initializable,
  UUPSUpgradeable,
  AccessControlUpgradeable,
  PausableUpgradeable
{
  error FundsNotAvailableToRelease();
  error MinimumBurnRoundDurationNotMet();
  error AmountMustBeGreaterThanZero();
  error CannotStakeOnSelf();
  error FailedTransfer();
  error InvalidLockTime();
  error StakeIsLocked();
  error AmountTooHigh();
  error StakerStakeeMismatch();
  error FundsNotAvailableToSlash();
  error FundsNotAvailableToReleaseFromRound();
  error RoundAlreadyBurned();

  bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");
  bytes32 public constant RELEASER_ROLE = keccak256("RELEASER_ROLE");

  // uint88s Can hold up to 300 million w/ 18 decimals, or 3x the current max supply
  struct Stake {
    uint64 unlockTime;
    uint88 amount;
    uint88 slashedAmount;
    uint16 slashedInRound;
  }

  mapping(address => uint88) public userTotalStaked;

  mapping(address => Stake) public selfStakes;
  mapping(address => mapping(address => Stake)) public communityStakes;

  uint16 public currentSlashRound = 1;

  uint64 public burnRoundMinimumDuration = 90 days;

  uint256 public lastBurnTimestamp;

  address public burnAddress;

  mapping(uint256 => uint88) public totalSlashed;

  GTC public gtc;

  event SelfStake(address indexed staker, uint88 amount, uint64 unlockTime);

  event CommunityStake(
    address indexed staker,
    address indexed stakee,
    uint88 amount,
    uint64 unlockTime
  );

  event SelfStakeWithdrawn(address indexed staker, uint88 amount);

  event CommunityStakeWithdrawn(address indexed staker, address indexed stakee, uint88 amount);

  event Slash(address indexed staker, uint88 amount, uint16 round);

  event LockAndBurn(uint16 indexed round, uint88 amount);

  function initialize(address gtcAddress, address _burnAddress) public initializer {
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

    __AccessControl_init();
    __Pausable_init();

    // TODO check these aren't zero?
    gtc = GTC(gtcAddress);
    burnAddress = _burnAddress;

    lastBurnTimestamp = block.timestamp;
  }

  function selfStake(uint88 amount, uint64 duration) external {
    // revert if amount is 0. Since this value is unsigned integer
    if (amount == 0) {
      revert AmountMustBeGreaterThanZero();
    }

    uint64 unlockTime = duration + uint64(block.timestamp);

    // TODO make sure there isn't an existing stake.unlockTime that is
    // later than this unlockTime. Same for communityStake below
    if (unlockTime < block.timestamp + 12 weeks || unlockTime > block.timestamp + 104 weeks) {
      revert InvalidLockTime();
    }

    selfStakes[msg.sender].amount += amount;
    selfStakes[msg.sender].unlockTime = unlockTime;
    userTotalStaked[msg.sender] += amount;

    if (!gtc.transferFrom(msg.sender, address(this), amount)) {
      revert FailedTransfer();
    }

    emit SelfStake(msg.sender, amount, unlockTime);
  }

  function withdrawSelfStake(uint88 amount) external {
    if (selfStakes[msg.sender].unlockTime > block.timestamp) {
      revert StakeIsLocked();
    }

    if (amount > selfStakes[msg.sender].amount) {
      revert AmountTooHigh();
    }

    selfStakes[msg.sender].amount -= amount;
    userTotalStaked[msg.sender] -= amount;

    gtc.transfer(msg.sender, amount);

    emit SelfStakeWithdrawn(msg.sender, amount);
  }

  function communityStake(address stakee, uint88 amount, uint64 duration) external {
    if (stakee == msg.sender) {
      revert CannotStakeOnSelf();
    }
    if (amount == 0) {
      revert AmountMustBeGreaterThanZero();
    }

    uint64 unlockTime = duration + uint64(block.timestamp);

    if (unlockTime < block.timestamp + 12 weeks || unlockTime > block.timestamp + 104 weeks) {
      revert InvalidLockTime();
    }

    communityStakes[msg.sender][stakee].amount += amount;
    communityStakes[msg.sender][stakee].unlockTime = unlockTime;
    userTotalStaked[msg.sender] += amount;

    if (!gtc.transferFrom(msg.sender, address(this), amount)) {
      revert FailedTransfer();
    }

    emit CommunityStake(msg.sender, stakee, amount, unlockTime);
  }

  function withdrawCommunityStake(address stakee, uint88 amount) external {
    if (communityStakes[msg.sender][stakee].unlockTime > block.timestamp) {
      revert StakeIsLocked();
    }

    if (amount > communityStakes[msg.sender][stakee].amount) {
      revert AmountTooHigh();
    }

    communityStakes[msg.sender][stakee].amount -= amount;
    userTotalStaked[msg.sender] -= amount;

    gtc.transfer(msg.sender, amount);

    emit CommunityStakeWithdrawn(msg.sender, stakee, amount);
  }

  function slash(
    address[] calldata selfStakers,
    address[] calldata communityStakers,
    address[] calldata communityStakees,
    uint64 percent
  ) external onlyRole(SLASHER_ROLE) {
    uint256 numSelfStakers = selfStakers.length;
    uint256 numCommunityStakers = communityStakers.length;

    if (numCommunityStakers != communityStakees.length) {
      revert StakerStakeeMismatch();
    }

    for (uint256 i = 0; i < numSelfStakers; i++) {
      address staker = selfStakers[i];
      uint88 slashedAmount = (percent * selfStakes[staker].amount) / 100;

      // TODO Instead of doing this check, should we just check once at the
      // beginning that percent is <= 100? That should be logically equivalent,
      // and probably more gas efficient. Same for community
      if (slashedAmount > selfStakes[staker].amount) {
        revert FundsNotAvailableToSlash();
      }

      if (
        selfStakes[staker].slashedInRound != 0 &&
        selfStakes[staker].slashedInRound != currentSlashRound
      ) {
        if (selfStakes[staker].slashedInRound == currentSlashRound - 1) {
          // If this is a slash from the previous round (not yet burned), move
          // it to the current round
          totalSlashed[currentSlashRound - 1] -= selfStakes[staker].slashedAmount;
          totalSlashed[currentSlashRound] += selfStakes[staker].slashedAmount;
        } else {
          // Otherwise, this is a stale slash and can be overwritten
          selfStakes[staker].slashedAmount = 0;
        }
      }

      totalSlashed[currentSlashRound] += slashedAmount;

      selfStakes[staker].slashedInRound = currentSlashRound;
      selfStakes[staker].slashedAmount += slashedAmount;
      selfStakes[staker].amount -= slashedAmount;

      userTotalStaked[staker] -= slashedAmount;

      emit Slash(staker, slashedAmount, currentSlashRound);
    }

    for (uint256 i = 0; i < numCommunityStakers; i++) {
      address staker = communityStakers[i];
      address stakee = communityStakees[i];
      uint88 slashedAmount = (percent * communityStakes[staker][stakee].amount) / 100;

      if (slashedAmount > communityStakes[staker][stakee].amount) {
        revert FundsNotAvailableToSlash();
      }

      if (
        communityStakes[staker][stakee].slashedInRound != 0 &&
        communityStakes[staker][stakee].slashedInRound != currentSlashRound
      ) {
        if (communityStakes[staker][stakee].slashedInRound == currentSlashRound - 1) {
          // If this is a slash from the previous round (not yet burned), move
          // it to the current round
          totalSlashed[currentSlashRound - 1] -= communityStakes[staker][stakee].slashedAmount;
          totalSlashed[currentSlashRound] += communityStakes[staker][stakee].slashedAmount;
        } else {
          // Otherwise, this is a stale slash and can be overwritten
          communityStakes[staker][stakee].slashedAmount = 0;
        }
      }

      totalSlashed[currentSlashRound] += slashedAmount;

      communityStakes[staker][stakee].slashedInRound = currentSlashRound;
      communityStakes[staker][stakee].slashedAmount += slashedAmount;
      communityStakes[staker][stakee].amount -= slashedAmount;

      userTotalStaked[staker] -= slashedAmount;

      emit Slash(staker, slashedAmount, currentSlashRound);
    }
  }

  // Lock the current round so that it can be burned after
  // burnRoundMinimumDuration has passed, burn the previous
  // round, and then start the new round
  function lockAndBurn() external {
    if (block.timestamp - lastBurnTimestamp < burnRoundMinimumDuration) {
      revert MinimumBurnRoundDurationNotMet();
    }

    uint88 amountToBurn = totalSlashed[currentSlashRound - 1];

    if (amountToBurn > 0) {
      if (!gtc.transfer(burnAddress, amountToBurn)) {
        revert FailedTransfer();
      }
    }

    emit LockAndBurn(currentSlashRound - 1, amountToBurn);

    currentSlashRound++;
    lastBurnTimestamp = block.timestamp;
  }

  function release(
    address staker,
    address stakee,
    uint88 amountToRelease,
    uint16 slashRound
  ) external onlyRole(RELEASER_ROLE) {
    if (slashRound < currentSlashRound - 1) {
      revert RoundAlreadyBurned();
    }

    if (totalSlashed[slashRound] < amountToRelease) {
      revert FundsNotAvailableToReleaseFromRound();
    }

    if (staker == stakee) {
      if (amountToRelease > selfStakes[staker].slashedAmount) {
        revert FundsNotAvailableToRelease();
      }

      if (selfStakes[staker].slashedInRound != slashRound) {
        revert FundsNotAvailableToReleaseFromRound();
      }

      selfStakes[staker].slashedAmount -= amountToRelease;
      selfStakes[staker].amount += amountToRelease;
    } else {
      if (amountToRelease > communityStakes[staker][stakee].slashedAmount) {
        revert FundsNotAvailableToRelease();
      }

      if (communityStakes[staker][stakee].slashedInRound != slashRound) {
        revert FundsNotAvailableToReleaseFromRound();
      }

      communityStakes[staker][stakee].slashedAmount -= amountToRelease;
      communityStakes[staker][stakee].amount += amountToRelease;
    }

    totalSlashed[slashRound] -= amountToRelease;
  }

  function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
