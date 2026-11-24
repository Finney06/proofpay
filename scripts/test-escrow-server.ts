/**
 * Run: npm run build && npm run test:escrow-server
 * Runs the real ProofPay server against a local ganache chain (chain id 42220) with the escrow deployed.
 * Uses a throwaway DATA_DIR and no DATABASE_URL, so production data is never touched.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPublicClient, createWalletClient, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { escrowAbi, escrowBytecode } from "../src/contracts/escrow.js";
import { testTokenAbi, testTokenBytecode } from "./build/testToken.js";

const REPO = process.cwd();
const require = createRequire(import.meta.url);
const ganache = require("ganache");

// The server's agent wallet (from AGENT_PRIVATE_KEY in .env) receives released deposits.
import "dotenv/config";
const AGENT = privateKeyToAccount(process.env.AGENT_PRIVATE_KEY as Hex).address as Address;
const keys = [11, 12, 13].map((n) => `0x${n.toString(16).padStart(64, "0")}` as Hex);
const [client, stranger, deployer] = keys.map((k) => privateKeyToAccount(k));

const chainSrv = ganache.server({
  logging: { quiet: true },
  chain: { chainId: 42220 },
  wallet: { accounts: keys.map((secretKey) => ({ secretKey, balance: "0x56BC75E2D63100000" })) },
});
await chainSrv.listen(8546);
const chain = { id: 42220, name: "local", nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 }, rpcUrls: { default: { http: ["http://127.0.0.1:8546"] } } } as const;
const pub = createPublicClient({ chain, transport: http("http://127.0.0.1:8546") });
const w = (acct: typeof client) => createWalletClient({ account: acct, chain, transport: http("http://127.0.0.1:8546") });

async function mined(hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success");
  return r;
}
const token = (await mined(await w(deployer).deployContract({ abi: testTokenAbi, bytecode: testTokenBytecode }))).contractAddress!;
const escrow = (await mined(await w(deployer).deployContract({ abi: escrowAbi, bytecode: escrowBytecode, args: [token, AGENT] }))).contractAddress!;
await mined(await w(deployer).writeContract({ address: token, abi: testTokenAbi, functionName: "mint", args: [client.address, 100_000_000n] }));

const dataDir = path.join(os.tmpdir(), `proofpay-escrow-test-${Date.now()}`);
fs.rmSync(dataDir, { recursive: true, force: true });
const server = spawn(process.execPath, ["dist/server.js"], {
  cwd: REPO,
  env: { ...process.env, PORT: "3100", CELO_RPC_URL: "http://127.0.0.1:8546", ESCROW_ADDRESS: escrow, DATABASE_URL: "", DATA_DIR: dataDir, GEMINI_API_KEY: "" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const base = "http://localhost:3100/api";
for (let i = 0; i < 40; i++) {
  try { if ((await fetch(base + "/health")).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 500));
}
const call = async (path: string, body?: unknown, method = body ? "POST" : "GET") => {
  const res = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as any };
};
let passed = 0;
const ok = (name: string) => { passed++; console.log("  ok  " + name); };

try {
  const health = await call("/health");
  assert.equal(health.data.escrow, escrow);
  ok("health shows the escrow address");

  const newTask = async (title: string) =>
    (await call("/tasks", {
      businessName: "Test Studio", title, brief: "Make a test page", checklist: ["Page loads"], budgetUsd: 2,
      corridorCode: "cNGN", freelancerName: "Tester", freelancerWallet: stranger.address,
    })).data.task;

  // ---- Task 1: fund, can't approve before work, refund ----
  const t1 = await newTask("Refund path");
  const f1 = await call(`/tasks/${t1.id}/funding`);
  assert.equal(f1.data.mode, "escrow");
  assert.equal(f1.data.escrow, escrow);
  assert.ok(f1.data.fundData.endsWith("218021"), "fund call carries the attribution suffix");
  ok("funding returns escrow calls with the tag");

  await mined(await w(client).writeContract({ address: token, abi: testTokenAbi, functionName: "approve", args: [escrow, 2_000_000n] }));
  const fundTx = await w(client).sendTransaction({ to: escrow, data: f1.data.fundData });
  await mined(fundTx);
  const fund1 = await call(`/tasks/${t1.id}/fund`, { txHash: fundTx });
  assert.equal(fund1.status, 200, JSON.stringify(fund1.data));
  assert.equal(fund1.data.task.funding.method, "escrow");
  assert.equal(fund1.data.task.funding.funder.toLowerCase(), client.address.toLowerCase());
  ok("server confirms the escrow deposit and records the client as funder");

  const reuse = await call(`/tasks/${t1.id}/fund`, { txHash: fundTx });
  assert.equal(reuse.status, 200);
  const early = await call(`/tasks/${t1.id}/approve?check=1`, {});
  assert.equal(early.status, 400, JSON.stringify(early.data));
  ok("approval check refuses before the work is handed in (no money moves)");

  const noHash = await call(`/tasks/${t1.id}/refund`, {});
  assert.equal(noHash.status, 400);
  const wrongTx = await call(`/tasks/${t1.id}/refund`, { txHash: fundTx });
  assert.equal(wrongTx.status, 500);
  assert.match(wrongTx.data.error, /no Refunded event/);
  ok("refund needs a real Refunded event, not any transaction");

  const refundTx = await w(client).sendTransaction({ to: escrow, data: f1.data.refundData });
  await mined(refundTx);
  const r1 = await call(`/tasks/${t1.id}/refund`, { txHash: refundTx });
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.task.status, "REFUNDED");
  const bal = await pub.readContract({ address: token, abi: testTokenAbi, functionName: "balanceOf", args: [client.address] });
  assert.equal(bal, 100_000_000n);
  ok("client refunds from the contract; money is back and the payout shows Refunded");

  // ---- Task 2: fund, submit, check, stranger can't release, client releases, server verifies ----
  const t2 = await newTask("Approve path");
  const f2 = await call(`/tasks/${t2.id}/funding`);
  await mined(await w(client).writeContract({ address: token, abi: testTokenAbi, functionName: "approve", args: [escrow, 2_000_000n] }));
  const fundTx2 = await w(client).sendTransaction({ to: escrow, data: f2.data.fundData });
  await mined(fundTx2);
  assert.equal((await call(`/tasks/${t2.id}/fund`, { txHash: fundTx2 })).status, 200);
  const sub = await call(`/tasks/${t2.id}/submit`, { deliverableUrl: "https://example.com", deliverableNotes: "Here is the test page, it loads." });
  assert.equal(sub.status, 200, JSON.stringify(sub.data));
  const check = await call(`/tasks/${t2.id}/approve?check=1`, {});
  assert.equal(check.status, 200, JSON.stringify(check.data));
  ok("approval check passes once the work is in");

  await assert.rejects(() => w(stranger).sendTransaction({ to: escrow, data: f2.data.releaseData }));
  ok("a stranger's release is refused by the contract");

  const noRelease = await call(`/tasks/${t2.id}/approve`, {});
  assert.equal(noRelease.status, 400);
  assert.equal(noRelease.data.error, "RELEASE_TX_REQUIRED");
  ok("approve without a release transaction is refused");

  const releaseTx = await w(client).sendTransaction({ to: escrow, data: f2.data.releaseData });
  await mined(releaseTx);
  const agentBal = await pub.readContract({ address: token, abi: testTokenAbi, functionName: "balanceOf", args: [AGENT] });
  assert.equal(agentBal, 2_000_000n);
  const approve = await call(`/tasks/${t2.id}/approve`, { txHash: releaseTx });
  // On the practice chain the Textile swap can't run, so the payout itself fails after the escrow checks pass.
  const after = (await call(`/tasks/${t2.id}`)).data.task;
  assert.equal(after.funding.releaseTxHash, releaseTx, "server accepted the release and saved it for a retry");
  ok(`server verifies the release, then hands off to Textile (practice chain: ${approve.status} ${String(approve.data.error || "").slice(0, 600)})`);

  console.log(`\n${passed} passed`);
} catch (err) {
  console.error("FAILED:", err);
  console.error("--- server log ---\n" + log.slice(-3000));
  process.exitCode = 1;
} finally {
  server.kill();
  await chainSrv.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
