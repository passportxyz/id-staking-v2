// SPDX-License-Identifier: GPL
pragma solidity ^0.8.23;

import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IIdentityStaking} from "./IIdentityStaking.sol";

/// @title IdentityStaking
/// @author Passport
/// @notice This contract is used to stake GTC on self/community identity
contract IdentityStaking is
  IIdentityStaking,
  Initializable,
  UUPSUpgradeable,
  AccessControlUpgradeable,
  PausableUpgradeable
{
  /***** SECTION 0: Errors, State, Events *****/

  /// @dev Address parameter cannot be zero
  error AddressCannotBeZero();

  /// @dev Stake amount must be greater than zero
  error AmountMustBeGreaterThanZero();

  /// @dev A community stake cannot be placed on the staker's own address
  error CannotStakeOnSelf();

  /// @dev An ERC20 transfer failed
  error FailedTransfer();

  /// @dev The lock time must be between 12 and 104 weeks, and after any existing lock
  error InvalidLockTime();

  /// @dev The stake is still locked and cannot be withdrawn
  error StakeIsLocked();

  /// @dev The requested withdrawal amount is greater than the stake
  error AmountTooHigh();

  /// @dev The slash percent must be between 1 and 100
  error InvalidSlashPercent();

  /// @dev The staker and stakee arrays must be the same length
  error StakerStakeeMismatch();

  /// @dev The requested funds are greater than the slashed amount for this user
  error FundsNotAvailableToRelease();

  /// @dev The requested funds are not available to release for this user from the given round
  error FundsNotAvailableToReleaseFromRound();

  /// @dev The round has already been burned and its slashed stake cannot be released
  error RoundAlreadyBurned();

  /// @dev The minimum burn round duration has not been met, controlled by the `burnRoundMinimumDuration`
  error MinimumBurnRoundDurationNotMet();

  /// @notice Role held by addresses which are permitted to submit a slash.
  bytes32 public constant SLASHER_ROLE = keccak256("SLASHER_ROLE");

  /// @notice Role held by addresses which are permitted to release an un-burned slash.
  bytes32 public constant RELEASER_ROLE = keccak256("RELEASER_ROLE");

  /// @notice Role held by addresses which are permitted to pause the contract.
  bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

  /// @notice Struct representing a stake
  /// @param unlockTime The unix time in seconds after which the stake can be withdrawn
  /// @param amount The amount of GTC staked, with 18 decimals
  /// @param slashedAmount The amount of GTC slashed (could already be burned)
  /// @param slashedInRound The round in which the stake was last slashed
  /// @dev uint88s can hold up to 300 million w/ 18 decimals, or 3x the current max supply
  ///      `amount` does not include any slashed or burned GTC
  struct Stake {
    uint64 unlockTime;
    uint88 amount;
    uint88 slashedAmount;
    uint16 slashedInRound;
  }

  /// @inheritdoc IIdentityStaking
  mapping(address => uint88) public userTotalStaked;

  /// @inheritdoc IIdentityStaking
  mapping(address => Stake) public selfStakes;

  /// @inheritdoc IIdentityStaking
  mapping(address => mapping(address => Stake)) public communityStakes;

  /// @notice The current round of slashing, incremented on each call to `lockAndBurn`
  /// @dev uint16 can hold up to 65,535 rounds, or 16,383 years with 90 day rounds
  ///      Set to `1` in the initializer
  uint16 public currentSlashRound;

  /// @notice The minimum duration between burn rounds
  /// @dev This sets the minimum appeal period for a slash
  ///      Set to `90 days` in the initializer
  uint64 public burnRoundMinimumDuration;

  /// @notice The timestamp of the last burn
  uint256 public lastBurnTimestamp;

  /// @notice The address to which all burned tokens are sent
  /// @dev Set in the initializer
  ///      This could be set to the zero address. But in the case of GTC,
  ///      it is set to the GTC token contract address because GTC cannot
  ///      be transferred to the zero address
  address public burnAddress;

  /// @notice The total amount of GTC slashed in each round
  mapping(uint16 => uint88) public totalSlashed;

  /// @notice The GTC token contract
  IERC20 public token;

  /// @notice Emitted when a self-stake is added/increased/extended
  /// @param staker The staker's address
  /// @param amount The additional amount added for this particular transaction
  /// @param unlockTime Unlock time for the full self-stake amount for this staker
  /// @dev `amount` could be `0` for an extension
  event SelfStake(address indexed staker, uint88 amount, uint64 unlockTime);

  /// @notice Emitted when a community stake is added/increased/extended
  /// @param staker The staker's address
  /// @param stakee The stakee's address
  /// @param amount The additional amount added for this particular transaction
  /// @param unlockTime Unlock time for the full community stake amount for this staker on this stakee
  /// @dev `amount` could be `0` for an extension
  event CommunityStake(
    address indexed staker,
    address indexed stakee,
    uint88 amount,
    uint64 unlockTime
  );

  /// @notice Emitted when a self-stake is withdrawn
  /// @param staker The staker's address
  /// @param amount The amount withdrawn in this transaction
  event SelfStakeWithdrawn(address indexed staker, uint88 amount);

  /// @notice Emitted when a community stake is withdrawn
  /// @param staker The staker's address
  /// @param stakee The stakee's address
  /// @param amount The amount withdrawn in this transaction
  event CommunityStakeWithdrawn(address indexed staker, address indexed stakee, uint88 amount);

  /// @notice Emitted when a slash is submitted
  /// @param staker Address of the staker who is slashed
  /// @param amount The amount slashed in this transaction
  /// @param round The round in which the slash occurred
  event Slash(address indexed staker, uint88 amount, uint16 round);

  /// @notice Emitted when a round is burned
  /// @param round The round that was burned
  /// @param amount The amount of GTC burned in this transaction
  event Burn(uint16 indexed round, uint88 amount);

  /***** SECTION 1: Admin Functions *****/

  /// @notice Initialize the contract
  /// @param tokenAddress The address of the GTC token contract
  /// @param _burnAddress The address to which all burned tokens are sent
  /// @param initialAdmin The initial address to assign the DEFAULT_ADMIN_ROLE
  /// @param initialSlashers The initial addresses to assign the SLASHER_ROLE
  /// @param initialReleasers The initial addresses to assign the RELEASER_ROLE
  function initialize(
    address tokenAddress,
    address _burnAddress,
    address initialAdmin,
    address[] calldata initialSlashers,
    address[] calldata initialReleasers
  ) public initializer {
    if (tokenAddress == address(0)) {
      revert AddressCannotBeZero();
    }

    __AccessControl_init();
    __Pausable_init();

    _grantRole(DEFAULT_ADMIN_ROLE, initialAdmin);
    _grantRole(PAUSER_ROLE, initialAdmin);

    for (uint256 i = 0; i < initialSlashers.length; i++) {
      _grantRole(SLASHER_ROLE, initialSlashers[i]);
    }

    for (uint256 i = 0; i < initialReleasers.length; i++) {
      _grantRole(RELEASER_ROLE, initialReleasers[i]);
    }

    token = IERC20(tokenAddress);
    burnAddress = _burnAddress;

    currentSlashRound = 1;
    burnRoundMinimumDuration = 90 days;
    lastBurnTimestamp = block.timestamp;
  }

  /// @notice Pause the contract
  function pause() external onlyRole(PAUSER_ROLE) whenNotPaused {
    _pause();
  }

  /// @notice Unpause the contract
  function unpause() external onlyRole(PAUSER_ROLE) whenPaused {
    _unpause();
  }

  /// @inheritdoc UUPSUpgradeable
  /// @dev Only the admin can upgrade the contract
  /// @dev UUPSUpgradeable allows the contract to be permanently frozen in the future
  function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

  /***** SECTION 2: Staking Functions *****/

  /// @notice Add self stake
  /// @param amount The amount of GTC to Stake
  /// @param duration The duration in seconds of the stake lock period
  /// @dev The duration must be between 12 weeks and 104 weeks, and after any existing lock
  ///      The amount must be greater than zero
  ///      The unlock time is calculated as `block.timestamp + duration`
  ///      If there is any existing self-stake, the unlock time is extended for the entire stake amount
  function selfStake(uint88 amount, uint64 duration) external whenNotPaused {
    if (amount == 0) {
      revert AmountMustBeGreaterThanZero();
    }

    uint64 unlockTime = duration + uint64(block.timestamp);

    if (
      // Must be between 12 weeks and 104 weeks
      unlockTime < block.timestamp + 12 weeks ||
      unlockTime > block.timestamp + 104 weeks ||
      // Must be later than any existing lock
      unlockTime < selfStakes[msg.sender].unlockTime
    ) {
      revert InvalidLockTime();
    }

    selfStakes[msg.sender].amount += amount;
    selfStakes[msg.sender].unlockTime = unlockTime;
    userTotalStaked[msg.sender] += amount;

    emit SelfStake(msg.sender, amount, unlockTime);

    if (!token.transferFrom(msg.sender, address(this), amount)) {
      revert FailedTransfer();
    }
  }

  /// @notice Extend lock period for self stake
  /// @param duration The duration in seconds for the new lock period
  /// @dev The duration must be between 12 weeks and 104 weeks, and after any existing lock for this self-stake
  ///      The unlock time is calculated as `block.timestamp + duration`
  function extendSelfStake(uint64 duration) external whenNotPaused {
    if (selfStakes[msg.sender].amount == 0) {
      revert AmountMustBeGreaterThanZero();
    }

    uint64 unlockTime = duration + uint64(block.timestamp);

    if (
      // Must be between 12 weeks and 104 weeks
      unlockTime < block.timestamp + 12 weeks ||
      unlockTime > block.timestamp + 104 weeks ||
      // Must be later than any existing lock
      unlockTime < selfStakes[msg.sender].unlockTime
    ) {
      revert InvalidLockTime();
    }

    selfStakes[msg.sender].unlockTime = unlockTime;

    emit SelfStake(msg.sender, 0, unlockTime);
  }

  /// @notice Withdraw unlocked self stake
  /// @param amount The amount to withdraw
  function withdrawSelfStake(uint88 amount) external whenNotPaused {
    Stake storage sStake = selfStakes[msg.sender];

    if (sStake.unlockTime > block.timestamp) {
      revert StakeIsLocked();
    }

    if (amount > sStake.amount) {
      revert AmountTooHigh();
    }

    sStake.amount -= amount;
    userTotalStaked[msg.sender] -= amount;

    emit SelfStakeWithdrawn(msg.sender, amount);

    if (!token.transfer(msg.sender, amount)) {
      revert FailedTransfer();
    }
  }

  /// @notice Add community stake on a stakee
  /// @param stakee The address of the stakee
  /// @param amount The amount to stake
  /// @param duration The duration in seconds of the stake lock period
  /// @dev The duration must be between 12-104 weeks and 104 weeks, and after any existing lock for this staker+stakee
  ///      The amount must be greater than zero
  ///      The unlock time is calculated as `block.timestamp + duration`
  ///      If there is any existing stake by this staker on this stakee, the unlock time is extended for the entire stake amount
  function communityStake(address stakee, uint88 amount, uint64 duration) external whenNotPaused {
    if (stakee == msg.sender) {
      revert CannotStakeOnSelf();
    }
    if (stakee == address(0)) {
      revert AddressCannotBeZero();
    }
    if (amount == 0) {
      revert AmountMustBeGreaterThanZero();
    }

    uint64 unlockTime = duration + uint64(block.timestamp);

    if (
      // Must be between 12 weeks and 104 weeks
      unlockTime < block.timestamp + 12 weeks ||
      unlockTime > block.timestamp + 104 weeks ||
      // Must be later than any existing lock
      unlockTime < communityStakes[msg.sender][stakee].unlockTime
    ) {
      revert InvalidLockTime();
    }

    communityStakes[msg.sender][stakee].amount += amount;
    communityStakes[msg.sender][stakee].unlockTime = unlockTime;
    userTotalStaked[msg.sender] += amount;

    emit CommunityStake(msg.sender, stakee, amount, unlockTime);

    if (!token.transferFrom(msg.sender, address(this), amount)) {
      revert FailedTransfer();
    }
  }

  /// @notice Extend lock period for community stake on a stakee
  /// @param stakee The address of the stakee
  /// @param duration The duration in seconds for the new lock period
  /// @dev The duration must be between 12-104 weeks and 104 weeks, and after any existing lock for this staker+stakee
  ///      The unlock time is calculated as `block.timestamp + duration`
  function extendCommunityStake(address stakee, uint64 duration) external whenNotPaused {
    if (stakee == address(0)) {
      revert AddressCannotBeZero();
    }

    Stake storage comStake = communityStakes[msg.sender][stakee];

    if (comStake.amount == 0) {
      revert AmountMustBeGreaterThanZero();
    }

    uint64 unlockTime = duration + uint64(block.timestamp);

    if (
      // Must be between 12 weeks and 104 weeks
      unlockTime < block.timestamp + 12 weeks ||
      unlockTime > block.timestamp + 104 weeks ||
      // Must be later than any existing lock
      unlockTime < comStake.unlockTime
    ) {
      revert InvalidLockTime();
    }

    comStake.unlockTime = unlockTime;

    emit CommunityStake(msg.sender, stakee, 0, unlockTime);
  }

  /// @notice Withdraw unlocked community stake on a stakee
  /// @param stakee The address of the stakee
  /// @param amount The amount to withdraw
  function withdrawCommunityStake(address stakee, uint88 amount) external whenNotPaused {
    if (stakee == address(0)) {
      revert AddressCannotBeZero();
    }

    if (amount == 0) {
      revert AmountMustBeGreaterThanZero();
    }

    Stake storage comStake = communityStakes[msg.sender][stakee];

    if (comStake.unlockTime > block.timestamp) {
      revert StakeIsLocked();
    }

    if (amount > comStake.amount) {
      revert AmountTooHigh();
    }

    comStake.amount -= amount;
    userTotalStaked[msg.sender] -= amount;

    emit CommunityStakeWithdrawn(msg.sender, stakee, amount);

    if (!token.transfer(msg.sender, amount)) {
      revert FailedTransfer();
    }
  }

  /***** SECTION 3: Slashing Functions *****/

  /// @notice Submit a slash
  /// @param selfStakers The addresses of the self-stakers to slash
  /// @param communityStakers Ordered list of the community-stakers to slash
  /// @param communityStakees Ordered list of the community-stakees to slash
  /// @param percent The percentage to slash from each stake
  /// @dev The slash percent must be between 1 and 100
  ///      The community staker and stakee arrays must be the same length
  ///      Ordered such that communityStakers[i] has a communityStake on communityStakees[i]
  ///      All staked amounts are liable to be slashed, even if they are unlocked
  function slash(
    address[] calldata selfStakers,
    address[] calldata communityStakers,
    address[] calldata communityStakees,
    uint88 percent
  ) external onlyRole(SLASHER_ROLE) whenNotPaused {
    if (percent > 100 || percent == 0) {
      revert InvalidSlashPercent();
    }

    uint256 numSelfStakers = selfStakers.length;
    uint256 numCommunityStakers = communityStakers.length;

    if (numCommunityStakers != communityStakees.length) {
      revert StakerStakeeMismatch();
    }

    for (uint256 i = 0; i < numSelfStakers; i++) {
      address staker = selfStakers[i];
      uint88 slashedAmount = (percent * selfStakes[staker].amount) / 100;

      Stake storage sStake = selfStakes[staker];

      if (sStake.slashedInRound != 0 && sStake.slashedInRound != currentSlashRound) {
        if (sStake.slashedInRound == currentSlashRound - 1) {
          // If this is a slash from the previous round (not yet burned), move
          // it to the current round
          totalSlashed[currentSlashRound - 1] -= sStake.slashedAmount;
          totalSlashed[currentSlashRound] += sStake.slashedAmount;
        } else {
          // Otherwise, this is a stale slash and can be overwritten
          sStake.slashedAmount = 0;
        }
      }

      totalSlashed[currentSlashRound] += slashedAmount;

      sStake.slashedInRound = currentSlashRound;
      sStake.slashedAmount += slashedAmount;
      sStake.amount -= slashedAmount;

      userTotalStaked[staker] -= slashedAmount;

      emit Slash(staker, slashedAmount, currentSlashRound);
    }

    for (uint256 i = 0; i < numCommunityStakers; i++) {
      address staker = communityStakers[i];
      address stakee = communityStakees[i];
      uint88 slashedAmount = (percent * communityStakes[staker][stakee].amount) / 100;

      Stake storage comStake = communityStakes[staker][stakee];

      if (comStake.slashedInRound != 0 && comStake.slashedInRound != currentSlashRound) {
        if (comStake.slashedInRound == currentSlashRound - 1) {
          // If this is a slash from the previous round (not yet burned), move
          // it to the current round
          totalSlashed[currentSlashRound - 1] -= comStake.slashedAmount;
          totalSlashed[currentSlashRound] += comStake.slashedAmount;
        } else {
          // Otherwise, this is a stale slash and can be overwritten
          comStake.slashedAmount = 0;
        }
      }

      totalSlashed[currentSlashRound] += slashedAmount;

      comStake.slashedInRound = currentSlashRound;
      comStake.slashedAmount += slashedAmount;
      comStake.amount -= slashedAmount;

      userTotalStaked[staker] -= slashedAmount;

      emit Slash(staker, slashedAmount, currentSlashRound);
    }
  }

  /// @notice Progress to the next slash round, this has 3 effects:
  ///      1) Locks the current round so that it can be burned after `burnRoundMinimumDuration` has passed
  ///      2) Burns the previous round
  ///      3) Starts the new round
  /// @dev Anyone can call this function, the `burnRoundMinimumDuration` keeps everything in check
  ///      This is all about enforcing a minimum appeal period for a slash
  ///      The "locking" is implicit, in that the previous round is always burned and there is a minimum duration between burns
  function lockAndBurn() external whenNotPaused {
    if (block.timestamp - lastBurnTimestamp < burnRoundMinimumDuration) {
      revert MinimumBurnRoundDurationNotMet();
    }
    uint16 roundToBurn = currentSlashRound - 1;
    uint88 amountToBurn = totalSlashed[roundToBurn];

    ++currentSlashRound;
    lastBurnTimestamp = block.timestamp;

    if (amountToBurn > 0) {
      if (!token.transfer(burnAddress, amountToBurn)) {
        revert FailedTransfer();
      }
    }

    emit Burn(roundToBurn, amountToBurn);
  }

  /// @notice Release slashed funds
  /// @param staker The staker's address
  /// @param stakee The stakee's address
  /// @param amountToRelease The amount to release
  /// @param slashRound The round from which to release the funds
  /// @dev Only funds from the current round and the previous round can be released (prior rounds already burned)
  ///      If stakee == staker, the funds are released from the self-stake, otherwise from the community-stake
  ///      Funds can only be released back to the original staker
  function release(
    address staker,
    address stakee,
    uint88 amountToRelease,
    uint16 slashRound
  ) external onlyRole(RELEASER_ROLE) whenNotPaused {
    if (slashRound < currentSlashRound - 1) {
      revert RoundAlreadyBurned();
    }

    if (stakee == address(0)) {
      revert AddressCannotBeZero();
    }

    if (staker == address(0)) {
      revert AddressCannotBeZero();
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
}
