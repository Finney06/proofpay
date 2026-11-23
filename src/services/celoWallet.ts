import { withAttribution, verifyTx } from "@celo/attribution-tags";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  http,
  isAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { celo } from "viem/chains";
import {
  ATTRIBUTION_TAG,
  CELO_RPC_URL,
  ERC20_ABI,
  FUNDING_TOKENS,
  PAYOUT_CORRIDORS,
} from "../config/celo.js";

export const publicClient = createPublicClient({
  chain: celo,
  transport: http(CELO_RPC_URL),
});

function loadAgentAccount(): PrivateKeyAccount | null {
  const raw = process.env.AGENT_PRIVATE_KEY?.trim();
  if (!raw) return null;
  const normalized = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error("AGENT_PRIVATE_KEY must be a 32-byte hex private key");
  }
  return privateKeyToAccount(normalized);
}

const agentAccount = loadAgentAccount();

// Every sendTransaction and writeContract through this wallet automatically
// appends the ERC-8021 attribution suffix for celo_325d8d38061f.
export const agentWallet = agentAccount
  ? createWalletClient({
      account: agentAccount,
      chain: celo,
      transport: http(CELO_RPC_URL),
    }).extend(withAttribution(ATTRIBUTION_TAG))
  : null;

export function getAgentAddress(): Address | null {
  return agentAccount ? agentAccount.address : null;
}

export function isLiveExecutionConfigured(): boolean {
  return agentWallet !== null;
}

export async function verifyAttributedTx(hash: Hash): Promise<{
  verified: boolean;
  codes: string[];
}> {
  const result = await verifyTx({ client: publicClient, hash });
  const codes = result?.codes ?? [];
  return {
    verified: codes.includes(ATTRIBUTION_TAG),
    codes,
  };
}

export async function getTokenBalance(
  tokenAddress: Address,
  owner: Address
): Promise<bigint> {
  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [owner],
  });
}

export async function getTokenAllowance(
  tokenAddress: Address,
  owner: Address,
  spender: Address
): Promise<bigint> {
  return publicClient.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [owner, spender],
  });
}

export async function sendTaggedTransaction(tx: {
  to: Address;
  data: Hex;
  value?: bigint;
}): Promise<{ hash: Hash; attributionVerified: boolean }> {
  if (!agentWallet || !agentAccount) {
    throw new Error(
      "Live Celo wallet is not configured. Set AGENT_PRIVATE_KEY in .env to broadcast mainnet transactions."
    );
  }

  const hash = await agentWallet.sendTransaction({
    account: agentAccount,
    chain: celo,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
  });

  await waitForSuccess(hash);
  const check = await verifyAttributedTx(hash);

  return {
    hash,
    attributionVerified: check.verified,
  };
}

async function waitForSuccess(hash: Hash): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new Error(`Transaction reverted on Celo mainnet: ${hash}`);
  }
}

/**
 * Sets an ERC-20 allowance to zero. USD₮ rejects approve(nonzero -> nonzero),
 * so a stale allowance has to be cleared before a new approval.
 */
export async function resetTokenAllowance(params: {
  tokenAddress: Address;
  spender: Address;
}): Promise<{ hash: Hash; attributionVerified: boolean }> {
  if (!agentWallet || !agentAccount) {
    throw new Error("Live Celo wallet is not configured.");
  }
  const hash = await agentWallet.writeContract({
    account: agentAccount,
    chain: celo,
    address: params.tokenAddress,
    abi: ERC20_ABI,
    functionName: "approve",
    args: [params.spender, 0n],
  });
  await waitForSuccess(hash);
  const check = await verifyAttributedTx(hash);
  return { hash, attributionVerified: check.verified };
}

export async function transferLocalStablecoin(params: {
  tokenAddress: Address;
  recipient: Address;
  amount: bigint;
}): Promise<{ hash: Hash; attributionVerified: boolean }> {
  if (!agentWallet || !agentAccount) {
    throw new Error(
      "Live Celo wallet is not configured. Set AGENT_PRIVATE_KEY in .env to broadcast mainnet payouts."
    );
  }

  if (!isAddress(params.recipient)) {
    throw new Error("Invalid recipient Celo address");
  }

  if (params.recipient.toLowerCase() === agentAccount.address.toLowerCase()) {
    throw new Error(
      "Recipient wallet must be an external freelancer wallet, not the agent wallet itself."
    );
  }

  const hash = await agentWallet.writeContract({
    account: agentAccount,
    chain: celo,
    address: params.tokenAddress,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [params.recipient, params.amount],
  });

  await waitForSuccess(hash);
  const check = await verifyAttributedTx(hash);

  return {
    hash,
    attributionVerified: check.verified,
  };
}

export async function getAgentBalancesSnapshot(): Promise<{
  address: Address | null;
  celo: string;
  usdt: string;
  cngn: string;
}> {
  if (!agentAccount) {
    return { address: null, celo: "0", usdt: "0", cngn: "0" };
  }

  const [celoBal, usdtBal, cngnBal] = await Promise.all([
    publicClient.getBalance({ address: agentAccount.address }),
    getTokenBalance(FUNDING_TOKENS.USDT.address, agentAccount.address),
    getTokenBalance(PAYOUT_CORRIDORS.cNGN.address, agentAccount.address),
  ]);

  return {
    address: agentAccount.address,
    celo: formatUnits(celoBal, 18),
    usdt: formatUnits(usdtBal, FUNDING_TOKENS.USDT.decimals),
    cngn: formatUnits(cngnBal, PAYOUT_CORRIDORS.cNGN.decimals),
  };
}
