import crypto from "node:crypto";
import { Router, type Request } from "express";
import {
  encodeFunctionData,
  erc20Abi,
  isAddress,
  keccak256,
  parseEventLogs,
  parseUnits,
  toHex,
  verifyMessage,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { toDataSuffix } from "@celo/attribution-tags";
import {
  ATTRIBUTION_TAG,
  CELO_CHAIN_ID,
  CONTRACTS,
  DEFAULT_PAYOUT_CORRIDOR,
  FUNDING_TOKENS,
  PAYOUT_CORRIDORS,
} from "../config/celo.js";
import {
  getAgentAddress,
  getAgentBalancesSnapshot,
  isLiveExecutionConfigured,
  getTokenBalance,
  publicClient,
  transferLocalStablecoin,
} from "../services/celoWallet.js";
import {
  executeTextileSwapAndPayout,
  getLiveCorridorRates,
  previewTextileQuote,
} from "../services/textileFx.js";
import { vetDeliverable } from "../services/aiReviewer.js";
import { checkSession, pullBudget, sealSessionKey } from "../services/altana.js";
import { escrowAbi } from "../contracts/escrow.js";
import {
  AUTO_PAY_MAX_USD,
  PER_HUMAN_DAILY_CAP_USD,
  evaluateSharedHumanCap,
  requireSelfAgentId,
  type RequestWithRawBody,
} from "../services/selfGate.js";
import {
  buildX402Requirement,
  verifyAndSettleX402,
} from "../services/x402Service.js";
import {
  createTask,
  generateId,
  getHumanSpentToday,
  getStorageMode,
  getReceipt,
  getTask,
  listReceipts,
  listTasks,
  recordHumanSpend,
  saveReceipt,
  updateTask,
  type PayoutTask,
} from "../services/store.js";

export const apiRouter = Router();

apiRouter.get("/health", async (_req, res) => {
  try {
    const balances = await getAgentBalancesSnapshot();
    res.json({
      status: "ok",
      service: "ProofPay",
      chainId: CELO_CHAIN_ID,
      attributionTag: ATTRIBUTION_TAG,
      executionMode: isLiveExecutionConfigured() ? "mainnet" : "preview",
      storage: getStorageMode(),
      escrow: escrowAddress(),
      agentWallet: balances.address,
      balances: {
        celo: balances.celo,
        usdt: balances.usdt,
        cngn: balances.cngn,
      },
      erc8004AgentId: process.env.ERC8004_AGENT_ID || null,
      selfAgentId: process.env.SELF_AGENT_ID || null,
      contracts: CONTRACTS,
      guardrails: {
        perHumanDailyCapUsd: PER_HUMAN_DAILY_CAP_USD,
        autoPayMaxUsd: AUTO_PAY_MAX_USD,
        defaultCorridor: DEFAULT_PAYOUT_CORRIDOR,
      },
    });
  } catch (err) {
    // Balances come from the Celo RPC; if it's down, still report how the server is set up.
    res.json({
      status: "degraded",
      service: "ProofPay",
      chainId: CELO_CHAIN_ID,
      attributionTag: ATTRIBUTION_TAG,
      executionMode: isLiveExecutionConfigured() ? "mainnet" : "preview",
      storage: getStorageMode(),
      escrow: escrowAddress(),
      agentWallet: getAgentAddress(),
      error: err instanceof Error ? err.message : "Balance lookup failed",
    });
  }
});

apiRouter.get("/corridors", async (_req, res) => {
  try {
    const rates = await getLiveCorridorRates();
    res.json({
      defaultCorridor: DEFAULT_PAYOUT_CORRIDOR,
      corridors: rates,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Failed to load corridors",
    });
  }
});

apiRouter.post("/quote", async (req, res) => {
  try {
    const { corridorCode = DEFAULT_PAYOUT_CORRIDOR, sellAmountUsd = 2 } =
      req.body as { corridorCode?: string; sellAmountUsd?: number };

    const amount = Number(sellAmountUsd);
    if (!Number.isFinite(amount) || amount < 0.5 || amount > 10000) {
      res.status(400).json({
        error: "sellAmountUsd must be between $0.50 and $10,000",
      });
      return;
    }

    const quote = await previewTextileQuote({
      corridorCode,
      sellAmountUsd: amount,
    });
    res.json(quote);
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : "Quote preview failed",
    });
  }
});

