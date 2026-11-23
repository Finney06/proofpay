import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { DeliverableReview } from "./aiReviewer.js";
import type { ExecutedTextilePayout } from "./textileFx.js";

export type TaskStatus =
  | "OPEN"
  | "SUBMITTED"
  | "VETTED"
  | "PAID"
  | "REJECTED";

export interface PayoutTask {
  id: string;
  businessName: string;
  title: string;
  brief: string;
  checklist: string[];
  budgetUsd: number;
  corridorCode: string;
  freelancerName: string;
  freelancerWallet: string;
  payoutMode: "APPROVAL_REQUIRED" | "AUTO_PAY_CAPPED";
  status: TaskStatus;
  createdAt: string;
  submission?: {
    deliverableUrl: string;
    deliverableNotes: string;
    submittedAt: string;
  };
  aiReview?: DeliverableReview;
  approval?: {
    approvedBy: string;
    approvedAt: string;
    selfAgentId?: string;
    humanNullifier?: string;
  };
  receiptId?: string;
}

export interface TrustReceipt {
  id: string;
  taskId: string;
  createdAt: string;
  businessName: string;
  freelancerName: string;
  freelancerWallet: string;
  taskTitle: string;
  brief: string;
  deliverableUrl: string;
  deliverableHash: string;
  aiReviewScore: number;
  aiReviewVerdict: string;
  aiReviewSummary: string;
  approvedBy: string;
  approvedAt: string;
  /** "client": the business approved in the dashboard. "self-agent": a Self-verified agent called the agent API. */
  approvalMethod: "client" | "self-agent";
  /** Daily cap the payout counted against (per client, or per verified human for agents). */
  capCheck: {
    capKey: string;
    dailyCapUsd: number;
    spentTodayUsd: number;
  };
  /** Present only when a Self Agent ID signature was actually verified. */
  selfVerification: {
    verified: true;
    agentId: string;
    humanNullifier: string;
  } | null;
  reviewEngine?: string;
  payout: ExecutedTextilePayout;
  x402TxHash?: string | null;
  attributionTag: string;
}

interface StoreState {
  tasks: PayoutTask[];
  receipts: TrustReceipt[];
  humanDailySpend: Record<string, Record<string, number>>; // date -> humanNullifier -> usd
}

// Point DATA_DIR at a persistent disk in production so receipts survive redeploys.
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), "data"));
const STORE_PATH = path.join(DATA_DIR, "proofpay.json");

function todayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function ensureStore(): StoreState {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(STORE_PATH)) {
    const initial: StoreState = {
      tasks: [],
      receipts: [],
      humanDailySpend: {},
    };
    fs.writeFileSync(STORE_PATH, JSON.stringify(initial, null, 2));
    return initial;
  }
  const raw = fs.readFileSync(STORE_PATH, "utf8");
  return JSON.parse(raw) as StoreState;
}

function saveStore(state: StoreState): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(4).toString("hex")}`;
}

export function listTasks(): PayoutTask[] {
  return ensureStore().tasks;
}

export function getTask(id: string): PayoutTask | undefined {
  return ensureStore().tasks.find((t) => t.id === id);
}

export function createTask(
  input: Omit<PayoutTask, "id" | "status" | "createdAt">
): PayoutTask {
  const state = ensureStore();
  const task: PayoutTask = {
    ...input,
    id: generateId("tsk"),
    status: "OPEN",
    createdAt: new Date().toISOString(),
  };
  state.tasks.unshift(task);
  saveStore(state);
  return task;
}

export function updateTask(
  id: string,
  updater: (task: PayoutTask) => PayoutTask
): PayoutTask {
  const state = ensureStore();
  const idx = state.tasks.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`Task not found: ${id}`);
  state.tasks[idx] = updater(state.tasks[idx]);
  saveStore(state);
  return state.tasks[idx];
}

export function listReceipts(): TrustReceipt[] {
  return ensureStore().receipts;
}

export function getReceipt(id: string): TrustReceipt | undefined {
  return ensureStore().receipts.find((r) => r.id === id);
}

export function saveReceipt(receipt: TrustReceipt): TrustReceipt {
  const state = ensureStore();
  state.receipts.unshift(receipt);
  saveStore(state);
  return receipt;
}

export function getHumanSpentToday(humanNullifier: string): number {
  const state = ensureStore();
  const day = todayKey();
  return state.humanDailySpend[day]?.[humanNullifier] || 0;
}

export function recordHumanSpend(humanNullifier: string, amountUsd: number): number {
  const state = ensureStore();
  const day = todayKey();
  if (!state.humanDailySpend[day]) {
    state.humanDailySpend[day] = {};
  }
  const next = Number(
    ((state.humanDailySpend[day][humanNullifier] || 0) + amountUsd).toFixed(2)
  );
  state.humanDailySpend[day][humanNullifier] = next;
  saveStore(state);
  return next;
}
