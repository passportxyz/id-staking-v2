import { ethers, upgrades } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const TESTING = true;

async function main() {
  const accounts = await ethers.getSigners();
  const owner = accounts[0];
  const user = accounts[1];
  const other_user = accounts[2];

  const GTC = await ethers.getContractFactory("GTC");

  let gtc;
  if (TESTING) {
    gtc = await GTC.deploy(owner.address, owner.address, 0);
    await gtc.mint(user.address, ethers.parseEther("1000000"));
    await gtc.mint(other_user.address, ethers.parseEther("1000000"));
  } else {
    gtc = GTC.attach(process.env.GTC_ADDRESS as string);
  }

  const IdentityStaking = await ethers.getContractFactory("IdentityStaking");
  const identityStaking = await upgrades.deployProxy(
    IdentityStaking,
    [
      await gtc.getAddress(),
      await gtc.getAddress(),
      owner.address,
      [owner.address],
      [owner.address],
    ],
    {
      kind: "uups",
    },
  );

  const deployment = await identityStaking.waitForDeployment();

  console.log(`Deployed IdentityStaking to: ${await deployment.getAddress()}`);

  if (TESTING) {
    const twelve_weeks = 60 * 60 * 24 * 7 * 12;
    await await identityStaking
      .connect(user)
      .selfStake(ethers.parseEther("10"), twelve_weeks);
    await await identityStaking
      .connect(user)
      .selfStake(ethers.parseEther("5"), twelve_weeks);
    await await identityStaking
      .connect(other_user)
      .selfStake(ethers.parseEther("5"), twelve_weeks);
    await await identityStaking
      .connect(other_user)
      .communityStake(user, ethers.parseEther("5"), twelve_weeks);
    await await identityStaking
      .connect(owner)
      .slash([user], [other_user], [user], 25);

    await await identityStaking
      .connect(owner)
      .release(other_user, user, ethers.parseEther("1"), 1);

    await time.increase(twelve_weeks + 1);

    await await identityStaking
      .connect(user)
      .withdrawSelfStake(ethers.parseEther("10"));
    await await identityStaking
      .connect(other_user)
      .withdrawCommunityStake(user, ethers.parseEther("2"));

    await await identityStaking.connect(user).extendSelfStake(twelve_weeks * 2);
    await await identityStaking
      .connect(other_user)
      .extendCommunityStake(user, twelve_weeks);

    // Should result in
    // self stake for user = .75(10 + 5) - 1 - 10 = 1.25, unlock in 36 weeks
    // self stake for other_user = 5, unlocks in 12 weeks
    // community stake by other_user on user = .75(5) + 1 - 2 = 2.75, unlocks in 24 weeks
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
