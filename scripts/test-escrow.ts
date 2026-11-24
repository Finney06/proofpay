/**
 * Tests ProofPayEscrow on a local in-memory chain (ganache). No real money.
 * Run: npm run test:escrow
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, custom, keccak256, parseEventLogs, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { escrowAbi, escrowBytecode } from "../src/contracts/escrow.js";
import { testTokenAbi, testTokenBytecode } from "./build/testToken.js";

const require = createRequire(import.meta.url);
const ganache = require("ganache");

// Throwaway keys for the local practice chain only.
const keys = [1, 2, 3, 4].map((n) => `0x${n.toString(16).padStart(64, "0")}` as Hex);
const accounts = keys.map((k) => privateKeyToAccount(k));
const provider = ganache.provider({
  logging: { quiet: true },
  chain: { chainId: 1337 },
  wallet: { accounts: keys.map((secretKey) => ({ secretKey, balance: "0x56BC75E2D63100000" })) },
});
const chain = { id: 1337, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [""] } } } as const;
const pub = createPublicClient({ chain, transport: custom(provider) });
const [agent, client, stranger, deployer] = accounts.map((a) => a.address);
const as = (address: Address) =>
  createWalletClient({ account: accounts.find((a) => a.address === address)!, chain, transport: custom(provider) });

const SUFFIX = "63656c6f5f333235643864333830363166110080218021802180218021802180218021";
let passed = 0;

async function mined(hash: Hex) {
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, "success", "transaction reverted");
  return r;
}

async function reverts(fn: () => Promise<unknown>, reason: string) {
  await assert.rejects(fn, (err: Error) => {
    assert.match(String(err.message), new RegExp(reason), `expected revert ${reason}, got: ${err.message.slice(0, 200)}`);
    return true;
  });
}

async function test(name: string, fn: () => Promise<void>) {
  await fn();
  passed += 1;
  console.log(`  ok  ${name}`);
}

async function deploy<T extends readonly unknown[]>(abi: T, bytecode: Hex, args: unknown[] = []) {
  const hash = await as(deployer).deployContract({ abi: abi as never, bytecode, args: args as never });
  return (await mined(hash)).contractAddress as Address;
}

const token = await deploy(testTokenAbi, testTokenBytecode);
const escrow = await deploy(escrowAbi, escrowBytecode, [token, agent]);
const bal = (who: Address) => pub.readContract({ address: token, abi: testTokenAbi, functionName: "balanceOf", args: [who] });
const write = (who: Address, address: Address, abi: readonly unknown[], functionName: string, args: unknown[]) =>
  as(who).writeContract({ address, abi: abi as never, functionName: functionName as never, args: args as never });
const id = (taskId: string) => keccak256(toHex(taskId));
const usd = (n: number) => BigInt(Math.round(n * 1e6));

await mined(await write(deployer, token, testTokenAbi, "mint", [client, usd(100)]));
await mined(await write(deployer, token, testTokenAbi, "mint", [stranger, usd(100)]));

console.log("ProofPayEscrow");

await test("rejects a zero agent or token at deploy", async () => {
  await reverts(() => deploy(escrowAbi, escrowBytecode, [token, "0x0000000000000000000000000000000000000000"]), "ZeroAddress|revert");
});

await test("client pays in: money moves from the client into the escrow", async () => {
  await mined(await write(client, token, testTokenAbi, "approve", [escrow, usd(10)]));
  const r = await mined(await write(client, escrow, escrowAbi, "fund", [id("tsk_1"), usd(10)]));
  const [ev] = parseEventLogs({ abi: escrowAbi, logs: r.logs, eventName: "Funded" });
  assert.equal(ev.args.funder, client);
  assert.equal(ev.args.amount, usd(10));
  assert.equal(await bal(escrow), usd(10));
  assert.equal(await bal(client), usd(90));
});

await test("the same payout can't be paid in twice", async () => {
  await mined(await write(client, token, testTokenAbi, "approve", [escrow, usd(10)]));
  await reverts(() => write(client, escrow, escrowAbi, "fund", [id("tsk_1"), usd(10)]), "AlreadyFunded|revert");
  await mined(await write(client, token, testTokenAbi, "approve", [escrow, 0n]));
});

await test("zero amount is refused", async () => {
  await reverts(() => write(client, escrow, escrowAbi, "fund", [id("tsk_zero"), 0n]), "ZeroAmount|revert");
});

await test("a stranger can't release someone else's deposit", async () => {
  await reverts(() => write(stranger, escrow, escrowAbi, "release", [id("tsk_1")]), "NotFunder|revert");
});

await test("a stranger can't refund someone else's deposit", async () => {
  await reverts(() => write(stranger, escrow, escrowAbi, "refund", [id("tsk_1")]), "NotFunder|revert");
});

await test("even the agent can't take a deposit", async () => {
  await reverts(() => write(agent, escrow, escrowAbi, "release", [id("tsk_1")]), "NotFunder|revert");
  await reverts(() => write(agent, escrow, escrowAbi, "refund", [id("tsk_1")]), "NotFunder|revert");
  assert.equal(await bal(escrow), usd(10));
});

await test("client approves: the deposit goes to the agent, exactly once", async () => {
  const before = await bal(agent);
  const r = await mined(await write(client, escrow, escrowAbi, "release", [id("tsk_1")]));
  const [ev] = parseEventLogs({ abi: escrowAbi, logs: r.logs, eventName: "Released" });
  assert.equal(ev.args.agent, agent);
  assert.equal(ev.args.amount, usd(10));
  assert.equal((await bal(agent)) - before, usd(10));
  assert.equal(await bal(escrow), 0n);
  await reverts(() => write(client, escrow, escrowAbi, "release", [id("tsk_1")]), "NotHeld|revert");
  await reverts(() => write(client, escrow, escrowAbi, "refund", [id("tsk_1")]), "NotHeld|revert");
});

await test("client rejects: the deposit goes back to the client, exactly once", async () => {
  await mined(await write(client, token, testTokenAbi, "approve", [escrow, usd(5)]));
  await mined(await write(client, escrow, escrowAbi, "fund", [id("tsk_2"), usd(5)]));
  const before = await bal(client);
  const r = await mined(await write(client, escrow, escrowAbi, "refund", [id("tsk_2")]));
  const [ev] = parseEventLogs({ abi: escrowAbi, logs: r.logs, eventName: "Refunded" });
  assert.equal(ev.args.amount, usd(5));
  assert.equal((await bal(client)) - before, usd(5));
  await reverts(() => write(client, escrow, escrowAbi, "refund", [id("tsk_2")]), "NotHeld|revert");
  await reverts(() => write(client, escrow, escrowAbi, "release", [id("tsk_2")]), "NotHeld|revert");
});

await test("deposits are kept apart: releasing one never touches another", async () => {
  await mined(await write(client, token, testTokenAbi, "approve", [escrow, usd(3)]));
  await mined(await write(client, escrow, escrowAbi, "fund", [id("tsk_a"), usd(3)]));
  await mined(await write(stranger, token, testTokenAbi, "approve", [escrow, usd(4)]));
  await mined(await write(stranger, escrow, escrowAbi, "fund", [id("tsk_b"), usd(4)]));
  await mined(await write(client, escrow, escrowAbi, "release", [id("tsk_a")]));
  assert.equal(await bal(escrow), usd(4));
  const d = await pub.readContract({ address: escrow, abi: escrowAbi, functionName: "deposits", args: [id("tsk_b")] });
  assert.equal(d[0], stranger);
  assert.equal(d[1], usd(4));
  assert.equal(d[2], 1);
});

await test("calls still work with ProofPay's attribution tag appended", async () => {
  const data = (await import("viem")).encodeFunctionData({ abi: escrowAbi, functionName: "refund", args: [id("tsk_b")] });
  const hash = await as(stranger).sendTransaction({ to: escrow, data: (data + SUFFIX) as Hex });
  await mined(hash);
  assert.equal(await bal(escrow), 0n);
});

console.log(`\n${passed} passed`);
process.exit(0);
