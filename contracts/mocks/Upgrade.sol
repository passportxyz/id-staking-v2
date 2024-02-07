// SPDX-License-Identifier: GPL
pragma solidity ^0.8.23;

import {IdentityStaking} from "../IdentityStaking.sol";

contract Upgrade is IdentityStaking {
  function newFunction() public pure returns (string memory) {
    return "Hello, World!";
  }
}
