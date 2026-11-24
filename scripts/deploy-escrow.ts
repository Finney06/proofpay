/**
 * Deploys ProofPayEscrow to Celo mainnet from the agent wallet (tagged with ProofPay's attribution code).
 * The escrow holds USD₮ and releases only to this agent wallet, and only when the client who paid in says so.
 * Run: npm run deploy:escrow   then set ESCROW_ADDRESS to the printed address (in .env and on Render).
 */
import "dotenv/config";
import { CELO_EXPLORER_ADDRESS, CELO_EXPLORER_TX, FUNDING_TOKENS } from "../src/config/celo.js";
import { escrowAbi, escrowBytecode } from "../src/contracts/escrow.js";
import { agentWallet, getAgentAddress, publicClient, verifyAttributedTx } from "../src/services/celoWallet.js";

async function main() {
  if (!agentWallet) {
    console.error("Set AGENT_PRIVATE_KEY in .env before deploying.");
    process.exit(1);
  }
  const agent = getAgentAddress()!;
  const balance = await publicClient.getBalance({ address: agent });
  if (balance === 0n) {
    console.error(`The agent wallet ${agent} has no CELO for gas.`);
    process.exit(1);
  }

  console.log("Deploying ProofPayEscrow on Celo mainnet...");
  console.log(`Token: ${FUNDING_TOKENS.USDT.address} (USD₮)`);
  console.log(`Agent: ${agent}`);

  const hash = await agentWallet.deployContract({
    account: agentWallet.account!,
    chain: agentWallet.chain,
    abi: escrowAbi,
    bytecode: escrowBytecode,
    args: [FUNDING_TOKENS.USDT.address, agent],
  });
  console.log(`Tx sent:  ${CELO_EXPLORER_TX}${hash}`);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success" || !receipt.contractAddress) {
    console.error("Deployment failed.");
    process.exit(1);
  }
  const attribution = await verifyAttributedTx(hash);
  console.log(`Escrow:   ${receipt.contractAddress}`);
  console.log(`          ${CELO_EXPLORER_ADDRESS}${receipt.contractAddress}`);
  console.log(`Tagged:   ${attribution.verified ? "yes" : "no"}`);
  console.log(`\nNext: set ESCROW_ADDRESS=${receipt.contractAddress} in .env and on Render.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
