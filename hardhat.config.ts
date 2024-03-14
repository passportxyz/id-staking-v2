import { config as dotEnvConfig } from "dotenv";
dotEnvConfig();

import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-gas-reporter";
import "hardhat-contract-sizer";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.23",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      accounts: {
        count: 220,
      },
      mining: {
        auto: true,
        // Auto-mining with a block mined a minimum of every 3 minutes
        // This is required for the event subscription to work correctly
        interval: 3 * 60 * 1000,
      },
    },
    "optimism-sepolia": {
      url: `https://opt-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_KEY}`,
      accounts: [
        process.env.DEPLOYER_PRIVATE_KEY as string,
        process.env.USER_0_PRIVATE_KEY as string,
        process.env.USER_1_PRIVATE_KEY as string,
      ],
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS ? true : false,
  },
  etherscan: {
    apiKey: {
      "optimism-sepolia": process.env.OP_ETHERSCAN_API_KEY!,
    },
    customChains: [
      {
        network: "optimism-sepolia",
        chainId: 11155420,
        urls: {
          apiURL: "https://api-sepolia-optimistic.etherscan.io/api",
          browserURL: "https://sepolia-optimism.etherscan.io/",
        },
      },
    ],
  },
};

export default config;
