// SPDX-License-Identifier: GPL
pragma solidity ^0.8.23;

import {Initializable, AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
// TODO Should we use IERC20 instead? It looks like the ABI matches for the functions we use
import {GTC} from "./mocks/GTC.sol";

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
  using EnumerableSet for EnumerableSet.AddressSet;

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

  GTC public gtc;

  function initialize(address gtcAddress, address _burnAddress) public initializer {
    _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);

    __AccessControl_init();
    __Pausable_init();

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

      if (slashedAmount > selfStakes[staker].amount) {
        revert FundsNotAvailableToSlash();
      }

      if (
        selfStakes[staker].slashedInRound != 0 &&
        selfStakes[staker].slashedInRound != currentSlashRound
      ) {
        if (selfStakes[staker].slashedInRound == currentSlashRound - 1) {
          // If this is a slash from the previous round (not yet burned), move
          // it to the current round (yes this is kind of annoying, but in order
          // to attack this the user needs to keep getting slashed each round, which
          // is costly for the attacker likely for no gain)
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
          // it to the current round (yes this is kind of annoying, but in order
          // to attack this the user needs to keep getting slashed each round, which
          // is costly for the attacker likely for no gain)
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

  // Burn last round and start next round (locking this round)
  //
  // Rounds don't matter for staking, this is just to
  // ensure that slashes are aged before being burned
  //
  // On each call...
  // - the current round contains all the slashes younger than the last
  //   burn (a minimum of the round mimimum duration, 0-90 days)
  // - the previous round contains all the non-released slashes older
  //   than this (at least 90 days), and so it is burned
  // - the current round becomes the previous round, and a new round
  //   is initiated
  // On the very first call, nothing will be burned
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
