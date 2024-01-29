import { expect } from "chai";
import { ethers } from "hardhat";
import { time, reset } from "@nomicfoundation/hardhat-network-helpers";
import { keccak256 } from "ethers";

function shuffleArray(array: any[]) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

const fiveMinutes = 5 * 60;
const twelveWeeksInSeconds = 12 * 7 * 24 * 60 * 60 + 1; // 12 weeks in seconds

function makeSlashProof(slashMembers: any[][], slashNonce: string) {
  const slashProof = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        {
          type: "tuple[]",
          name: "SlashMember",
          components: [
            {
              name: "account",
              type: "address",
              baseType: "address",
            },
            {
              name: "amount",
              type: "uint192",
              baseType: "uint192",
            },
          ],
        },
        "bytes32",
      ],
      [slashMembers, slashNonce]
    )
  );

  return slashProof;
}

describe("GitcoinIdentityStaking", function () {
  this.beforeEach(async function () {
    await reset();
    const [ownerAccount, ...userAccounts] = await ethers.getSigners();

    this.owner = ownerAccount;
    this.userAccounts = userAccounts;

    const GTC = await ethers.getContractFactory("GTC", this.owner);
    this.gtc = await GTC.deploy(
      this.owner.address,
      this.owner.address,
      Math.floor(new Date().getTime() / 1000) + 4
    );
    const gtcAddress = await this.gtc.getAddress();

    const GitcoinIdentityStaking = await ethers.getContractFactory(
      "GitcoinIdentityStaking",
      this.owner
    );
    this.gitcoinIdentityStaking = await GitcoinIdentityStaking.deploy();
    await this.gitcoinIdentityStaking
      .connect(this.owner)
      .initialize(gtcAddress, "0x0000000000000000000000000000000000000001");

    for (let i = 0; i < this.userAccounts.length; i++) {
      await this.gtc
        .connect(this.owner)
        .mint(userAccounts[i].address, 100000000000);
    }
  });

  it("gas tests", async function () {
    // const numUsers = 200;
    const numUsers = 20;
    const userAccounts = this.userAccounts.slice(0, numUsers);

    await Promise.all(
      [this.gitcoinIdentityStaking].map(async (gitcoinIdentityStaking: any) => {
        gitcoinIdentityStaking.grantRole(
          await gitcoinIdentityStaking.SLASHER_ROLE(),
          this.owner.address
        );
        gitcoinIdentityStaking.grantRole(
          await gitcoinIdentityStaking.RELEASER_ROLE(),
          this.owner.address
        );

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
              ].address
            );

            // This changes the order of the transactions
            // which can affect gas. Randomizing to get an
            // average gas cost.
            for (const func of shuffleArray([
              () =>
                gitcoinIdentityStaking
                  .connect(userAccount)
                  .selfStake(100000, twelveWeeksInSeconds),

              () =>
                gitcoinIdentityStaking
                  .connect(userAccount)
                  .communityStake(
                    this.userAccounts[accountIdx + 1].address,
                    100000,
                    twelveWeeksInSeconds
                  ),

              () =>
                gitcoinIdentityStaking
                  .connect(userAccount)
                  .communityStake(
                    this.userAccounts[
                      accountIdx ? accountIdx - 1 : this.userAccounts.length - 1
                    ].address,
                    100000,
                    twelveWeeksInSeconds
                  ),
            ])) {
              await func();
            }
          })
        );

        const slashSelfStakers = selfStakers.slice(0, 20);
        const slashCommunityStakers = communityStakers.slice(0, 40);
        const slashCommunityStakees = communityStakees.slice(0, 40);

        await gitcoinIdentityStaking
          .connect(this.owner)
          .slash(
            slashSelfStakers,
            slashCommunityStakers,
            slashCommunityStakees,
            50
          );

        await gitcoinIdentityStaking
          .connect(this.owner)
          .release(selfStakers[0], selfStakers[0], 500, 1);

        await time.increase(60 * 60 * 24 * 91);

        await gitcoinIdentityStaking.connect(this.owner).lockAndBurn();
      })
    );
  }).timeout(1000000);

  it("should reject burns too close together", async function () {
    await time.increase(60 * 60 * 24 * 91);
    await this.gitcoinIdentityStaking.connect(this.owner).lockAndBurn();
    await expect(
      this.gitcoinIdentityStaking.connect(this.owner).lockAndBurn()
    ).to.be.revertedWithCustomError(
      this.gitcoinIdentityStaking,
      "MinimumBurnRoundDurationNotMet"
    );
  });

  describe("failed stake tests", function () {
    it("should reject self stake with invalid unlock time", async function () {
      const unlockTime = Math.floor(new Date().getTime() / 1000) - 1000;

      await expect(
        this.gitcoinIdentityStaking
          .connect(this.userAccounts[0])
          .selfStake(100000, unlockTime)
      ).to.be.revertedWithCustomError(
        this.gitcoinIdentityStaking,
        "InvalidLockTime"
      );
    });

    it("should reject community stake with invalid unlock time", async function () {
      const unlockTime = Math.floor(new Date().getTime() / 1000) - 1000;

      await expect(
        this.gitcoinIdentityStaking
          .connect(this.userAccounts[0])
          .communityStake(this.userAccounts[1], 100000, unlockTime)
      ).to.be.revertedWithCustomError(
        this.gitcoinIdentityStaking,
        "InvalidLockTime"
      );
    });

    it("should reject self stake with amount 0", async function () {
      const unlockTime = Math.floor(new Date().getTime() / 1000) + 1000000000;

      await expect(
        this.gitcoinIdentityStaking
          .connect(this.userAccounts[0])
          .selfStake(0, unlockTime)
      ).to.be.revertedWithCustomError(
        this.gitcoinIdentityStaking,
        "AmountMustBeGreaterThanZero"
      );
    });

    it("should reject community stake with amount 0", async function () {
      const unlockTime = Math.floor(new Date().getTime() / 1000) + 1000000000;

      await expect(
        this.gitcoinIdentityStaking
          .connect(this.userAccounts[0])
          .communityStake(this.userAccounts[1], 0, unlockTime)
      ).to.be.revertedWithCustomError(
        this.gitcoinIdentityStaking,
        "AmountMustBeGreaterThanZero"
      );
    });

    it("should reject community stake on self", async function () {
      const unlockTime = Math.floor(new Date().getTime() / 1000) + 1000000000;

      await expect(
        this.gitcoinIdentityStaking
          .connect(this.userAccounts[0])
          .communityStake(this.userAccounts[0], 100000, unlockTime)
      ).to.be.revertedWithCustomError(
        this.gitcoinIdentityStaking,
        "CannotStakeOnSelf"
      );
    });
  });

  describe.only("standard tests", function () {
    beforeEach(async function () {
      const userAccounts = this.userAccounts.slice(0, 5);
      this.gitcoinIdentityStaking.grantRole(
        await this.gitcoinIdentityStaking.SLASHER_ROLE(),
        this.owner.address
      );
      this.gitcoinIdentityStaking.grantRole(
        await this.gitcoinIdentityStaking.RELEASER_ROLE(),
        this.owner.address
      );

      await Promise.all(
        userAccounts.map(async (userAccount: any, accountIdx: number) => {
          await this.gitcoinIdentityStaking
            .connect(userAccount)
            .selfStake(100000, twelveWeeksInSeconds);
          await this.gitcoinIdentityStaking
            .connect(userAccount)
            .communityStake(
              this.userAccounts[accountIdx + 1],
              100000,
              twelveWeeksInSeconds
            );
        })
      );
    });

    it("should slash stakes", async function () {
      const stakeIds = [1, 2, 3];

      const startingStakeAmount = (
        await this.gitcoinIdentityStaking.stakes(stakeIds[0])
      )[0];

      await this.gitcoinIdentityStaking
        .connect(this.owner)
        .slash(stakeIds, 50, ethers.keccak256(Buffer.from("notARealProof")));

      const afterSlashStakeAmount = (
        await this.gitcoinIdentityStaking.stakes(stakeIds[0])
      )[0];

      expect(afterSlashStakeAmount).to.equal(startingStakeAmount / BigInt(2));
      expect(afterSlashStakeAmount).to.equal(BigInt(50000));

      await this.gitcoinIdentityStaking
        .connect(this.owner)
        .slash(stakeIds, 80, ethers.keccak256(Buffer.from("anotherFakeProof")));

      const afterDoubleSlashStakeAmount = (
        await this.gitcoinIdentityStaking.stakes(stakeIds[0])
      )[0];

      expect(afterDoubleSlashStakeAmount).to.equal(
        startingStakeAmount / BigInt(2) / BigInt(5)
      );
      expect(afterDoubleSlashStakeAmount).to.equal(BigInt(10000));
    });

    it("should reject slash with already used proof", async function () {
      const stakeIds = [1, 2, 3];

      const proof = ethers.keccak256(Buffer.from("notARealProof"));

      await this.gitcoinIdentityStaking
        .connect(this.owner)
        .slash(stakeIds, 50, proof);

      await expect(
        this.gitcoinIdentityStaking
          .connect(this.owner)
          .slash(stakeIds, 50, proof)
      ).to.be.revertedWithCustomError(
        this.gitcoinIdentityStaking,
        "SlashProofHashAlreadyUsed"
      );
    });

    describe("with valid slashMembers", function () {
      beforeEach(async function () {
        const selfStakers: string[] = [];
        const communityStakers: string[] = [];
        const communityStakees: string[] = [];

        await Promise.all(
          this.userAccounts
            .slice(0, 3)
            .map(async (userAccount: any, index: number) => {
              selfStakers.push(userAccount.address);

              communityStakers.push(userAccount.address);
              communityStakees.push(this.userAccounts[index + 1].address);

              communityStakers.push(userAccount.address);
              communityStakees.push(
                this.userAccounts[
                  index ? index - 1 : this.userAccounts.length - 1
                ].address
              );
            })
        );

        this.selfStakers = selfStakers;
        this.communityStakers = communityStakers;
        this.communityStakees = communityStakees;
      });

      it("should release given a valid proof", async function () {
        await this.gitcoinIdentityStaking
          .connect(this.owner)
          .slash(
            this.selfStakers,
            this.communityStakers,
            this.communityStakees,
            50
          );

        await this.gitcoinIdentityStaking
          .connect(this.owner)
          .release(this.communityStakers[0], this.communityStakees[0], 250);

        await this.gitcoinIdentityStaking
          .connect(this.owner)
          .release(this.communityStakers[0], this.communityStakees[0], 250);
      });

      it("should reject release for an un-slashed user", async function () {
        await expect(
          this.gitcoinIdentityStaking
            .connect(this.owner)
            .release(this.selfStakers[0], this.selfStakers[0], 500)
        ).to.be.revertedWithCustomError(
          this.gitcoinIdentityStaking,
          "FundsNotAvailableToRelease"
        );
      });

      it("should reject release for too high of an amount", async function () {
        await this.gitcoinIdentityStaking
          .connect(this.owner)
          .slash(
            this.selfStakers,
            this.communityStakers,
            this.communityStakees,
            50
          );

        await expect(
          this.gitcoinIdentityStaking
            .connect(this.owner)
            .release(this.selfStakers[0], this.selfStakers[0], 500000000000)
        ).to.be.revertedWithCustomError(
          this.gitcoinIdentityStaking,
          "FundsNotAvailableToRelease"
        );
      });
    });
  });

  describe("Self and Community Staking", function () {
    it("should allow self staking", async function () {
      const fiveMinutes = 5 * 60; // 5 minutes in seconds
      const unlockTime =
        twelveWeeksInSeconds + Math.floor(new Date().getTime() / 1000);

      await this.gitcoinIdentityStaking
        .connect(this.userAccounts[0])
        .selfStake(100000n, twelveWeeksInSeconds);

      const stake = await this.gitcoinIdentityStaking.selfStakes(
        this.userAccounts[0]
      );

      expect(stake[0]).to.be.closeTo(unlockTime, fiveMinutes);
      expect(stake[1]).to.deep.equal(100000n);
      expect(stake[2]).to.deep.equal(0n);
      expect(stake[3]).to.deep.equal(0n);
    });

    it("should allow withdrawal of self stake", async function () {
      await this.gitcoinIdentityStaking
        .connect(this.userAccounts[0])
        .selfStake(100000n, twelveWeeksInSeconds);

      await time.increase(twelveWeeksInSeconds + 1);

      await this.gitcoinIdentityStaking
        .connect(this.userAccounts[0])
        .withdrawSelfStake(1);

      // TODO check balances
    });

    it("should allow community staking", async function () {
      const unlockTime =
        twelveWeeksInSeconds + Math.floor(new Date().getTime() / 1000);
      await this.gitcoinIdentityStaking
        .connect(this.userAccounts[0])
        .communityStake(this.userAccounts[1], 100000n, twelveWeeksInSeconds);

      const stake = await this.gitcoinIdentityStaking.communityStakes(
        this.userAccounts[0],
        this.userAccounts[1]
      );

      expect(stake[0]).to.be.closeTo(unlockTime, fiveMinutes);
      expect(stake[1]).to.deep.equal(100000n);
      expect(stake[2]).to.deep.equal(0n);
      expect(stake[3]).to.deep.equal(0n);
    });

    it("should allow withdrawal of community stake", async function () {
      await this.gitcoinIdentityStaking
        .connect(this.userAccounts[0])
        .communityStake(this.userAccounts[1], 100000n, twelveWeeksInSeconds);

      await time.increase(twelveWeeksInSeconds + 1);

      await this.gitcoinIdentityStaking
        .connect(this.userAccounts[0])
        .withdrawCommunityStake(this.userAccounts[1], 100000n);

      // TODO check balances
    });
    it("should not allow withdrawal of self stake before unlock time", async function () {
      await this.gitcoinIdentityStaking
        .connect(this.userAccounts[0])
        .selfStake(100000n, twelveWeeksInSeconds);

      await expect(
        this.gitcoinIdentityStaking
          .connect(this.userAccounts[0])
          .withdrawSelfStake(1)
      ).to.be.revertedWithCustomError(
        this.gitcoinIdentityStaking,
        "StakeIsLocked"
      );
    });
    it("should not allow withdrawal of community stake before unlock time", async function () {
      await this.gitcoinIdentityStaking
        .connect(this.userAccounts[0])
        .communityStake(this.userAccounts[1], 100000n, twelveWeeksInSeconds);

      await expect(
        this.gitcoinIdentityStaking
          .connect(this.userAccounts[0])
          .withdrawCommunityStake(this.userAccounts[1], 100000n)
      ).to.be.revertedWithCustomError(
        this.gitcoinIdentityStaking,
        "StakeIsLocked"
      );
    });
  });
});
