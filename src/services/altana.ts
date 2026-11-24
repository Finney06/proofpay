import crypto from "node:crypto";
import {
  CELO,
  createClient,
  deserializeSession,
  signerFromPrivateKey,
  type SerializedSession,
} from "@altananetwork/sdk";
import { encodeFunctionData, erc20Abi, type Address, type Hash, type Hex } from "viem";
import { ATTRIBUTION_TAG, FUNDING_TOKENS } from "../config/celo.js";

/*
 * Altana: the client keeps the budget in their own non-custodial Altana wallet
 * and grants ProofPay a session key that can only move USD₮, only up to the
 * budget, and only until the expiry they chose. On approval ProofPay uses the
 * session to pull exactly the budget; on rejection the client revokes it and
 * nothing ever left their wallet.
 */

let client: ReturnType<typeof createClient> | null = null;

function altana() {
  if (!client) client = createClient({ chains: [CELO], appCode: ATTRIBUTION_TAG });
  return client;
}

/* ---------- Session key at rest: AES-256-GCM ---------- */

function secretKey(): Buffer {
  const seed = process.env.SESSION_SECRET || process.env.OPERATOR_KEY || process.env.AGENT_PRIVATE_KEY;
  if (!seed) throw new Error("Set SESSION_SECRET to store Altana session keys.");
  return crypto.createHash("sha256").update(`proofpay-altana:${seed}`).digest();
}

export function sealSessionKey(privateKey: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  const data = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

function openSessionKey(sealed: string): Hex {
  const [iv, tag, data] = sealed.split(".").map((p) => Buffer.from(p, "base64url"));
  const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8") as Hex;
}

/* ---------- Checks on a granted session ---------- */

/** Returns a reason when the session can't pay this budget, or null when it can. */
export function checkSession(session: SerializedSession, budgetAtomic: bigint): string | null {
  const usdt = FUNDING_TOKENS.USDT.address.toLowerCase();
  if (!session?.walletAddress || !session.publicKey) return "The permission is incomplete.";
  if (!Number.isFinite(session.expiry) || session.expiry * 1000 < Date.now() + 10 * 60 * 1000) {
    return "The permission expires too soon. Give it at least a day.";
  }
  const calls = session.permissions?.calls ?? [];
  if (!calls.some((c) => "to" in c && c.to.toLowerCase() === usdt)) {
    return "The permission must allow ProofPay to move USD₮.";
  }
  const cap = (session.permissions?.spend ?? [])
    .filter((s) => s.token && s.token.toLowerCase() === usdt)
    .reduce((max, s) => (BigInt(s.limit) > max ? BigInt(s.limit) : max), 0n);
  if (cap < budgetAtomic) return "The spending limit is below this payout's budget.";
  return null;
}

/** Pulls the budget from the client's Altana wallet into the agent wallet, tagged with ProofPay's code. */
export async function pullBudget(params: {
  session: SerializedSession;
  sealedKey: string;
  to: Address;
  amount: bigint;
}): Promise<Hash> {
  const live = deserializeSession(params.session, signerFromPrivateKey(openSessionKey(params.sealedKey)));
  const result = await altana().execute({
    session: live,
    chainId: CELO.chainId,
    feeToken: FUNDING_TOKENS.USDT.address,
    calls: [
      {
        to: FUNDING_TOKENS.USDT.address,
        data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [params.to, params.amount] }),
        value: 0n,
      },
    ],
  });
  if (result.status !== "CONFIRMED" || !result.transactionHash) {
    throw new Error(
      `Altana couldn't move the budget (${result.status}${result.statusCode ? `, code ${result.statusCode}` : ""}). Check the wallet holds the USD₮ and the permission is still active.`
    );
  }
  return result.transactionHash as Hash;
}
