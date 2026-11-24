// Altana spending limit: the client's money stays in their own wallet (passkey-owned).
// ProofPay gets a session that can only move USD₮, only up to the budget, until the expiry.
// Loaded on demand from app.js, so the main app stays light.
import {
  CELO,
  createClient,
  createPrivateKeySigner,
  deserializeSession,
  serializeSession,
  signerFromPrivateKey,
} from "https://esm.sh/@altananetwork/sdk@1.2.0/es2022/sdk.bundle.mjs";

const USDT = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const TAG = "celo_325d8d38061f";
const client = createClient({ chains: [CELO], appCode: TAG });
const storeKey = (taskId) => `proofpay.altana.${taskId}`;

export function savedGrant(taskId) {
  try {
    return JSON.parse(localStorage.getItem(storeKey(taskId)) || "null");
  } catch {
    return null;
  }
}

function saveGrant(taskId, value) {
  try {
    localStorage.setItem(storeKey(taskId), JSON.stringify(value));
  } catch {
    // Without storage the client can still approve from the operator flow.
  }
}

/** Opens the client's Altana wallet with their passkey, or creates a new one. */
export async function openWallet(create = false) {
  if (create) return client.createPasskeyWallet({ name: "ProofPay" });
  return client.recoverFromPasskey();
}

/** What granting would cost (registry fee in CELO plus relay fee). */
export async function quote(wallet, permissions, expiry) {
  try {
    return await client.quoteGrantSession({ wallet, signer: wallet.signer, permissions, expiry, feeToken: USDT });
  } catch {
    return null;
  }
}

export function permissionsFor(budgetAtomic) {
  return {
    calls: [{ to: USDT }],
    spend: [{ limit: BigInt(budgetAtomic), period: "month", token: USDT }],
  };
}

/** Grants ProofPay the limit and hands the session to the server. */
export async function grant({ taskId, wallet, budgetAtomic, days, register }) {
  const sessionSigner = createPrivateKeySigner();
  const expiry = Math.floor(Date.now() / 1000) + days * 24 * 60 * 60;
  const permissions = permissionsFor(budgetAtomic);
  const session = await client.grantSession({
    wallet,
    signer: wallet.signer,
    sessionSigner,
    permissions,
    expiry,
    feeToken: USDT,
    register,
  });
  if (session.status && session.status !== "granted") {
    throw new Error("Altana couldn't confirm the permission. Check the wallet's balance and try again.");
  }
  const serialized = serializeSession(session);
  const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/altana`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session: serialized, sessionKey: sessionSigner._privateKey, grantTxHash: session.transactionHash || null }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "ProofPay couldn't save the permission.");
  saveGrant(taskId, { ownerToken: data.ownerToken, session: serialized, sessionKey: sessionSigner._privateKey, wallet: wallet.address, grantTxHash: session.transactionHash || null });
  return { ownerToken: data.ownerToken, txHash: session.transactionHash || null };
}

/** Cancels the permission onchain, then tells ProofPay. */
export async function revoke(taskId) {
  const saved = savedGrant(taskId);
  if (!saved) throw new Error("Open this payout in the browser where you granted the permission.");
  const wallet = await client.recoverFromPasskey();
  const session = deserializeSession(saved.session, signerFromPrivateKey(saved.sessionKey));
  const result = await client.revokeSession({ wallet, signer: wallet.signer, session });
  const txHash = result?.transactionHash || result?.legs?.find((l) => l.transactionHash)?.transactionHash || null;
  const res = await fetch(`/api/tasks/${encodeURIComponent(taskId)}/altana/revoked`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-owner-token": saved.ownerToken },
    body: JSON.stringify({ txHash }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "Couldn't record the cancellation.");
  return txHash;
}