/** USD₮ and CELO balances of any Celo address (used by the Altana top-up step). */
apiRouter.get("/balance/:address", async (req, res) => {
  const address = req.params.address;
  if (!isAddress(address)) {
    res.status(400).json({ error: "Not a Celo address." });
    return;
  }
  try {
    const [usdt, celo] = await Promise.all([
      getTokenBalance(FUNDING_TOKENS.USDT.address, address as Address),
      publicClient.getBalance({ address: address as Address }),
    ]);
    res.json({ address, usdtAtomic: usdt.toString(), usdt: Number(usdt) / 1e6, celo: Number(celo) / 1e18 });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Balance lookup failed" });
  }
});

/**
 * There are no accounts, so each browser keeps a random client key and sends it as
 * x-proofpay-client. A payout remembers the hash of the key that created it, and the
 * dashboard lists only the caller's own payouts and receipts. Single payouts and receipts
 * stay readable by id, which is how freelancer links and public receipts work.
 */
function clientKeyHash(req: Request): string | null {
  const key = req.header("x-proofpay-client");
  if (!key || key.length < 20 || key.length > 200) return null;
  return hashToken(key);
}

function ownedTasks(req: Request): PayoutTask[] {
  const owner = clientKeyHash(req);
  if (!owner) return [];
  return listTasks().filter((t) => t.ownerKeyHash === owner);
}

apiRouter.get("/tasks", (req, res) => {
  res.json({ tasks: ownedTasks(req).map(publicTask) });
});

apiRouter.get("/tasks/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json({ task: publicTask(task) });
});

