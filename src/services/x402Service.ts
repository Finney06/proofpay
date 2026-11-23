import type { Request, Response } from "express";
import { CELO_CAIP2, FUNDING_TOKENS } from "../config/celo.js";
import { getAgentAddress } from "./celoWallet.js";

const X402_FACILITATOR_URL =
  process.env.X402_FACILITATOR_URL || "https://api.x402.celo.org";

export interface X402PaymentRequirement {
  scheme: "exact";
  network: string;
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  extra: {
    name: string;
    version: string;
  };
}

export function buildX402Requirement(params: {
  resource: string;
  description: string;
  amountAtomicUsd6?: string;
}): X402PaymentRequirement {
  const usdt = FUNDING_TOKENS.USDT;
  const payTo =
    process.env.X402_PAY_TO ||
    getAgentAddress() ||
    "0x0000000000000000000000000000000000000000";

  return {
    scheme: "exact",
    network: CELO_CAIP2,
    maxAmountRequired: params.amountAtomicUsd6 || "10000", // $0.01 USDT default
    asset: usdt.address,
    payTo,
    resource: params.resource,
    description: params.description,
    extra: {
      name: usdt.x402ExtraName,
      version: usdt.x402ExtraVersion,
    },
  };
}

/**
 * Verifies and settles an incoming X-PAYMENT header via the hosted Celo x402 facilitator
 * at https://api.x402.celo.org.
 */
export async function verifyAndSettleX402(params: {
  req: Request;
  res: Response;
  requirement: X402PaymentRequirement;
}): Promise<{ settled: boolean; txHash?: string; error?: string }> {
  const paymentHeader =
    params.req.headers["x-payment"] || params.req.headers["payment-signature"];

  if (!paymentHeader || typeof paymentHeader !== "string") {
    params.res.status(402).json({
      x402Version: 2,
      error: "Payment Required",
      accepts: [params.requirement],
      facilitator: X402_FACILITATOR_URL,
    });
    return { settled: false };
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (process.env.X402_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.X402_API_KEY}`;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(
      Buffer.from(paymentHeader, "base64").toString("utf8")
    );
  } catch {
    payload = paymentHeader;
  }

  const verifyRes = await fetch(`${X402_FACILITATOR_URL}/verify`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      paymentPayload: payload,
      paymentRequirements: params.requirement,
    }),
  });

  if (!verifyRes.ok) {
    const text = await verifyRes.text();
    params.res.status(402).json({
      error: "X402_VERIFY_FAILED",
      details: text,
      accepts: [params.requirement],
    });
    return { settled: false, error: text };
  }

  const settleRes = await fetch(`${X402_FACILITATOR_URL}/settle`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      paymentPayload: payload,
      paymentRequirements: params.requirement,
    }),
  });

  if (!settleRes.ok) {
    const text = await settleRes.text();
    params.res.status(402).json({
      error: "X402_SETTLE_FAILED",
      details: text,
      accepts: [params.requirement],
    });
    return { settled: false, error: text };
  }

  const settled = (await settleRes.json()) as {
    transaction?: string;
    txHash?: string;
  };
  return {
    settled: true,
    txHash: settled.transaction || settled.txHash,
  };
}
