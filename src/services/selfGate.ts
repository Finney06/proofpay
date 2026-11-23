import type { Request, Response, NextFunction } from "express";
import { SelfAgentVerifier } from "@selfxyz/agent-sdk";

export interface VerifiedHumanContext {
  verified: boolean;
  agentId: string;
  humanNullifier: string;
  sybilCount: number;
  verificationSource: "self-mainnet-sdk";
}

export interface CapCheckResult {
  allowed: boolean;
  humanNullifier: string;
  spentTodayUsd: number;
  requestedUsd: number;
  dailyCapUsd: number;
  remainingUsd: number;
  reason?: string;
}

export interface RequestWithRawBody extends Request {
  rawBody?: string;
  verifiedAgent?: VerifiedHumanContext;
}

export const PER_HUMAN_DAILY_CAP_USD = Number(
  process.env.PER_HUMAN_DAILY_CAP_USD || 25
);
export const AUTO_PAY_MAX_USD = Number(process.env.AUTO_PAY_MAX_USD || 3);

// SelfAgentVerifier targets Celo Mainnet (Chain ID 42220) by default.
// It verifies signed agent requests against on-chain ERC-8004 Proof-of-Human registrations.
export const selfVerifier = SelfAgentVerifier.create()
  .requireAge(18)
  .requireOFAC()
  .sybilLimit(3)
  .build();

/**
 * Express middleware that verifies Self Agent ID signatures against the raw
 * request body (never re-serialized JSON) on Celo Mainnet.
 * Unverified agents are explicitly rejected with HTTP 403 before any FX swap or payout.
 */
const selfAuth = selfVerifier.auth();

export function requireSelfAgentId(
  req: RequestWithRawBody,
  res: Response,
  next: NextFunction
): void {
  // @selfxyz/agent-sdk signs requests with x-self-agent-signature and
  // x-self-agent-timestamp over the exact body bytes.
  if (!req.headers["x-self-agent-signature"]) {
    res.status(403).json({
      error: "SELF_AGENT_ID_REQUIRED",
      status: "rejected",
      message:
        "This endpoint only serves agents backed by a verified human. Sign the request with a Self Agent ID; nothing was quoted or sent.",
      howToFix:
        "Register the agent with Self Agent ID (https://docs.self.xyz/docs/agent-id/overview/) and sign the raw request body with @selfxyz/agent-sdk.",
    });
    return;
  }

  // The SDK middleware answers 401/429/503 itself on failure and only calls
  // next() when the signature and the onchain human proof check out.
  selfAuth(req, res, (err?: unknown) => {
    if (err) {
      res.status(403).json({
        error: "SELF_VERIFICATION_REJECTED",
        status: "rejected",
        message: err instanceof Error ? err.message : "Self Agent ID verification failed",
      });
      return;
    }

    const agent = req.agent;
    if (!agent) {
      res.status(403).json({
        error: "SELF_VERIFICATION_FAILED",
        status: "rejected",
        message: "Self Agent ID signature could not be verified on Celo mainnet.",
      });
      return;
    }

    req.verifiedAgent = {
      verified: true,
      agentId: agent.agentId.toString(),
      humanNullifier: agent.nullifier.toString(),
      sybilCount: Number(agent.agentCount),
      verificationSource: "self-mainnet-sdk",
    };
    next();
  });
}

/**
 * Evaluates ProofPay's Self-native anti-sybil rule:
 * One human = one shared daily payout cap across all agents linked to their passport nullifier.
 */
export function evaluateSharedHumanCap(params: {
  humanNullifier: string;
  spentTodayUsd: number;
  requestedUsd: number;
  dailyCapUsd?: number;
}): CapCheckResult {
  const cap = params.dailyCapUsd ?? PER_HUMAN_DAILY_CAP_USD;
  const projected = Number((params.spentTodayUsd + params.requestedUsd).toFixed(2));
  const remainingBefore = Math.max(0, Number((cap - params.spentTodayUsd).toFixed(2)));

  if (projected > cap) {
    return {
      allowed: false,
      humanNullifier: params.humanNullifier,
      spentTodayUsd: params.spentTodayUsd,
      requestedUsd: params.requestedUsd,
      dailyCapUsd: cap,
      remainingUsd: remainingBefore,
      reason: `Shared per-human daily cap exceeded ($${params.spentTodayUsd.toFixed(
        2
      )} already spent + $${params.requestedUsd.toFixed(
        2
      )} requested > $${cap.toFixed(
        2
      )} cap across all agents linked to this verified human).`,
    };
  }

  return {
    allowed: true,
    humanNullifier: params.humanNullifier,
    spentTodayUsd: params.spentTodayUsd,
    requestedUsd: params.requestedUsd,
    dailyCapUsd: cap,
    remainingUsd: Math.max(0, Number((cap - projected).toFixed(2))),
  };
}