apiRouter.post("/tasks", (req, res) => {
  const {
    businessName,
    title,
    brief,
    checklist,
    budgetUsd,
    corridorCode = DEFAULT_PAYOUT_CORRIDOR,
    freelancerName,
    freelancerWallet,
    payoutMode = "APPROVAL_REQUIRED",
  } = req.body as {
    businessName?: string;
    title?: string;
    brief?: string;
    checklist?: string[] | string;
    budgetUsd?: number;
    corridorCode?: string;
    freelancerName?: string;
    freelancerWallet?: string;
    payoutMode?: "APPROVAL_REQUIRED" | "AUTO_PAY_CAPPED";
  };

  if (!businessName?.trim() || !title?.trim() || !brief?.trim()) {
    res.status(400).json({
      error: "Business name, task title, and brief are required.",
    });
    return;
  }

  if (!freelancerName?.trim() || !freelancerWallet?.trim()) {
    res.status(400).json({
      error: "Freelancer name and Celo wallet address are required.",
    });
    return;
  }

  if (!isAddress(freelancerWallet.trim())) {
    res.status(400).json({
      error: "Freelancer wallet must be a valid 0x Celo address.",
    });
    return;
  }

  const agentAddr = getAgentAddress();
  if (
    agentAddr &&
    freelancerWallet.trim().toLowerCase() === agentAddr.toLowerCase()
  ) {
    res.status(400).json({
      error:
        "Freelancer wallet must be an external recipient wallet, not the agent wallet.",
    });
    return;
  }

  const amount = Number(budgetUsd);
  if (!Number.isFinite(amount) || amount < 1 || amount > 5000) {
    res.status(400).json({
      error: "Budget must be between $1 and $5,000 USDT (Textile FX floor is $1).",
    });
    return;
  }

  if (!PAYOUT_CORRIDORS[corridorCode]) {
    res.status(400).json({ error: `Unsupported corridor: ${corridorCode}` });
    return;
  }

  const parsedChecklist = Array.isArray(checklist)
    ? checklist.map((s) => String(s).trim()).filter(Boolean)
    : typeof checklist === "string"
      ? checklist
          .split(/\r?\n|,/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

  const task = createTask({
    businessName: businessName.trim(),
    title: title.trim(),
    brief: brief.trim(),
    checklist: parsedChecklist,
    budgetUsd: Number(amount.toFixed(2)),
    corridorCode,
    freelancerName: freelancerName.trim(),
    freelancerWallet: freelancerWallet.trim(),
    payoutMode:
      payoutMode === "AUTO_PAY_CAPPED"
        ? "AUTO_PAY_CAPPED"
        : "APPROVAL_REQUIRED",
    ownerKeyHash: clientKeyHash(req) ?? undefined,
  });

  res.status(201).json({ task: publicTask(task) });
});

apiRouter.post("/tasks/:id/submit", async (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  if (task.status === "PAID") {
    res.status(409).json({ error: "Task is already paid." });
    return;
  }

  const { deliverableUrl, deliverableNotes } = req.body as {
    deliverableUrl?: string;
    deliverableNotes?: string;
  };

  if (!deliverableUrl?.trim() || !deliverableNotes?.trim()) {
    res.status(400).json({
      error: "Deliverable link and summary notes are required.",
    });
    return;
  }

  const aiReview = await vetDeliverable({
    taskTitle: task.title,
    brief: task.brief,
    checklist: task.checklist,
    deliverableUrl: deliverableUrl.trim(),
    deliverableNotes: deliverableNotes.trim(),
  });

  const updated = updateTask(task.id, (current) => ({
    ...current,
    status: "VETTED",
    submission: {
      deliverableUrl: deliverableUrl.trim(),
      deliverableNotes: deliverableNotes.trim(),
      submittedAt: new Date().toISOString(),
    },
    aiReview,
  }));

  res.json({ task: publicTask(updated), aiReview });
});

/**
 * On mainnet, approving spends the agent wallet's own USD₮, so only the
 * operator may do it. Fails closed if OPERATOR_KEY is unset.
 */
function isOperator(provided: string | undefined): boolean {
  const expected = process.env.OPERATOR_KEY;
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- Client funding: the client's own USD₮, held until they decide ---------- */

const approveMessage = (taskId: string) => `Approve ProofPay payout ${taskId}`;
const refundMessage = (taskId: string) => `Refund ProofPay payout ${taskId}`;

function budgetAtomic(budgetUsd: number): bigint {
  return parseUnits(budgetUsd.toFixed(FUNDING_TOKENS.USDT.decimals), FUNDING_TOKENS.USDT.decimals);
}

/* ---------- Escrow contract: the client's USD₮ is held by ProofPayEscrow, not by ProofPay ---------- */

function escrowAddress(): Address | null {
  const a = process.env.ESCROW_ADDRESS;
  return a && isAddress(a) ? (a as Address) : null;
}

/** The escrow keys each deposit by the hash of the payout id. */
function escrowId(taskId: string): Hex {
  return keccak256(toHex(taskId));
}

const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/** Finds an escrow event for this payout in a confirmed transaction. */
async function escrowEvent<E extends "Funded" | "Released" | "Refunded">(txHash: string, taskId: string, eventName: E) {
  const escrow = escrowAddress();
  if (!escrow) throw new Error("No escrow contract is configured.");
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hash, timeout: 90_000 });
  if (receipt.status !== "success") throw new Error("That transaction failed on Celo.");
  const id = escrowId(taskId).toLowerCase();
  const logs = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName }).filter(
    (log) => log.address.toLowerCase() === escrow.toLowerCase() && (log.args as { id: Hex }).id.toLowerCase() === id
  );
  if (!logs.length) throw new Error(`That transaction has no ${eventName} event for this payout in the ProofPay escrow.`);
  return logs[0];
}

async function signedByFunder(funder: string, message: string, signature: unknown): Promise<boolean> {
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) return false;
  try {
    return await verifyMessage({ address: funder as Address, message, signature: signature as Hex });
  } catch {
    return false;
  }
}

