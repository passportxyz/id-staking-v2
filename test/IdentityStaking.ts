import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { time, reset } from "@nomicfoundation/hardhat-network-helpers";

function shuffleArray(array: any[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const fiveMinutes = 5 * 60;
const twelveWeeksInSeconds = 12 * 7 * 24 * 60 * 60 + 1; // 12 weeks in seconds

describe("IdentityStaking", function () {
  this.beforeEach(async function () {
    await reset();
    const [ownerAccount, ...userAccounts] = await ethers.getSigners();

    this.owner = ownerAccount;
    this.userAccounts = userAccounts;

    // Note: This contract has been modified such that approvals are not required
    const GTC = await ethers.getContractFactory("GTC", this.owner);
    this.gtc = await GTC.deploy(
      this.owner.address,
      this.owner.address,
      Math.floor(new Date().getTime() / 1000) + 4,
    );
    const gtcAddress = await this.gtc.getAddress();

    const IdentityStaking = await ethers.getContractFactory(
      "IdentityStaking",
      this.owner,
    );
    this.identityStaking = await IdentityStaking.deploy();
    await this.identityStaking
      .connect(this.owner)
      .initialize(
        gtcAddress,
        "0x0000000000000000000000000000000000000001",
        this.owner.address,
        [this.owner.address],
        [this.owner.address],
      );
    for (let i = 0; i < this.userAccounts.length; i++) {
      await this.gtc
        .connect(this.owner)
        .mint(userAccounts[i].address, 100000000000);
    }
  });

  it("end-to-end (gas) tests", async function () {
    // const numUsers = 200;
    const numUsers = 20;
    const userAccounts = this.userAccounts.slice(0, numUsers);

    await Promise.all(
      [this.identityStaking].map(async (identityStaking: any) => {
        const selfStakers: string[] = [];
        const communityStakers: string[] = [];
        const communityStakees: string[] = [];

        await Promise.all(
          userAccounts.map(async (userAccount: any, accountIdx: number) => {
            selfStakers.push(userAccount.address);

            communityStakers.push(userAccount.address);
            communityStakees.push(this.userAccounts[accountIdx + 1].address);

            communityStakers.push(userAccount.address);
            communityStakees.push(
              this.userAccounts[
                accountIdx ? accountIdx - 1 : this.userAccounts.length - 1
              ].address,
            );

            // This changes the order of the transactions
            // which can affect gas. Randomizing to get an
            // average gas cost.
            for (const func of shuffleArray([
              () =>
                identityStaking
                  .connect(userAccount)
                  .selfStake(100000, twelveWeeksInSeconds),

              () =>
                identityStaking
                  .connect(userAccount)
                  .communityStake(
                    this.userAccounts[accountIdx + 1].address,
                    100000,
                    twelveWeeksInSeconds,
                  ),

              () =>
                identityStaking
                  .connect(userAccount)
                  .communityStake(
                    this.userAccounts[
                      accountIdx ? accountIdx - 1 : this.userAccounts.length - 1
                    ].address,
                    100000,
                    twelveWeeksInSeconds,
                  ),
            ])) {
              await func();
            }
          }),
        );

        const slashSelfStakers = selfStakers.slice(0, 20);
        const slashCommunityStakers = communityStakers.slice(0, 40);
        const slashCommunityStakees = communityStakees.slice(0, 40);

        await identityStaking
          .connect(this.owner)
          .slash(
            slashSelfStakers,
            slashCommunityStakers,
            slashCommunityStakees,
            50,
          );

        await identityStaking
          .connect(this.owner)
          .release(selfStakers[0], selfStakers[0], 500, 1);

        await time.increase(60 * 60 * 24 * 91);

        await identityStaking.connect(this.owner).lockAndBurn();
      }),
    );
  }).timeout(1000000);

  it("should reject burns too close together", async function () {
    await time.increase(60 * 60 * 24 * 91);
    await this.identityStaking.connect(this.owner).lockAndBurn();

    await time.increase(60 * 60 * 24 * 89);
    await expect(
      this.identityStaking.connect(this.owner).lockAndBurn(),
    ).to.be.revertedWithCustomError(
      this.identityStaking,
      "MinimumBurnRoundDurationNotMet",
    );
  });

  describe("slashing/releasing/burning tests", function () {
    beforeEach(async function () {
      const userAccounts = this.userAccounts.slice(0, 5);
      const selfStakers: string[] = [];
      const communityStakers: string[] = [];
      const communityStakees: string[] = [];

      await Promise.all(
        userAccounts.map(async (userAccount: any, accountIdx: number) => {
          await this.identityStaking
            .connect(userAccount)
            .selfStake(100000, twelveWeeksInSeconds);
          await this.identityStaking
            .connect(userAccount)
            .communityStake(
              this.userAccounts[accountIdx + 1],
              100000,
              twelveWeeksInSeconds,
            );
          selfStakers.push(userAccount.address);
          communityStakers.push(userAccount.address);
          communityStakees.push(this.userAccounts[accountIdx + 1].address);
        }),
      );

      this.selfStakers = selfStakers;
      this.communityStakers = communityStakers;
      this.communityStakees = communityStakees;
    });

    it("should slash stakes", async function () {
      const startingSelfStakeAmount = (
        await this.identityStaking.selfStakes(this.userAccounts[0])
      )[1];

      const startingCommunityStakeAmount = (
        await this.identityStaking.communityStakes(
          this.userAccounts[0],
          this.userAccounts[1],
        )
      )[1];

      expect(await this.identityStaking.totalSlashed(1)).to.equal(0);

      await this.identityStaking
        .connect(this.owner)
        .slash(
          this.selfStakers.slice(0, 2),
          this.communityStakers.slice(0, 1),
          this.communityStakees.slice(0, 1),
          50,
        );

      const afterSlashSelfStakeAmount = (
        await this.identityStaking.selfStakes(this.userAccounts[0])
      )[1];

      expect(afterSlashSelfStakeAmount).to.equal(
        startingSelfStakeAmount / BigInt(2),
      );
      expect(afterSlashSelfStakeAmount).to.equal(BigInt(50000));

      expect(await this.identityStaking.totalSlashed(1)).to.equal(150000);

      await this.identityStaking
        .connect(this.owner)
        .slash(
          this.selfStakers.slice(0, 2),
          this.communityStakers.slice(0, 1),
          this.communityStakees.slice(0, 1),
          80,
        );

      const afterDoubleSlashSelfStakeAmount = (
        await this.identityStaking.selfStakes(this.userAccounts[0])
      )[1];

      expect(afterDoubleSlashSelfStakeAmount).to.equal(
        startingSelfStakeAmount / BigInt(2) / BigInt(5),
      );
      expect(afterDoubleSlashSelfStakeAmount).to.equal(BigInt(10000));

      const afterSlashCommunityStakeAmount = (
        await this.identityStaking.communityStakes(
          this.userAccounts[0],
          this.userAccounts[1],
        )
      )[1];

      expect(afterSlashCommunityStakeAmount).to.equal(
        startingCommunityStakeAmount / BigInt(2) / BigInt(5),
      );

      expect(afterSlashCommunityStakeAmount).to.equal(BigInt(10000));

      expect(await this.identityStaking.totalSlashed(1)).to.equal(270000);
    });

    it("should release given a valid request", async function () {
      await this.identityStaking
        .connect(this.owner)
        .slash(
          this.selfStakers.slice(0, 3),
          this.communityStakers.slice(0, 3),
          this.communityStakees.slice(0, 3),
          50,
        );

      expect(
        (
          await this.identityStaking.communityStakes(
            this.communityStakers[0],
            this.communityStakees[0],
          )
        ).amount,
      ).to.equal(50000);

      expect(await this.identityStaking.totalSlashed(1)).to.equal(300000);

      await this.identityStaking
        .connect(this.owner)
        .release(this.communityStakers[0], this.communityStakees[0], 250, 1);

      await this.identityStaking
        .connect(this.owner)
        .release(this.communityStakers[0], this.communityStakees[0], 250, 1);

      expect(
        (
          await this.identityStaking.communityStakes(
            this.communityStakers[0],
            this.communityStakees[0],
          )
        ).amount,
      ).to.equal(50500);

      expect(await this.identityStaking.totalSlashed(1)).to.equal(299500);
    });

    it("should reject release for an un-slashed user", async function () {
      await expect(
        this.identityStaking
          .connect(this.owner)
          .release(this.selfStakers[0], this.selfStakers[0], 500, 1),
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "FundsNotAvailableToRelease",
      );
    });

    it("should reject release for too high of an amount", async function () {
      await this.identityStaking
        .connect(this.owner)
        .slash(
          this.selfStakers.slice(0, 3),
          this.communityStakers.slice(0, 3),
          this.communityStakees.slice(0, 3),
          50,
        );

      await expect(
        this.identityStaking
          .connect(this.owner)
          .release(this.selfStakers[0], this.selfStakers[0], 50000000000, 1),
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "FundsNotAvailableToRelease",
      );
    });

    it("should reject release from the wrong round", async function () {
      await this.identityStaking
        .connect(this.owner)
        .slash(
          this.selfStakers.slice(0, 3),
          this.communityStakers.slice(0, 3),
          this.communityStakees.slice(0, 3),
          50,
        );

      expect(await this.identityStaking.currentSlashRound()).to.equal(1);

      // Slashed in round 1, but trying to release from round 0

      await expect(
        this.identityStaking
          .connect(this.owner)
          .release(this.selfStakers[0], this.selfStakers[0], 500, 0),
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "FundsNotAvailableToReleaseFromRound",
      );

      await expect(
        this.identityStaking
          .connect(this.owner)
          .release(this.communityStakees[0], this.communityStakers[1], 500, 0),
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "FundsNotAvailableToReleaseFromRound",
      );
    });

    it("should reject release from burned round", async function () {
      await this.identityStaking
        .connect(this.owner)
        .slash(
          this.selfStakers.slice(0, 3),
          this.communityStakers.slice(0, 3),
          this.communityStakees.slice(0, 3),
          50,
        );

      // Slashed in round 1
      expect(await this.identityStaking.currentSlashRound()).to.equal(1);

      await time.increase(60 * 60 * 24 * 91); // 91 days
      await this.identityStaking.connect(this.owner).lockAndBurn();

      await time.increase(60 * 60 * 24 * 91); // 91 days
      await this.identityStaking.connect(this.owner).lockAndBurn();

      expect(await this.identityStaking.currentSlashRound()).to.equal(3);

      await expect(
        this.identityStaking
          .connect(this.owner)
          .release(this.selfStakers[0], this.selfStakers[0], 500, 1),
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "RoundAlreadyBurned",
      );
    });

    it("should correctly handle 0%, 1%, 100%, and 101% slashes", async function () {
      expect(
        (await this.identityStaking.selfStakes(this.userAccounts[0].address))
          .amount,
      ).to.equal(100000);

      await expect(
        this.identityStaking
          .connect(this.owner)
          .slash([this.userAccounts[0].address], [], [], 0), // 0% slash
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "InvalidSlashPercent",
      );

      await expect(
        this.identityStaking
          .connect(this.owner)
          .slash([this.userAccounts[0].address], [], [], 101), // 101% slash
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "InvalidSlashPercent",
      );

      await expect(
        this.identityStaking.connect(this.owner).slash(
          [this.userAccounts[0].address],
          [],
          [],
          BigInt(2) ** BigInt(88) - BigInt(1), // Max uint88
        ),
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "InvalidSlashPercent",
      );

      expect(
        (await this.identityStaking.selfStakes(this.userAccounts[0].address))
          .amount,
      ).to.equal(100000);

      await this.identityStaking
        .connect(this.owner)
        .slash([this.userAccounts[0].address], [], [], 1); // 0% slash

      expect(
        (await this.identityStaking.selfStakes(this.userAccounts[0].address))
          .amount,
      ).to.equal(99000);

      await this.identityStaking
        .connect(this.owner)
        .slash([this.userAccounts[0].address], [], [], 100); // 100% slash

      expect(
        (await this.identityStaking.selfStakes(this.userAccounts[0].address))
          .amount,
      ).to.equal(0);
    });

    it("should reject slash with mismatched stakee and staker arrays", async function () {
      await expect(
        this.identityStaking
          .connect(this.owner)
          .slash(
            [this.userAccounts[0].address],
            [this.userAccounts[1].address],
            [],
            50,
          ),
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "StakerStakeeMismatch",
      );
    });

    describe("when a user is slashed, then two burns occur, and then user is slashed again", async function () {
      it("should overwrite old, burned slash", async function () {
        const staker = this.userAccounts[0];
        const slashPercent = 50;

        const initialStake = await this.identityStaking.selfStakes(
          staker.address,
        );

        expect(initialStake.amount).to.equal(100000);
        expect(initialStake.slashedAmount).to.equal(0);
        expect(initialStake.slashedInRound).to.equal(0);

        expect(await this.identityStaking.totalSlashed(0)).to.equal(0);
        expect(await this.identityStaking.totalSlashed(1)).to.equal(0);

        // Perform initial slashing
        await this.identityStaking
          .connect(this.owner)
          .slash([staker.address], [], [], slashPercent);

        const slashedStake = await this.identityStaking.selfStakes(
          staker.address,
        );

        expect(slashedStake.amount).to.equal(50000);
        expect(slashedStake.slashedAmount).to.equal(50000);
        expect(slashedStake.slashedInRound).to.equal(1);

        expect(await this.identityStaking.totalSlashed(1)).to.equal(50000);

        // Perform TWO burns
        await time.increase(60 * 60 * 24 * 91); // 91 days

        await expect(this.identityStaking.connect(this.owner).lockAndBurn())
          .to.emit(this.identityStaking, "Burn")
          .withArgs(0, 0);

        await time.increase(60 * 60 * 24 * 91); // 91 days

        await expect(this.identityStaking.connect(this.owner).lockAndBurn())
          .to.emit(this.identityStaking, "Burn")
          .withArgs(1, 50000);

        expect(await this.identityStaking.currentSlashRound()).to.equal(3);

        expect(await this.identityStaking.totalSlashed(0)).to.equal(0);
        expect(await this.identityStaking.totalSlashed(1)).to.equal(50000);
        expect(await this.identityStaking.totalSlashed(2)).to.equal(0);
        expect(await this.identityStaking.totalSlashed(3)).to.equal(0);

        // Perform another slashing
        await this.identityStaking
          .connect(this.owner)
          .slash([staker.address], [], [], slashPercent);

        const newlySlashedStake = await this.identityStaking.selfStakes(
          staker.address,
        );

        expect(newlySlashedStake.amount).to.equal(25000);
        // This is a new slashed amount, NOT added to the previous slashed amount
        expect(newlySlashedStake.slashedAmount).to.equal(25000);
        expect(newlySlashedStake.slashedInRound).to.equal(3);

        // All slashes stay in their rounds
        expect(await this.identityStaking.totalSlashed(0)).to.equal(0);
        expect(await this.identityStaking.totalSlashed(1)).to.equal(50000);
        expect(await this.identityStaking.totalSlashed(2)).to.equal(0);
        expect(await this.identityStaking.totalSlashed(3)).to.equal(25000);

        await time.increase(60 * 60 * 24 * 91); // 91 days

        // Nothing burned this call, because no slash last round
        await expect(this.identityStaking.connect(this.owner).lockAndBurn())
          .to.emit(this.identityStaking, "Burn")
          .withArgs(2, 0);

        await time.increase(60 * 60 * 24 * 91); // 91 days

        // Now, the second slash is burned
        await expect(this.identityStaking.connect(this.owner).lockAndBurn())
          .to.emit(this.identityStaking, "Burn")
          .withArgs(3, 25000);
      });
    });

    describe("when a user is slashed, then one burn occurs, and then user is slashed again", async function () {
      it("should move old, locked slash to current round and update slash totals accordingly", async function () {
        const staker = this.userAccounts[0];
        const slashPercent = 50;

        const initialStake = await this.identityStaking.selfStakes(
          staker.address,
        );

        expect(initialStake.amount).to.equal(100000);
        expect(initialStake.slashedAmount).to.equal(0);
        expect(initialStake.slashedInRound).to.equal(0);

        expect(await this.identityStaking.totalSlashed(0)).to.equal(0);
        expect(await this.identityStaking.totalSlashed(1)).to.equal(0);

        // Perform initial slashing
        await this.identityStaking
          .connect(this.owner)
          .slash([staker.address], [], [], slashPercent);

        const slashedStake = await this.identityStaking.selfStakes(
          staker.address,
        );

        expect(slashedStake.amount).to.equal(50000);
        expect(slashedStake.slashedAmount).to.equal(50000);
        expect(slashedStake.slashedInRound).to.equal(1);

        expect(await this.identityStaking.totalSlashed(1)).to.equal(50000);

        // Perform ONE burn, which does not yet burn the slash we just did
        await time.increase(60 * 60 * 24 * 91); // 91 days

        await expect(this.identityStaking.connect(this.owner).lockAndBurn())
          .to.emit(this.identityStaking, "Burn")
          .withArgs(0, 0);

        expect(await this.identityStaking.currentSlashRound()).to.equal(2);

        expect(await this.identityStaking.totalSlashed(0)).to.equal(0);
        expect(await this.identityStaking.totalSlashed(1)).to.equal(50000);
        expect(await this.identityStaking.totalSlashed(2)).to.equal(0);

        // Perform another slashing
        await this.identityStaking
          .connect(this.owner)
          .slash([staker.address], [], [], slashPercent);

        const reSlashedStake = await this.identityStaking.selfStakes(
          staker.address,
        );

        expect(reSlashedStake.amount).to.equal(25000);
        // This user was slashed last round, so the whole slash is moved to the current round
        expect(reSlashedStake.slashedAmount).to.equal(75000);
        expect(reSlashedStake.slashedInRound).to.equal(2);

        // 50000 from round 1 and new 25000 from round 2 all in round 2
        expect(await this.identityStaking.totalSlashed(0)).to.equal(0);
        expect(await this.identityStaking.totalSlashed(1)).to.equal(0);
        expect(await this.identityStaking.totalSlashed(2)).to.equal(75000);

        await time.increase(60 * 60 * 24 * 91); // 91 days

        // Nothing burned this call, because all slash moved to the current round
        await expect(this.identityStaking.connect(this.owner).lockAndBurn())
          .to.emit(this.identityStaking, "Burn")
          .withArgs(1, 0);

        await time.increase(60 * 60 * 24 * 91); // 91 days

        // Now, the whole slash is burned
        await expect(this.identityStaking.connect(this.owner).lockAndBurn())
          .to.emit(this.identityStaking, "Burn")
          .withArgs(2, 75000);
      });
    });
  });

  describe("self and community staking", function () {
    it("should allow self staking", async function () {
      const unlockTime =
        twelveWeeksInSeconds + Math.floor(new Date().getTime() / 1000);

      await this.identityStaking
        .connect(this.userAccounts[0])
        .selfStake(100000n, twelveWeeksInSeconds);

      const stake = await this.identityStaking.selfStakes(this.userAccounts[0]);

      expect(stake[0]).to.be.closeTo(unlockTime, fiveMinutes);
      expect(stake[1]).to.deep.equal(100000n);
      expect(stake[2]).to.deep.equal(0n);
      expect(stake[3]).to.deep.equal(0n);
    });

    it("should allow withdrawal of self stake", async function () {
      await this.identityStaking
        .connect(this.userAccounts[0])
        .selfStake(100000n, twelveWeeksInSeconds);

      await time.increase(twelveWeeksInSeconds + 1);

      const contractAddress = await this.identityStaking.getAddress();

      expect(await this.gtc.balanceOf(this.userAccounts[0].address)).to.equal(
        100000000000 - 100000,
      );
      expect(await this.gtc.balanceOf(contractAddress)).to.equal(100000);

      await this.identityStaking
        .connect(this.userAccounts[0])
        .withdrawSelfStake(1);

      expect(await this.gtc.balanceOf(this.userAccounts[0])).to.equal(
        100000000000 - 100000 + 1,
      );
      expect(await this.gtc.balanceOf(contractAddress)).to.equal(99999);
      expect(
        (await this.identityStaking.selfStakes(this.userAccounts[0])).amount,
      ).to.equal(99999);
    });

    it("should allow community staking", async function () {
      const unlockTime =
        twelveWeeksInSeconds + Math.floor(new Date().getTime() / 1000);

      await this.identityStaking
        .connect(this.userAccounts[0])
        .communityStake(this.userAccounts[1], 100000n, twelveWeeksInSeconds);

      const stake = await this.identityStaking.communityStakes(
        this.userAccounts[0],
        this.userAccounts[1],
      );

      expect(stake[0]).to.be.closeTo(unlockTime, fiveMinutes);
      expect(stake[1]).to.deep.equal(100000n);
      expect(stake[2]).to.deep.equal(0n);
      expect(stake[3]).to.deep.equal(0n);
    });

    it("should allow withdrawal of community stake", async function () {
      await this.identityStaking
        .connect(this.userAccounts[0])
        .communityStake(this.userAccounts[1], 100000n, twelveWeeksInSeconds);

      const contractAddress = await this.identityStaking.getAddress();

      expect(await this.gtc.balanceOf(this.userAccounts[0].address)).to.equal(
        100000000000 - 100000,
      );
      expect(await this.gtc.balanceOf(contractAddress)).to.equal(100000);

      await time.increase(twelveWeeksInSeconds + 1);

      await this.identityStaking
        .connect(this.userAccounts[0])
        .withdrawCommunityStake(this.userAccounts[1], 100000n);

      expect(await this.gtc.balanceOf(this.userAccounts[0])).to.equal(
        100000000000,
      );
      expect(await this.gtc.balanceOf(contractAddress)).to.equal(0);
      expect(
        (
          await this.identityStaking.communityStakes(
            this.userAccounts[0],
            this.userAccounts[1],
          )
        ).amount,
      ).to.equal(0);
    });

    it("should extend the unlock time for self stake", async function () {
      const initialDuration = 12 * 7 * 24 * 60 * 60; // 12 weeks in seconds
      const newDuration = 24 * 7 * 24 * 60 * 60; // 24 weeks in seconds
      const user = this.userAccounts[0];

      // First, create a stake
      await this.identityStaking
        .connect(user)
        .selfStake(100000, initialDuration);

      // Extend the stake
      await this.identityStaking.connect(user).extendSelfStake(newDuration);

      // Check if the stake was extended correctly
      const stake = await this.identityStaking.selfStakes(user.address);
      expect(stake.unlockTime).to.be.closeTo(
        newDuration + Math.floor(new Date().getTime() / 1000),
        fiveMinutes,
      );
    });

    it("should handle edge case for extending self stake", async function () {
      const user = this.userAccounts[0];
      await this.identityStaking
        .connect(user)
        .selfStake(100000, 12 * 7 * 24 * 60 * 60); // 12 weeks

      // Extend to the maximum allowed duration (104 weeks)
      await this.identityStaking
        .connect(user)
        .extendSelfStake(104 * 7 * 24 * 60 * 60);

      // Check if the stake was extended correctly
      const stake = await this.identityStaking.selfStakes(user.address);
      expect(stake.unlockTime).to.be.closeTo(
        104 * 7 * 24 * 60 * 60 + Math.floor(new Date().getTime() / 1000),
        fiveMinutes,
      );
    });

    it("should extend the unlock time for community stake", async function () {
      const initialDuration = 12 * 7 * 24 * 60 * 60; // 12 weeks
      const newDuration = 24 * 7 * 24 * 60 * 60; // 24 weeks
      const staker = this.userAccounts[0];
      const stakee = this.userAccounts[1];

      // First, create a stake
      await this.identityStaking
        .connect(staker)
        .communityStake(stakee.address, 100000, initialDuration);

      // Extend the stake
      await this.identityStaking
        .connect(staker)
        .extendCommunityStake(stakee.address, newDuration);

      // Check if the stake was extended correctly
      const stake = await this.identityStaking.communityStakes(
        staker.address,
        stakee.address,
      );
      expect(stake.unlockTime).to.be.closeTo(
        newDuration + Math.floor(new Date().getTime() / 1000),
        fiveMinutes,
      );
    });

    it("should handle edge case for extending community stake", async function () {
      const staker = this.userAccounts[0];
      const stakee = this.userAccounts[1];
      await this.identityStaking
        .connect(staker)
        .communityStake(stakee.address, 100000, 12 * 7 * 24 * 60 * 60); // 12 weeks

      // Extend to the maximum allowed duration (104 weeks)
      await this.identityStaking
        .connect(staker)
        .extendCommunityStake(stakee.address, 104 * 7 * 24 * 60 * 60);

      // Check if the stake was extended correctly
      const stake = await this.identityStaking.communityStakes(
        staker.address,
        stakee.address,
      );
      expect(stake.unlockTime).to.be.closeTo(
        104 * 7 * 24 * 60 * 60 + Math.floor(new Date().getTime() / 1000),
        fiveMinutes,
      );
    });

    describe("failed stake tests", function () {
      it("should revert when community staking on the zero address", async function () {
        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .communityStake(
              "0x0000000000000000000000000000000000000000",
              100000,
              twelveWeeksInSeconds,
            ),
        ).to.be.revertedWithCustomError(
          this.identityStaking,
          "AddressCannotBeZero",
        );
      });

      it("should reject self stake with invalid unlock time", async function () {
        const unlockTime = Math.floor(new Date().getTime() / 1000) - 1000;

        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .selfStake(100000, unlockTime),
        ).to.be.revertedWithCustomError(
          this.identityStaking,
          "InvalidLockTime",
        );
      });

      it("should reject community stake with invalid unlock time", async function () {
        const unlockTime = Math.floor(new Date().getTime() / 1000) - 1000;

        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .communityStake(this.userAccounts[1], 100000, unlockTime),
        ).to.be.revertedWithCustomError(
          this.identityStaking,
          "InvalidLockTime",
        );
      });

      it("should reject self stake with amount 0", async function () {
        const unlockTime = Math.floor(new Date().getTime() / 1000) + 1000000000;

        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .selfStake(0, unlockTime),
        ).to.be.revertedWithCustomError(
          this.identityStaking,
          "AmountMustBeGreaterThanZero",
        );
      });

      it("should reject community stake with amount 0", async function () {
        const unlockTime = Math.floor(new Date().getTime() / 1000) + 1000000000;

        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .communityStake(this.userAccounts[1], 0, unlockTime),
        ).to.be.revertedWithCustomError(
          this.identityStaking,
          "AmountMustBeGreaterThanZero",
        );
      });

      it("should reject extending non-existent self stake", async function () {
        await expect(
          this.identityStaking
            .connect(this.owner)
            .extendSelfStake(12 * 7 * 24 * 60 * 60), // 12 weeks
        ).to.be.revertedWithCustomError(
          this.identityStaking,
          "AmountMustBeGreaterThanZero",
        );
      });

      it("should reject extending non-existent community stake", async function () {
        await expect(
          this.identityStaking
            .connect(this.owner)
            .extendCommunityStake(this.userAccounts[1], 12 * 7 * 24 * 60 * 60), // 12 weeks
        ).to.be.revertedWithCustomError(
          this.identityStaking,
          "AmountMustBeGreaterThanZero",
        );
      });

      it("should reject community stake on self", async function () {
        const unlockTime = Math.floor(new Date().getTime() / 1000) + 1000000000;

        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .communityStake(this.userAccounts[0], 100000, unlockTime),
        ).to.be.revertedWithCustomError(
          this.identityStaking,
          "CannotStakeOnSelf",
        );
      });

      it("should reject self stake with a shorter duration than existing stake", async function () {
        await this.identityStaking
          .connect(this.userAccounts[0])
          .selfStake(100000, 24 * 7 * 24 * 60 * 60); // 24 weeks

        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .selfStake(100000, 12 * 7 * 24 * 60 * 60), // 12 weeks
        ).to.be.revertedWithCustomError(
          this.identityStaking,
          "InvalidLockTime",
        );
      });

      it("should reject community stake with a shorter duration than existing stake", async function () {
        await this.identityStaking
          .connect(this.userAccounts[0])
          .communityStake(this.userAccounts[1], 100000, 24 * 7 * 24 * 60 * 60); // 24 weeks

        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .communityStake(
              this.userAccounts[1],
              100000,
              12 * 7 * 24 * 60 * 60,
            ), // 12 weeks
        ).to.be.revertedWithCustomError(
          this.identityStaking,
          "InvalidLockTime",
        );
      });

      it("should fail to extend self stake to a shorter duration", async function () {
        const user = this.userAccounts[0];
        await this.identityStaking
          .connect(user)
          .selfStake(100000, 24 * 7 * 24 * 60 * 60); // 24 weeks

        // Attempt to extend the stake to a shorter duration (12 weeks)
        await expect(
          this.identityStaking
            .connect(user)
            .extendSelfStake(12 * 7 * 24 * 60 * 60),
        ).to.be.revertedWithCustomError(
          this.identityStaking,
          "InvalidLockTime",
        );
      });

      it("should not allow withdrawal of self stake before unlock time", async function () {
        await this.identityStaking
          .connect(this.userAccounts[0])
          .selfStake(100000n, twelveWeeksInSeconds);

        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .withdrawSelfStake(1),
        ).to.be.revertedWithCustomError(this.identityStaking, "StakeIsLocked");
      });

      it("should not allow withdrawal of community stake before unlock time", async function () {
        await this.identityStaking
          .connect(this.userAccounts[0])
          .communityStake(this.userAccounts[1], 100000n, twelveWeeksInSeconds);

        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .withdrawCommunityStake(this.userAccounts[1], 100000n),
        ).to.be.revertedWithCustomError(this.identityStaking, "StakeIsLocked");
      });

      it("should not allow withdrawal exceeding self stake amount", async function () {
        await time.increase(twelveWeeksInSeconds + 1);

        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .withdrawSelfStake(100001),
        ).to.be.revertedWithCustomError(this.identityStaking, "AmountTooHigh");
      });

      it("should not allow withdrawal exceeding community stake amount", async function () {
        await time.increase(twelveWeeksInSeconds + 1);

        await expect(
          this.identityStaking
            .connect(this.userAccounts[0])
            .withdrawCommunityStake(this.userAccounts[1], 100001),
        ).to.be.revertedWithCustomError(this.identityStaking, "AmountTooHigh");
      });
    });
  });

  it("should allow transfer of ownership", async function () {
    const adminRole = await this.identityStaking.DEFAULT_ADMIN_ROLE();

    // Transfer ownership by granting and revoking admin role

    expect(await this.identityStaking.hasRole(adminRole, this.owner.address)).to
      .be.true;

    await expect(
      this.identityStaking
        .connect(this.owner)
        .grantRole(adminRole, this.userAccounts[0].address),
    )
      .to.emit(this.identityStaking, "RoleGranted")
      .withArgs(adminRole, this.userAccounts[0].address, this.owner.address);

    expect(
      await this.identityStaking.hasRole(
        adminRole,
        this.userAccounts[0].address,
      ),
    ).to.be.true;

    await this.identityStaking
      .connect(this.userAccounts[0])
      .revokeRole(adminRole, this.owner.address);

    expect(await this.identityStaking.hasRole(adminRole, this.owner.address)).to
      .be.false;

    // Check that admin privileges are transferred

    const releaserRole = await this.identityStaking.RELEASER_ROLE();

    await expect(
      this.identityStaking
        .connect(this.userAccounts[0])
        .grantRole(releaserRole, this.userAccounts[1].address),
    ).to.not.be.reverted;

    expect(
      await this.identityStaking.hasRole(
        releaserRole,
        this.userAccounts[1].address,
      ),
    ).to.be.true;

    await expect(
      this.identityStaking
        .connect(this.owner)
        .grantRole(releaserRole, this.userAccounts[2].address),
    ).to.be.reverted;

    expect(
      await this.identityStaking.hasRole(
        releaserRole,
        this.userAccounts[2].address,
      ),
    ).to.be.false;
  });

  describe("role tests", async function () {
    it("should fail to slash without SLASHER_ROLE", async function () {
      const nonSlasher = this.userAccounts[0];
      await expect(
        this.identityStaking.connect(nonSlasher).slash([], [], [], 50),
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("should fail to release funds without RELEASER_ROLE", async function () {
      const nonReleaser = this.userAccounts[0];
      await expect(
        this.identityStaking
          .connect(nonReleaser)
          .release(nonReleaser.address, nonReleaser.address, 100, 1),
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("should fail to pause without DEFAULT_ADMIN_ROLE", async function () {
      const nonAdmin = this.userAccounts[0];
      await expect(
        this.identityStaking.connect(nonAdmin).pause(),
      ).to.be.revertedWithCustomError(
        this.identityStaking,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("pause tests", function () {
    it("should pause and unpause the contract", async function () {
      await expect(this.identityStaking.connect(this.owner).pause()).to.emit(
        this.identityStaking,
        "Paused",
      );
      expect(await this.identityStaking.paused()).to.be.true;

      await expect(this.identityStaking.connect(this.owner).unpause()).to.emit(
        this.identityStaking,
        "Unpaused",
      );

      expect(await this.identityStaking.paused()).to.be.false;
    });

    it("should revert when paused", async function () {
      await this.identityStaking.connect(this.owner).pause();

      await expect(
        this.identityStaking
          .connect(this.userAccounts[0])
          .selfStake(100000, twelveWeeksInSeconds),
      ).to.be.revertedWithCustomError(this.identityStaking, "EnforcedPause");

      await expect(
        this.identityStaking
          .connect(this.userAccounts[0])
          .communityStake(
            this.userAccounts[1].address,
            100000,
            twelveWeeksInSeconds,
          ),
      ).to.be.revertedWithCustomError(this.identityStaking, "EnforcedPause");

      await expect(
        this.identityStaking
          .connect(this.owner)
          .slash(
            [this.userAccounts[0].address],
            [this.userAccounts[0].address],
            [this.userAccounts[0].address],
            50,
          ),
      ).to.be.revertedWithCustomError(this.identityStaking, "EnforcedPause");

      await expect(
        this.identityStaking
          .connect(this.owner)
          .release(
            this.userAccounts[0].address,
            this.userAccounts[0].address,
            100000,
            1,
          ),
      ).to.be.revertedWithCustomError(this.identityStaking, "EnforcedPause");

      await expect(
        this.identityStaking.connect(this.userAccounts[0]).lockAndBurn(),
      ).to.be.revertedWithCustomError(this.identityStaking, "EnforcedPause");

      await expect(
        this.identityStaking.connect(this.userAccounts[0]).withdrawSelfStake(1),
      ).to.be.revertedWithCustomError(this.identityStaking, "EnforcedPause");

      await expect(
        this.identityStaking
          .connect(this.userAccounts[0])
          .withdrawCommunityStake(this.userAccounts[1].address, 100000),
      ).to.be.revertedWithCustomError(this.identityStaking, "EnforcedPause");

      await expect(
        this.identityStaking.connect(this.userAccounts[0]).extendSelfStake(1),
      ).to.be.revertedWithCustomError(this.identityStaking, "EnforcedPause");

      await expect(
        this.identityStaking
          .connect(this.userAccounts[0])
          .extendCommunityStake(this.userAccounts[1].address, 100000),
      ).to.be.revertedWithCustomError(this.identityStaking, "EnforcedPause");
    });
  });

  describe("upgrades", function () {
    beforeEach(async function () {
      const IdentityStaking =
        await ethers.getContractFactory("IdentityStaking");

      this.originalContract = await upgrades.deployProxy(
        IdentityStaking,
        [
          "0x0000000000000000000000000000000000000001",
          "0x0000000000000000000000000000000000000002",
          this.owner.address,
          [this.owner.address],
          [this.owner.address],
        ],
        { kind: "uups" },
      );

      this.originalContractAddress = await this.originalContract.getAddress();
    });

    it("should upgrade the contract successfully", async function () {
      const UpgradedContract = await ethers.getContractFactory(
        "Upgrade",
        this.owner,
      );

      const upgradedContract = await upgrades.upgradeProxy(
        this.originalContractAddress,
        UpgradedContract,
      );

      expect(await upgradedContract.newFunction()).to.equal("Hello, World!");

      expect(await upgradedContract.getAddress()).to.equal(
        this.originalContractAddress,
      );
    });

    it("should not allow anyone besides owner to upgrade the contract", async function () {
      const UpgradedContract = await ethers.getContractFactory(
        "Upgrade",
        // This is the deployer for the new contract
        this.userAccounts[0],
      );

      await expect(
        upgrades.upgradeProxy(this.originalContractAddress, UpgradedContract),
      ).to.be.revertedWithCustomError(
        this.originalContract,
        "AccessControlUnauthorizedAccount",
      );
    });
  });
});

it("should handle staking full GTC supply", async function () {
  const maxStakeAmount = 100000000000000000000000000n; // 100 million GTC

  const [ownerAccount, ...userAccounts] = await ethers.getSigners();

  this.owner = ownerAccount;
  this.userAccounts = userAccounts;

  const GTC = await ethers.getContractFactory("GTC", this.owner);
  this.gtc = await GTC.deploy(
    this.userAccounts[0].address,
    this.owner.address,
    Math.floor(new Date().getTime() / 1000) + 4,
  );
  const gtcAddress = await this.gtc.getAddress();

  const IdentityStaking = await ethers.getContractFactory(
    "IdentityStaking",
    this.owner,
  );
  this.identityStaking = await IdentityStaking.deploy();

  await this.identityStaking
    .connect(this.owner)
    .initialize(
      gtcAddress,
      "0x0000000000000000000000000000000000000001",
      this.owner.address,
      [this.owner.address],
      [this.owner.address],
    );

  await expect(
    this.identityStaking
      .connect(this.userAccounts[0])
      .selfStake(maxStakeAmount, twelveWeeksInSeconds),
  )
    .to.emit(this.identityStaking, "SelfStake")
    .withArgs(this.userAccounts[0].address, maxStakeAmount, (unlockTime: any) =>
      expect(unlockTime).to.be.closeTo(
        Math.floor(Date.now() / 1000) + twelveWeeksInSeconds,
        fiveMinutes,
      ),
    );
});
