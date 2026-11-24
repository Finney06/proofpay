import "dotenv/config";
import path from "node:path";
import express from "express";
import cors from "cors";
import { apiRouter } from "./routes/api.js";
import type { RequestWithRawBody } from "./services/selfGate.js";
import {
  ATTRIBUTION_TAG,
  CELO_CHAIN_ID,
  CONTRACTS,
  DEFAULT_PAYOUT_CORRIDOR,
} from "./config/celo.js";
import { getAgentAddress } from "./services/celoWallet.js";
import { initStore } from "./services/store.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve(process.cwd(), "public");

app.use(cors());

// Capture exact raw request body for Self Agent ID cryptographic signature verification
app.use(
  express.json({
    limit: "1mb",
    verify: (req, _res, buf) => {
      (req as RequestWithRawBody).rawBody = buf.toString("utf8");
    },
  })
);

// ERC-8004 Agent Registration Manifest
/** PUBLIC_BASE_URL with a scheme and without a trailing slash. */
function publicBaseUrl(): string {
  const raw = (process.env.PUBLIC_BASE_URL || "").trim().replace(/\/+$/, "");
  if (!raw) return `http://localhost:${PORT}`;
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function buildRegistrationManifest() {
  const baseUrl = publicBaseUrl();
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: "ProofPay",
    description:
      "AI payout agent for businesses hiring remote freelancers. Vets deliverables against task briefs, gates autonomous payouts with Self Agent ID per-human caps and x402, converts USDT to local stablecoins (cNGN default, plus wBRL, IDRX, wARS, wMXN, wCOP) via Textile FX on Celo mainnet, and issues verifiable public trust receipts.",
    image: `${baseUrl}/logo.svg`,
    active: true,
    chainId: CELO_CHAIN_ID,
    agentWallet: getAgentAddress(),
    attributionTag: ATTRIBUTION_TAG,
    defaultCorridor: DEFAULT_PAYOUT_CORRIDOR,
    services: [
      {
        name: "web",
        endpoint: baseUrl,
      },
      {
        name: "x402-payout",
        endpoint: `${baseUrl}/api/agent/payout`,
        protocol: "x402",
        network: `eip155:${CELO_CHAIN_ID}`,
      },
      {
        name: "textile-rfq-corridors",
        endpoint: `${baseUrl}/api/corridors`,
      },
    ],
    registrations: process.env.ERC8004_AGENT_ID
      ? [
          {
            agentId: Number(process.env.ERC8004_AGENT_ID),
            agentRegistry: `eip155:${CELO_CHAIN_ID}:${CONTRACTS.ERC8004_IDENTITY_REGISTRY}`,
          },
        ]
      : [],
  };
}

app.get("/registration.json", (_req, res) => {
  res.json(buildRegistrationManifest());
});

app.get("/.well-known/agent.json", (_req, res) => {
  res.json(buildRegistrationManifest());
});

app.use("/api", apiRouter);
app.use(express.static(PUBLIC_DIR, { extensions: ["html"] }));

app.get("/receipt/:id", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "receipt.html"));
});

// The payouts app; the landing page is public/index.html at "/".
app.get("/app", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "app.html"));
});

// Freelancer-facing task page: the link a client sends to the freelancer.
app.get("/t/:id", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "task.html"));
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

initStore()
  .then((storage) => {
    app.listen(PORT, () => {
      console.log(`ProofPay listening on http://localhost:${PORT} (storage: ${storage})`);
    });
  })
  .catch((err) => {
    console.error("Could not open storage:", err);
    process.exit(1);
  });