/** What the client's wallet should send: a USD₮ transfer to the agent wallet, with ProofPay's tag. */
apiRouter.get("/tasks/:id/funding", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  const agent = getAgentAddress();
  if (!agent || !isLiveExecutionConfigured()) {
    res.status(409).json({
      error: "FUNDING_UNAVAILABLE",
      message: "This server is in preview mode, so it can't hold real funds yet.",
    });
    return;
  }
  const amount = budgetAtomic(task.budgetUsd);
  const suffix = toDataSuffix([ATTRIBUTION_TAG]).replace(/^0x/, "");
  const escrow = escrowAddress();
  const heldInEscrow = task.funding?.status === "funded" && task.funding.method === "escrow";
  if (escrow && (!task.funding || heldInEscrow)) {
    // The client's wallet sends these itself: approve, fund, then later release or refund.
    const id = escrowId(task.id);
    const tagged = (data: Hex) => `${data}${suffix}`;
    res.json({
      mode: "escrow",
      chainId: CELO_CHAIN_ID,
      token: FUNDING_TOKENS.USDT.address,
      tokenSymbol: FUNDING_TOKENS.USDT.symbol,
      escrow,
      escrowId: id,
      amountAtomic: amount.toString(),
      amountUsd: task.budgetUsd,
      funder: task.funding?.funder || null,
      approveData: tagged(encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [escrow, amount] })),
      fundData: tagged(encodeFunctionData({ abi: escrowAbi, functionName: "fund", args: [id, amount] })),
      releaseData: tagged(encodeFunctionData({ abi: escrowAbi, functionName: "release", args: [id] })),
      refundData: tagged(encodeFunctionData({ abi: escrowAbi, functionName: "refund", args: [id] })),
    });
    return;
  }
  if (task.funding?.status === "funded") {
    res.status(409).json({ error: "ALREADY_FUNDED", message: "This payout is already funded." });
    return;
  }
  const call = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [agent, amount] });
  res.json({
    mode: "transfer",
    chainId: CELO_CHAIN_ID,
    token: FUNDING_TOKENS.USDT.address,
    tokenSymbol: FUNDING_TOKENS.USDT.symbol,
    to: agent,
    amountAtomic: amount.toString(),
    amountUsd: task.budgetUsd,
    data: `${call}${suffix}`,
    approveMessage: approveMessage(task.id),
    refundMessage: refundMessage(task.id),
  });
});

/** Confirms the client's funding transaction on Celo and marks the payout funded. */
apiRouter.post("/tasks/:id/fund", async (req, res) => {
  try {
    const task = getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (task.funding?.status === "funded") {
      res.json({ task: publicTask(task) });
      return;
    }
    const agent = getAgentAddress();
    const { txHash } = req.body as { txHash?: string };
    if (!agent || !txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) {
      res.status(400).json({ error: "A valid funding transaction hash is required." });
      return;
    }
    if (listTasks().some((t) => t.funding?.txHash.toLowerCase() === txHash.toLowerCase())) {
      res.status(409).json({ error: "That transaction already funded another payout." });
      return;
    }

    const escrow = escrowAddress();
    if (escrow) {
      const log = await escrowEvent(txHash, task.id, "Funded");
      const needed = budgetAtomic(task.budgetUsd);
      if (log.args.amount < needed) {
        res.status(400).json({ error: `The escrow holds ${log.args.amount} of the ${needed} USD₮ units this payout needs.` });
        return;
      }
      const tag = await verifyAttributedTxSafe(txHash as Hash);
      const updated = updateTask(task.id, (current) => ({
        ...current,
        funding: {
          status: "funded",
          method: "escrow",
          escrow,
          funder: log.args.funder,
          txHash,
          amountAtomic: log.args.amount.toString(),
          fundedAt: new Date().toISOString(),
          attributionVerified: tag,
        },
      }));
      res.json({ task: publicTask(updated) });
      return;
    }

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hash, timeout: 90_000 });
    if (receipt.status !== "success") {
      res.status(400).json({ error: "The funding transaction failed on Celo." });
      return;
    }
    const transfers = parseEventLogs({ abi: erc20Abi, logs: receipt.logs, eventName: "Transfer" }).filter(
      (log) =>
        log.address.toLowerCase() === FUNDING_TOKENS.USDT.address.toLowerCase() &&
        log.args.to.toLowerCase() === agent.toLowerCase()
    );
    const paid = transfers.reduce((sum, log) => sum + log.args.value, 0n);
    const needed = budgetAtomic(task.budgetUsd);
    if (paid < needed) {
      res.status(400).json({
        error: `That transaction sent ${paid} of the ${needed} USD₮ units this payout needs.`,
      });
      return;
    }

    const tx = await publicClient.getTransaction({ hash: txHash as Hash });
    const tag = await verifyAttributedTxSafe(txHash as Hash);
    const updated = updateTask(task.id, (current) => ({
      ...current,
      funding: {
        status: "funded",
        funder: tx.from,
        txHash,
        amountAtomic: paid.toString(),
        fundedAt: new Date().toISOString(),
        attributionVerified: tag,
      },
    }));
    res.json({ task: publicTask(updated) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Couldn't confirm the funding." });
  }
});

