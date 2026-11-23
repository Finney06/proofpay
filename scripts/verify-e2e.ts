import assert from "node:assert/strict";
import { previewTextileQuote, getLiveCorridorRates } from "../src/services/textileFx.js";
import { vetDeliverable } from "../src/services/aiReviewer.js";
import { evaluateSharedHumanCap } from "../src/services/selfGate.js";

async function main() {
  console.log("1. Checking live Textile FX corridors on Celo Mainnet...");
  const corridors = await getLiveCorridorRates();
  const cngn = corridors.find((c) => c.code === "cNGN");
  assert.ok(cngn && cngn.rate > 0, "cNGN corridor rate must be positive");
  console.log(`   cNGN rate: 1 USDT = ₦${cngn.rate.toFixed(2)} (${cngn.source})`);

  console.log("2. Requesting live Textile FX v2 RFQ preview (USDT -> cNGN & wBRL)...");
  const cngnQuote = await previewTextileQuote({
    corridorCode: "cNGN",
    sellAmountUsd: 2,
  });
  assert.ok(Number(cngnQuote.buyAmountAtomic) > 0, "cNGN quote must be > 0");
  console.log(
    `   $2.00 USDT -> ₦${cngnQuote.buyAmountFormatted} cNGN (${cngnQuote.source})`
  );

  const wbrlQuote = await previewTextileQuote({
    corridorCode: "wBRL",
    sellAmountUsd: 2,
  });
  assert.ok(Number(wbrlQuote.buyAmountAtomic) > 0, "wBRL quote must be > 0");
  console.log(
    `   $2.00 USDT -> R$${wbrlQuote.buyAmountFormatted} wBRL (${wbrlQuote.source})`
  );

  console.log("3. Testing the rule-based delivery review...");
  const review = await vetDeliverable({
    taskTitle: "Landing hero banner SVG",
    brief: "Design a clean fintech hero banner SVG for ProofPay",
    checklist: ["Clean SVG file", "Mobile responsive layout"],
    deliverableUrl: "https://example.com/",
    deliverableNotes:
      "Delivered the clean SVG file and verified mobile responsive layout across 375px and 1280px viewports.",
  });
  assert.equal(review.verdict, "PASS");
  assert.ok(review.deliverableHash.startsWith("0x"));
  console.log(`   Review: ${review.verdict} (${review.score}/100) · Hash: ${review.deliverableHash.slice(0, 14)}...`);

  console.log("4. Testing Self Agent ID shared per-human anti-sybil cap...");
  const agentA = evaluateSharedHumanCap({
    humanNullifier: "human_0xabc",
    spentTodayUsd: 20,
    requestedUsd: 4,
    dailyCapUsd: 25,
  });
  assert.equal(agentA.allowed, true);

  const agentBSameHuman = evaluateSharedHumanCap({
    humanNullifier: "human_0xabc",
    spentTodayUsd: 24,
    requestedUsd: 2,
    dailyCapUsd: 25,
  });
  assert.equal(agentBSameHuman.allowed, false);
  console.log(`   Agent A allowed: ${agentA.allowed} | Agent B (same human) blocked: ${!agentBSameHuman.allowed}`);

  console.log("\nAll ProofPay end-to-end checks passed.");
}

main().catch((err) => {
  console.error("E2E verification failed:", err);
  process.exit(1);
});
