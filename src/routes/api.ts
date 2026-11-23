import crypto from "node:crypto";
import { Router } from "express";
import { isAddress, type Address } from "viem";
import {
  ATTRIBUTION_TAG,
  CELO_CHAIN_ID,
  CONTRACTS,
  DEFAULT_PAYOUT_CORRIDOR,
  PAYOUT_CORRIDORS,
} from "../config/celo.js";
import {
  getAgentAddress,
  getAgentBalancesSnapshot,
  isLiveExecutionConfigured,
} from "../services/celoWallet.js";
import {
  executeTextileSwapAndPayout,
  getLiveCorridorRates,
  previewTextileQuote,
} from "../services/textileFx.js";
import { vetDeliverable } from "../services/aiReviewer.js";
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
  getReceipt,
  getTask,
  listReceipts,
  listTasks,
  recordHumanSpend,
  saveReceipt,
  updateTask,
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
    res.status(500).json({
      error: err instanceof Error ? err.message : "Health check failed",
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

apiRouter.get("/tasks", (_req, res) => {
  res.json({ tasks: listTasks() });
});

apiRouter.get("/tasks/:id", (req, res) => {
  const task = getTask(req.params.id);
  if (!task) {
    res.status(404).json({ error: "Task not found" });
    return;
  }
  res.json({ task });
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
  });

  res.status(201).json({ task });
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

  res.json({ task: updated, aiReview });
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

apiRouter.post("/tasks/:id/approve", async (req, res) => {
  try {
    if (isLiveExecutionConfigured() && !isOperator(req.get("x-operator-key"))) {
      res.status(401).json({
        error: "OPERATOR_KEY_REQUIRED",
        message: process.env.OPERATOR_KEY
          ? "On mainnet, only the ProofPay operator can release payouts from the agent wallet."
          : "Approvals are disabled: set OPERATOR_KEY on the server to release mainnet payouts.",
      });
      return;
    }

    const task = getTask(req.params.id);
    if (!task) {
      res.status(404).json({ error: "Task not found" });
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
    // Dashboard approvals are capped per client per day.
    const capKey = `client:${task.businessName.trim().toLowerCase()}`;

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
      task: updatedTask,
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

apiRouter.get("/receipts", (_req, res) => {
  res.json({ receipts: listReceipts() });
});

apiRouter.get("/receipts/:id", (req, res) => {
  const receipt = getReceipt(req.params.id);
  if (!receipt) {
    res.status(404).json({ error: "Receipt not found" });
    return;
  }
  res.json({ receipt });
});
