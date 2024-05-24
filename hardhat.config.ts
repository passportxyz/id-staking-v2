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
      url: `https://opt-sepolia.g.alchemy.com/v2/${process.env.OP_SEPOLIA_ALCHEMY_KEY}`,
      accounts: [
        process.env.DEPLOYER_PRIVATE_KEY as string,
        process.env.USER_0_PRIVATE_KEY as string,
        process.env.USER_1_PRIVATE_KEY as string,
      ],
    },
    arbitrum: {
      url: `https://arb-mainnet.g.alchemy.com/v2/${process.env.ARBITRUM_ALCHEMY_API_KEY}`,
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
      mainnet: process.env.ETHERSCAN_API_KEY!,
      optimisticEthereum: process.env.OP_ETHERSCAN_API_KEY!,
      "optimism-sepolia": process.env.OP_ETHERSCAN_API_KEY!,
      arbitrum: process.env.ARBITRUM_ETHERSCAN_API_KEY!,
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
      {
        network: "arbitrum",
        chainId: 42161,
        urls: {
          apiURL: "https://api.arbiscan.io/api",
          browserURL: "https://arbiscan.io/",
        },
      },
    ],
  },
};

export default config;
