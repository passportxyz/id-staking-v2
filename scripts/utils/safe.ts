import { ethers } from "ethers";
import SafeApiKit from "@safe-global/api-kit";
import Safe, { EthersAdapter } from "@safe-global/protocol-kit";
import { MetaTransactionData } from "@safe-global/safe-core-sdk-types";

const safeAddress = process.env.SAFE_ADDRESS!;

export const proposeTx = async (
  chainId: bigint,
  signer: ethers.Signer,
  tx: ethers.ContractTransaction,
) => {
  console.log("Proposing transaction");

  const ethAdapter = new EthersAdapter({
    ethers,
    signerOrProvider: signer,
  });

  const apiKit = new SafeApiKit({
    chainId,
  });
  const protocolKit = await Safe.create({
    ethAdapter,
    safeAddress,
  });

  const safeTransactionData: MetaTransactionData = {
    to: tx.to!,
    data: tx.data,
    value: tx.value?.toString() || "0",
  };

  // Create a Safe transaction with the provided parameters
  const safeTransaction = await protocolKit.createTransaction({
    transactions: [safeTransactionData],
  });

  // Deterministic hash based on transaction parameters
  const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);

  // Sign transaction to verify that the transaction is coming from an owner of the safe
  const senderSignature = await protocolKit.signHash(safeTxHash);

  await apiKit.proposeTransaction({
    safeAddress,
    safeTransactionData: safeTransaction.data,
    safeTxHash,
    senderAddress: await signer.getAddress(),
    senderSignature: senderSignature.data,
  });
};
