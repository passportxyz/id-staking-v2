// SPDX-License-Identifier: GPL
pragma solidity ^0.8.23;

// THIS CONTRACT IS ONLY USED AS PART OF TESTING
// THIS IS NOT PRODUCTION CODE
// THIS IS NOT AN AUDITED CONTRACT

import {IdentityStaking} from "../IdentityStaking.sol";

contract Upgrade is IdentityStaking {
  function newFunction() public pure returns (string memory) {
    return "Hello, World!";
  }
}
