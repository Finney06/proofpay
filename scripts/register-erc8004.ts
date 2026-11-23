import "dotenv/config";
import { parseEventLogs } from "viem";
import { CONTRACTS, CELO_EXPLORER_TX } from "../src/config/celo.js";
import {
  agentWallet,
  getAgentAddress,
  publicClient,
  verifyAttributedTx,
} from "../src/services/celoWallet.js";

const ERC8004_ABI = [
  {
    name: "register",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "agentURI", type: "string" }],
    outputs: [{ name: "agentId", type: "uint256" }],
  },
  {
    name: "Registered",
    type: "event",
    inputs: [
      { name: "agentId", type: "uint256", indexed: true },
      { name: "agentURI", type: "string", indexed: false },
      { name: "owner", type: "address", indexed: true },
    ],
  },
] as const;

async function main() {
  if (!agentWallet) {
    console.error("Set AGENT_PRIVATE_KEY in .env before registering ERC-8004.");
    process.exit(1);
  }

  const baseUrl = process.env.PUBLIC_BASE_URL;
  if (!baseUrl || baseUrl.includes("localhost")) {
    console.error(
      "Set PUBLIC_BASE_URL in .env to your public deployment URL (e.g. https://proofpay.onrender.com) so agentURI resolves publicly."
    );
    process.exit(1);
  }

  const agentURI = `${baseUrl.replace(/\/$/, "")}/registration.json`;
  const owner = getAgentAddress()!;
  console.log(`Registering ERC-8004 identity on Celo Mainnet...`);
  console.log(`Wallet:   ${owner}`);
  console.log(`AgentURI: ${agentURI}`);

  const hash = await agentWallet.writeContract({
    account: agentWallet.account!,
    chain: agentWallet.chain,
    address: CONTRACTS.ERC8004_IDENTITY_REGISTRY,
    abi: ERC8004_ABI,
    functionName: "register",
    args: [agentURI],
  });

  console.log(`Tx sent:  ${CELO_EXPLORER_TX}${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  const attribution = await verifyAttributedTx(hash);

  const logs = parseEventLogs({
    abi: ERC8004_ABI,
    logs: receipt.logs,
    eventName: "Registered",
  });

  const agentId = logs[0]?.args?.agentId?.toString() || "check explorer";
  console.log(`ERC-8004 Agent ID: ${agentId}`);
  console.log(`Attribution tag verified: ${attribution.verified} (${attribution.codes.join(", ")})`);
  console.log(`\nAdd ERC8004_AGENT_ID=${agentId} to your .env and Loops House submission.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
