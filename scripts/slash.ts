import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import { proposeTx } from "./utils/safe";

// https://chainlist.org/?search=sepolia&testnets=true
const RPC_URL = "https://eth-sepolia.public.blastapi.io";
const provider = new ethers.JsonRpcProvider(RPC_URL);

// Initialize signers
const signer = new ethers.Wallet(process.env.SIGNER_PRIVATE_KEY!, provider);

const slash = async () => {
  const tx = await generateSlashTx();
  await proposeTx(11155111n, signer, tx);
};

const generateSlashTx = async () => {
  // TODO create the actual slashing transaction, this is just a dummy placeholder
  // that creates an EAS attestation

  const eas = new ethers.Contract(
    "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
    [
      {
        inputs: [
          {
            components: [
              { internalType: "bytes32", name: "schema", type: "bytes32" },
              {
                components: [
                  {
                    internalType: "address",
                    name: "recipient",
                    type: "address",
                  },
                  {
                    internalType: "uint64",
                    name: "expirationTime",
                    type: "uint64",
                  },
                  { internalType: "bool", name: "revocable", type: "bool" },
                  { internalType: "bytes32", name: "refUID", type: "bytes32" },
                  { internalType: "bytes", name: "data", type: "bytes" },
                  { internalType: "uint256", name: "value", type: "uint256" },
                ],
                internalType: "struct AttestationRequestData",
                name: "data",
                type: "tuple",
              },
            ],
            internalType: "struct AttestationRequest",
            name: "request",
            type: "tuple",
          },
        ],
        name: "attest",
        outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
        stateMutability: "payable",
        type: "function",
      },
    ],
    signer,
  );

  return await eas.attest.populateTransaction({
    schema:
      "0x3969bb076acfb992af54d51274c5c868641ca5344e1aacd0b1f5e4f80ac0822f",
    data: {
      recipient: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      expirationTime: 0,
      revocable: true,
      refUID:
        "0x0000000000000000000000000000000000000000000000000000000000000000",
      data: "0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000000e546573742073746174656d656e74000000000000000000000000000000000000",
      value: 0,
    },
  });
};

slash()
  .then(() => {
    console.log("Slash transaction proposed");
  })
  .catch((error) => {
    console.error("Error proposing slash transaction", error);
    process.exit(1);
  });