/** Sends the client's USD₮ back. Only the wallet that funded it can ask. */
apiRouter.post("/tasks/:id/refund", async (req, res) => {
  try {
    const task = getTask(req.params.id);
    if (!task || task.funding?.status !== "funded") {
      res.status(400).json({ error: "There's no held payment to refund on this payout." });
      return;
    }
    if (task.status === "PAID") {
      res.status(409).json({ error: "This payout was already paid to the freelancer." });
      return;
    }
    if (task.funding.method === "escrow") {
      // The client refunded themselves from the contract; record it.
      const { txHash } = (req.body || {}) as { txHash?: string };
      if (!txHash || !TX_HASH.test(txHash)) {
        res.status(400).json({ error: "The refund transaction hash is required." });
        return;
      }
      await escrowEvent(txHash, task.id, "Refunded");
      const updated = updateTask(task.id, (current) => ({
        ...current,
        status: "REFUNDED",
        funding: { ...current.funding!, status: "refunded", refundTxHash: txHash, refundedAt: new Date().toISOString() },
      }));
      res.json({ task: publicTask(updated) });
      return;
    }
    const ok = await signedByFunder(task.funding.funder, refundMessage(task.id), (req.body || {}).signature);
    if (!ok) {
      res.status(401).json({ error: "Only the wallet that funded this payout can refund it." });
      return;
    }
    const refund = await transferLocalStablecoin({
      tokenAddress: FUNDING_TOKENS.USDT.address,
      recipient: task.funding.funder as Address,
      amount: BigInt(task.funding.amountAtomic),
    });
    const updated = updateTask(task.id, (current) => ({
      ...current,
      status: "REFUNDED",
      funding: { ...current.funding!, status: "refunded", refundTxHash: refund.hash, refundedAt: new Date().toISOString() },
    }));
    res.json({ task: publicTask(updated) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Refund failed" });
  }
});

async function verifyAttributedTxSafe(hash: Hash): Promise<boolean> {
  try {
    const { verifyTx } = await import("@celo/attribution-tags");
    const result = await verifyTx({ client: publicClient, hash });
    return result?.codes.includes(ATTRIBUTION_TAG) ?? false;
  } catch {
    return false;
  }
}

/* ---------- Altana: a spending permission on the client's own wallet ---------- */

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function ownsAltana(task: { altana?: { ownerTokenHash: string } }, provided: string | undefined): boolean {
  if (!task.altana || !provided) return false;
  const a = Buffer.from(hashToken(provided));
  const b = Buffer.from(task.altana.ownerTokenHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Stores the session the client granted ProofPay. Returns a one-time owner token for approving later. */
apiRouter.post("/tasks/:id/altana", (req, res) => {
  try {
    const task = getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (task.status === "PAID" || task.status === "CANCELLED") {
      res.status(409).json({ error: "This payout is closed." });
      return;
    }
    if (task.funding?.status === "funded" || task.altana?.status === "granted") {
      res.status(409).json({ error: "This payout already has its money arranged." });
      return;
    }
    const { session, sessionKey, grantTxHash } = req.body as {
      session?: import("@altananetwork/sdk").SerializedSession;
      sessionKey?: string;
      grantTxHash?: string;
    };
    if (!session || typeof sessionKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(sessionKey)) {
      res.status(400).json({ error: "The Altana permission and its key are required." });
      return;
    }
    const problem = checkSession(session, budgetAtomic(task.budgetUsd));
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }
    const ownerToken = crypto.randomBytes(24).toString("base64url");
    const updated = updateTask(task.id, (current) => ({
      ...current,
      altana: {
        status: "granted",
        wallet: session.walletAddress,
        session,
        sealedKey: sealSessionKey(sessionKey),
        ownerTokenHash: hashToken(ownerToken),
        grantTxHash: grantTxHash || null,
        grantedAt: new Date().toISOString(),
      },
    }));
    res.json({ task: publicTask(updated), ownerToken });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : "Couldn't save the permission." });
  }
});

/** Records that the client revoked the permission (they sign the revoke in their own browser). */
apiRouter.post("/tasks/:id/altana/revoked", (req, res) => {
  const task = getTask(req.params.id);
  if (!task || !task.altana) {
    res.status(404).json({ error: "No Altana permission on this payout." });
    return;
  }
  if (!ownsAltana(task, req.get("x-owner-token"))) {
    res.status(401).json({ error: "Only the client who granted the permission can do this." });
    return;
  }
  const { txHash } = req.body as { txHash?: string };
  const updated = updateTask(task.id, (current) => ({
    ...current,
    status: current.status === "PAID" ? current.status : "CANCELLED",
    altana: { ...current.altana!, status: "revoked", revokeTxHash: txHash || undefined, revokedAt: new Date().toISOString() },
  }));
  res.json({ task: publicTask(updated) });
});

/** Never send session secrets or the owner's key hash to the browser. */
function publicTask<T extends { ownerKeyHash?: string; altana?: { sealedKey?: string; ownerTokenHash?: string } }>(task: T): T {
  const { ownerKeyHash: _o, ...withoutOwner } = task;
  if (!task.altana) return withoutOwner as T;
  const { sealedKey: _k, ownerTokenHash: _h, ...rest } = task.altana as Record<string, unknown>;
  return { ...withoutOwner, altana: rest } as T;
}

apiRouter.post("/tasks/:id/approve", async (req, res) => {
  try {
    const task = getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // A client-funded payout is released by the wallet that funded it.
    // Anything else spends the agent wallet's own USD₮, so only the operator may release it.
    const funded = task.funding?.status === "funded";
    const viaAltana = task.altana?.status === "granted";
    if (viaAltana) {
      if (!ownsAltana(task, req.get("x-owner-token"))) {
        res.status(401).json({
          error: "OWNER_TOKEN_REQUIRED",
          message: "Approve from the browser where you granted the Altana permission.",
        });
        return;
      }
    } else if (funded && task.funding!.method === "escrow") {
      // Approval is the client's own release transaction; it's checked below, after the payout checks.
      const { txHash } = (req.body || {}) as { txHash?: string };
      if (req.query.check !== "1" && (!txHash || !TX_HASH.test(txHash))) {
        res.status(400).json({ error: "RELEASE_TX_REQUIRED", message: "Release the money from the escrow first." });
        return;
      }
    } else if (funded) {
      const ok = await signedByFunder(task.funding!.funder, approveMessage(task.id), (req.body || {}).signature);
      if (!ok) {
        res.status(401).json({
          error: "FUNDER_SIGNATURE_REQUIRED",
          message: "Only the wallet that funded this payout can approve it.",
        });
        return;
      }
    } else if (isLiveExecutionConfigured() && !isOperator(req.get("x-operator-key"))) {
      res.status(401).json({
        error: "OPERATOR_KEY_REQUIRED",
        message: process.env.OPERATOR_KEY
          ? "Fund this payout from your wallet first. Unfunded payouts can only be released by the ProofPay operator."
          : "Approvals are disabled: set OPERATOR_KEY on the server to release mainnet payouts.",
      });
      return;
    }

    if (task.status === "PAID") {
      res.status(409).json({
        error: "Task already paid.",
        receiptId: task.receiptId,
      });
      return;
    }
    if (!task.submission || !task.aiReview) {
      res.status(400).json({
        error:
          "Cannot release payout before the freelancer submits work and AI vetting completes.",
      });
      return;
    }

    const approvedBy = task.businessName;
    // Approvals are capped per client per day (per funding wallet when the client funded it).
    const capKey = viaAltana
      ? `client:${task.altana!.wallet.toLowerCase()}`
      : funded
      ? `client:${task.funding!.funder.toLowerCase()}`
      : `client:${task.businessName.trim().toLowerCase()}`;

    const spentToday = getHumanSpentToday(capKey);
    const capCheck = evaluateSharedHumanCap({
      humanNullifier: capKey,
      spentTodayUsd: spentToday,
      requestedUsd: task.budgetUsd,
    });

    if (!capCheck.allowed) {
      res.status(429).json({
        error: "CLIENT_DAILY_CAP_EXCEEDED",
        message: `Daily payout limit reached for ${task.businessName}: $${capCheck.spentTodayUsd.toFixed(2)} of $${capCheck.dailyCapUsd.toFixed(2)} already paid today.`,
        capCheck,
      });
      return;
    }

    if (req.query.check === "1") {
      // Pre-flight from the client's browser before they release the escrow: nothing moves.
      res.json({ ok: true });
      return;
    }

    // Escrow: the client's release must have sent at least the budget to this agent.
    if (funded && task.funding!.method === "escrow") {
      const txHash = (req.body as { txHash: string }).txHash;
      const log = await escrowEvent(txHash, task.id, "Released");
      const agent = getAgentAddress();
      if (!agent || log.args.agent.toLowerCase() !== agent.toLowerCase()) {
        res.status(400).json({ error: "That release didn't go to this server's agent wallet." });
        return;
      }
      if (log.args.funder.toLowerCase() !== task.funding!.funder.toLowerCase()) {
        res.status(400).json({ error: "That release came from a different deposit." });
        return;
      }
      if (log.args.amount < budgetAtomic(task.budgetUsd)) {
        res.status(400).json({ error: "The released amount is below this payout's budget." });
        return;
      }
      updateTask(task.id, (current) => ({ ...current, funding: { ...current.funding!, releaseTxHash: txHash } }));
    }

    // Altana: pull exactly the budget from the client's wallet with the session, then convert.
    let altanaPullTx: string | null = null;
    if (viaAltana) {
      const agent = getAgentAddress();
      if (!agent) {
        res.status(409).json({ error: "This server has no agent wallet to receive the budget." });
        return;
      }
      altanaPullTx = await pullBudget({
        session: task.altana!.session,
        sealedKey: task.altana!.sealedKey,
        to: agent,
        amount: budgetAtomic(task.budgetUsd),
      });
      updateTask(task.id, (current) => ({
        ...current,
        altana: { ...current.altana!, status: "used", pullTxHash: altanaPullTx! },
      }));
    }

    const payout = await executeTextileSwapAndPayout({
      corridorCode: task.corridorCode,
      sellAmountUsd: task.budgetUsd,
      recipient: task.freelancerWallet as Address,
      allowPreviewFallback: true,
    });

    const updatedSpend = recordHumanSpend(capKey, task.budgetUsd);
    const approvedAt = new Date().toISOString();

    const receipt = saveReceipt({
      id: generateId("rcpt"),
      taskId: task.id,
      createdAt: approvedAt,
      businessName: task.businessName,
      freelancerName: task.freelancerName,
      freelancerWallet: task.freelancerWallet,
      taskTitle: task.title,
      brief: task.brief,
      deliverableUrl: task.submission.deliverableUrl,
      deliverableHash: task.aiReview.deliverableHash,
      aiReviewScore: task.aiReview.score,
      aiReviewVerdict: task.aiReview.verdict,
      aiReviewSummary: task.aiReview.summary,
      approvedBy,
      approvedAt,
      approvalMethod: "client",
      capCheck: {
        capKey,
        dailyCapUsd: PER_HUMAN_DAILY_CAP_USD,
        spentTodayUsd: updatedSpend,
      },
      selfVerification: null,
      reviewEngine: task.aiReview.engine,
      payout,
      x402TxHash: null,
      fundedBy: viaAltana ? task.altana!.wallet : funded ? task.funding!.funder : null,
      fundingTxHash: viaAltana ? altanaPullTx : funded ? task.funding!.txHash : null,
      fundingMethod: viaAltana ? "altana" : funded ? (task.funding!.method === "escrow" ? "escrow" : "deposit") : null,
      attributionTag: ATTRIBUTION_TAG,
    });

    const updatedTask = updateTask(task.id, (current) => ({
      ...current,
      status: "PAID",
      approval: {
        approvedBy,
        approvedAt,
      },
      receiptId: receipt.id,
    }));

    res.json({
      task: publicTask(updatedTask),
      receipt,
      receiptUrl: `/receipt/${receipt.id}`,
    });
  } catch (err) {
    res.status(500).json({
      error: err instanceof Error ? err.message : "Payout execution failed",
    });
  }
});

/**
 * Autonomous Agent-to-Agent Payout Endpoint (Track 3: Self Agent ID + x402).
 * 1. requireSelfAgentId verifies raw HTTP body signature on Celo Mainnet via SelfAgentVerifier.
 *    Unverified agents receive HTTP 403 before any conversion happens.
 * 2. verifyAndSettleX402 enforces x402 payment on Celo Mainnet (https://api.x402.celo.org).
 * 3. evaluateSharedHumanCap enforces one shared daily payout cap per verified human nullifier.
 */
apiRouter.post(
  "/agent/payout",
  requireSelfAgentId,
  async (req: RequestWithRawBody, res) => {
    try {
      const verified = req.verifiedAgent!;
      const { taskId } = req.body as { taskId?: string };

      if (!taskId) {
        res.status(400).json({ error: "taskId is required" });
        return;
      }

      const task = getTask(taskId);
      if (!task) {
        res.status(404).json({ error: "Task not found" });
        return;
      }
      if (!task.submission || !task.aiReview) {
        res.status(400).json({
          error: "Deliverable must be submitted and AI-vetted first.",
        });
        return;
      }
      if (task.budgetUsd > AUTO_PAY_MAX_USD && task.payoutMode === "AUTO_PAY_CAPPED") {
        res.status(403).json({
          error: "AUTO_PAY_CAP_EXCEEDED",
          message: `Autonomous payouts are capped at $${AUTO_PAY_MAX_USD} USD; larger tasks require manual client approval.`,
        });
        return;
      }

      const spentToday = getHumanSpentToday(verified.humanNullifier);
      const capCheck = evaluateSharedHumanCap({
        humanNullifier: verified.humanNullifier,
        spentTodayUsd: spentToday,
        requestedUsd: task.budgetUsd,
      });

      if (!capCheck.allowed) {
        res.status(429).json({
          error: "SHARED_HUMAN_CAP_EXCEEDED",
          message: capCheck.reason,
          capCheck,
        });
        return;
      }

      const x402Req = buildX402Requirement({
        resource: `${process.env.PUBLIC_BASE_URL || "http://localhost:3000"}/api/agent/payout`,
        description: `ProofPay verified autonomous payout for ${task.title}`,
        amountAtomicUsd6: "10000", // $0.01 USDT protocol verification fee
      });

      const x402Result = await verifyAndSettleX402({
        req,
        res,
        requirement: x402Req,
      });
      if (!x402Result.settled) return;

      const payout = await executeTextileSwapAndPayout({
        corridorCode: task.corridorCode,
        sellAmountUsd: task.budgetUsd,
        recipient: task.freelancerWallet as Address,
        allowPreviewFallback: true,
      });

      const updatedSpend = recordHumanSpend(
        verified.humanNullifier,
        task.budgetUsd
      );
      const approvedAt = new Date().toISOString();

      const receipt = saveReceipt({
        id: generateId("rcpt"),
        taskId: task.id,
        createdAt: approvedAt,
        businessName: task.businessName,
        freelancerName: task.freelancerName,
        freelancerWallet: task.freelancerWallet,
        taskTitle: task.title,
        brief: task.brief,
        deliverableUrl: task.submission.deliverableUrl,
        deliverableHash: task.aiReview.deliverableHash,
        aiReviewScore: task.aiReview.score,
        aiReviewVerdict: task.aiReview.verdict,
        aiReviewSummary: task.aiReview.summary,
        approvedBy: `Self Agent ID #${verified.agentId}`,
        approvedAt,
        approvalMethod: "self-agent",
        capCheck: {
          capKey: `human:${verified.humanNullifier}`,
          dailyCapUsd: PER_HUMAN_DAILY_CAP_USD,
          spentTodayUsd: updatedSpend,
        },
        selfVerification: {
          verified: true,
          agentId: verified.agentId,
          humanNullifier: verified.humanNullifier,
        },
        reviewEngine: task.aiReview.engine,
        payout,
        x402TxHash: x402Result.txHash || null,
        attributionTag: ATTRIBUTION_TAG,
      });

      updateTask(task.id, (current) => ({
        ...current,
        status: "PAID",
        approval: {
          approvedBy: `Self Agent ID #${verified.agentId}`,
          approvedAt,
          selfAgentId: verified.agentId,
          humanNullifier: verified.humanNullifier,
        },
        receiptId: receipt.id,
      }));

      res.json({
        status: "paid",
        receipt,
        receiptUrl: `/receipt/${receipt.id}`,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : "Agent payout failed",
      });
    }
  }
);

apiRouter.get("/receipts", (req, res) => {
  const mine = new Set(ownedTasks(req).map((t) => t.id));
  res.json({ receipts: listReceipts().filter((r) => mine.has(r.taskId)) });
});

apiRouter.get("/receipts/:id", (req, res) => {
  const receipt = getReceipt(req.params.id);
  if (!receipt) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }
  res.json({ receipt });
});
