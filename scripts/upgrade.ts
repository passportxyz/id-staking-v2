import { ethers, upgrades } from "hardhat";

async function main() {
  const stakingContractAddress = process.env.STAKING_CONTRACT_ADDRESS;
  if (!stakingContractAddress) {
    throw new Error("STAKING_CONTRACT_ADDRESS must be set");
  }

  const IdentityStaking = await ethers.getContractFactory("IdentityStaking");
  await upgrades.upgradeProxy(stakingContractAddress, IdentityStaking, {
    kind: "uups",
  });

  console.log(`Upgraded IdentityStaking at: ${stakingContractAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
