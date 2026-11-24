import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import pg from "pg";
import type { DeliverableReview } from "./aiReviewer.js";
import type { ExecutedTextilePayout } from "./textileFx.js";

export type TaskStatus =
  | "OPEN"
  | "SUBMITTED"
  | "VETTED"
  | "PAID"
  | "REJECTED"
  | "REFUNDED";

/** The client's own USD₮, sent to ProofPay to hold until they approve or reject. */
export interface TaskFunding {
  status: "funded" | "refunded";
  funder: string;
  txHash: string;
  amountAtomic: string;
  fundedAt: string;
  attributionVerified: boolean;
  refundTxHash?: string;
  refundedAt?: string;
}

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
  funding?: TaskFunding;
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
  /** Set when the client funded the payout from their own wallet. */
  fundedBy?: string | null;
  fundingTxHash?: string | null;
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

/*
 * Storage: the whole state lives in memory and is written to a local JSON file.
 * When DATABASE_URL is set (Render's free Postgres), every change is also saved
 * to the database and the state is loaded from it at startup, so payouts and
 * receipts survive redeploys on hosts whose disk is wiped.
 */
let memory: StoreState | null = null;
let pool: pg.Pool | null = null;
let writeChain: Promise<unknown> = Promise.resolve();

function emptyState(): StoreState {
  return { tasks: [], receipts: [], humanDailySpend: {} };
}

function writeFile(state: StoreState): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${STORE_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STORE_PATH);
}

function ensureStore(): StoreState {
  if (memory) return memory;
  memory = fs.existsSync(STORE_PATH)
    ? (JSON.parse(fs.readFileSync(STORE_PATH, "utf8")) as StoreState)
    : emptyState();
  return memory;
}

function saveStore(state: StoreState): void {
  memory = state;
  writeFile(state);
  if (pool) {
    const snapshot = JSON.stringify(state);
    const db = pool;
    writeChain = writeChain
      .then(() =>
        db.query(
          "INSERT INTO proofpay_state (id, data, updated_at) VALUES (1, $1::jsonb, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
          [snapshot]
        )
      )
      .catch((err) => console.error("Database save failed:", err instanceof Error ? err.message : err));
  }
}

/** Connects to Postgres when DATABASE_URL is set and loads the saved state. Call once before serving. */
export async function initStore(): Promise<"database" | "file"> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    ensureStore();
    return "file";
  }
  pool = new pg.Pool({
    connectionString: url,
    ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : undefined,
    max: 3,
  });
  await pool.query(
    "CREATE TABLE IF NOT EXISTS proofpay_state (id integer PRIMARY KEY, data jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now())"
  );
  const { rows } = await pool.query("SELECT data FROM proofpay_state WHERE id = 1");
  if (rows.length) {
    memory = rows[0].data as StoreState;
    writeFile(memory);
  } else {
    saveStore(ensureStore());
  }
  return "database";
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
