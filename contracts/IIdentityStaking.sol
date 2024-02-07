// SPDX-License-Identifier: GPL
pragma solidity ^0.8.23;

/**
 * @title IIdentityStaking
 * @notice This is a minimal interface for consuming stake data
 */
interface IIdentityStaking {

  /// @notice Self-stakes by a user
  /// @param staker The staker's address
  /// @return unlockTime Time at which the stake unlocks
  /// @return amount Unslashed amount of the stake, with 18 decimal places
  /// @return slashedAmount Current slash amount
  /// @return slashedInRound Round in which the stake was last slashed
  /// @dev see the `Stake` struct for more details
  function selfStakes(
    address staker
  )
    external
    view
    returns (uint64 unlockTime, uint88 amount, uint88 slashedAmount, uint16 slashedInRound);

  /// @notice Community-stakes by a staker on a stakee
  /// @param staker Staker's address
  /// @param stakee Stakee's address
  /// @return unlockTime Time at which the stake unlocks
  /// @return amount Unslashed amount of the stake, with 18 decimal places
  /// @return slashedAmount Current slash amount
  /// @return slashedInRound Round in which the stake was last slashed
  /// @dev see the `Stake` struct for more details
  function communityStakes(
    address staker,
    address stakee
  )
    external
    view
    returns (uint64 unlockTime, uint88 amount, uint88 slashedAmount, uint16 slashedInRound);

  /// @notice Get the total amount staked by a user
  /// @param staker The staker's address
  /// @return The total amount staked by the user, with 18 decimal places
  /// @dev This includes both self-stake and community-stakes by this user on others
  function userTotalStaked(address staker) external view returns (uint88);
}
