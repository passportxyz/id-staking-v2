// SPDX-License-Identifier: GPL
pragma solidity ^0.8.23;

/**
 * @title IGitcoinIdentityStaking
 * @notice This is a minimal interface for consuming stake data
 */
interface IGitcoinIdentityStaking {
  function selfStakes(
    address
  )
    external
    view
    returns (uint64 unlockTime, uint88 amount, uint88 slashedAmount, uint16 slashedInRound);

  function communityStakes(
    address,
    address
  )
    external
    view
    returns (uint64 unlockTime, uint88 amount, uint88 slashedAmount, uint16 slashedInRound);

  function userTotalStaked(address) external view returns (uint88);
}
