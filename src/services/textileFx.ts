import crypto from "node:crypto";
import {
  formatUnits,
  parseUnits,
  toHex,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import {
  CELO_CHAIN_ID,
  FUNDING_TOKENS,
  PAYOUT_CORRIDORS,
  type CorridorToken,
} from "../config/celo.js";
import {
  agentWallet,
  getAgentAddress,
  getTokenAllowance,
  getTokenBalance,
  resetTokenAllowance,
  sendTaggedTransaction,
  transferLocalStablecoin,
} from "./celoWallet.js";

// Textile FX v2 RFQ API: https://fx-docs.textilecredit.com/api/v2/rfq.html
const TEXTILE_API_URL =
  process.env.TEXTILE_API_URL || "https://api.textilecredit.com";

// A firm request can hold up to ~70 s on a cold corridor (docs: use 75 s).
const FIRM_REQUEST_TIMEOUT_MS = 75_000;
const RATES_CACHE_MS = 30_000;

/**
 * Where a displayed rate came from.
 * - textile-live: Textile rates feed, fetched within the cache window
 * - stale: last good Textile rate, the latest refresh failed
 * - fallback: Textile has not been reachable since the server started
 */
export type RateSource = "textile-live" | "stale" | "fallback";

export interface LiveCorridorRate {
  code: string;
  symbol: string;
  name: string;
  country: string;
  fiatSymbol: string;
  tokenAddress: Address;
  decimals: number;
  tickerId: string;
  rate: number;
  bid: number;
  ask: number;
  volumeUsd24h: number;
  source: RateSource;
  fetchedAt: string | null;
}

export interface RfqPreviewResult {
  corridor: string;
  sellToken: string;
  sellAmountUsd: number;
  sellAmountAtomic: string;
  buyToken: string;
  buyAmountAtomic: string;
  buyAmountFormatted: string;
  effectiveRate: number;
  source: "textile-rfq-preview" | "textile-rates-feed" | "fallback";
  quotedAt: string;
  /** Textile protocol fee in sell-token atomic units (RFQ preview only). */
  feeAmountAtomic?: string;
  noQuoteReason?: string;
}

export interface ExecutedTextilePayout {
  mode: "mainnet" | "preview";
  rfqId: string | null;
  sellToken: string;
  sellAmountUsd: number;
  buyToken: string;
  buyAmountAtomic: string;
  buyAmountFormatted: string;
  effectiveRate: number;
  feeAmountAtomic?: string | null;
  approvalTxHash: Hash | null;
  swapTxHash: Hash | null;
  payoutTxHash: Hash | null;
  attributionVerified: boolean;
  recipient: Address;
  quotedAt?: string;
}

interface TextileTicker {
  ticker_id: string;
  last_price: string;
  bid: string;
  ask: string;
  base_volume: string;
}

interface RfqPreviewData {
  status: "preview" | "no_quote";
  sellAmount?: string;
  buyAmount?: string;
  feeAmount?: string;
  takerPays?: string;
  reason?: string;
}

interface RfqFirmData {
  rfqId: string;
  claimToken?: string;
  status: "quoted" | "no_quote";
  reason?: string;
  availableSellAmount?: string;
  retryAfterMs?: number;
  quote?: {
    sellAmount: string;
    buyAmount: string;
    feeAmount: string;
    takerPays: string;
    expiresAt: string;
    reactor: Address;
    taker: Address;
  };
  transactions?: {
    approval: { to: Address; data: Hex; value?: string };
    swap: { to: Address; data: Hex; value?: string };
  };
}

// Used only if Textile has never answered since the server started.
// The UI labels these as indicative, never as live.
const FALLBACK_RATES: Record<string, number> = {
  cNGN: 1450.0,
  wBRL: 6.0,
  IDRX: 18300.0,
  wARS: 1760.0,
  wMXN: 19.1,
  wCOP: 3500.0,
};

let lastGoodRates: { fetchedAt: number; rates: LiveCorridorRate[] } | null =
  null;

function textileHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extra,
  };
  if (process.env.TEXTILE_API_KEY) {
    headers["Authorization"] = `Bearer ${process.env.TEXTILE_API_KEY}`;
  }
  return headers;
}

function formatAmount(value: number): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function buildRates(
  tickersById: Map<string, TextileTicker>,
  source: RateSource,
  fetchedAt: number | null
): LiveCorridorRate[] {
  return Object.values(PAYOUT_CORRIDORS).map((corridor: CorridorToken) => {
    const ticker = tickersById.get(corridor.tickerId);
    const last = ticker ? Number(ticker.last_price) : 0;
    const bid = ticker ? Number(ticker.bid) : 0;
    const ask = ticker ? Number(ticker.ask) : 0;
    const hasLive = last > 0;
    const rate = hasLive ? last : FALLBACK_RATES[corridor.code] || 1;
    return {
      code: corridor.code,
      symbol: corridor.symbol,
      name: corridor.name,
      country: corridor.country,
      fiatSymbol: corridor.fiatSymbol,
      tokenAddress: corridor.address,
      decimals: corridor.decimals,
      tickerId: corridor.tickerId,
      rate,
      bid: bid > 0 ? bid : rate,
      ask: ask > 0 ? ask : rate,
      volumeUsd24h: ticker ? Number(ticker.base_volume) || 0 : 0,
      source: hasLive ? source : "fallback",
      fetchedAt: hasLive && fetchedAt ? new Date(fetchedAt).toISOString() : null,
    };
  });
}

export async function getLiveCorridorRates(): Promise<LiveCorridorRate[]> {
  if (lastGoodRates && Date.now() - lastGoodRates.fetchedAt < RATES_CACHE_MS) {
    return lastGoodRates.rates;
  }

  try {
    const res = await fetch(`${TEXTILE_API_URL}/tickers`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`Textile tickers HTTP ${res.status}`);
    const list = (await res.json()) as TextileTicker[];
    const tickersById = new Map(list.map((t) => [t.ticker_id, t]));
    const fetchedAt = Date.now();
    const rates = buildRates(tickersById, "textile-live", fetchedAt);
    lastGoodRates = { fetchedAt, rates };
    return rates;
  } catch {
    if (lastGoodRates) {
      return lastGoodRates.rates.map((r) =>
        r.source === "textile-live" ? { ...r, source: "stale" as const } : r
      );
    }
    return buildRates(new Map(), "fallback", null);
  }
}

export async function previewTextileQuote(params: {
  corridorCode: string;
  sellAmountUsd: number;
  sellTokenCode?: "USDT" | "USDC";
}): Promise<RfqPreviewResult> {
  const corridor = PAYOUT_CORRIDORS[params.corridorCode];
  if (!corridor) {
    throw new Error(`Unsupported payout corridor: ${params.corridorCode}`);
  }
  const sellToken = FUNDING_TOKENS[params.sellTokenCode || "USDT"];
  const sellAmountAtomic = parseUnits(
    params.sellAmountUsd.toFixed(sellToken.decimals),
    sellToken.decimals
  ).toString();

  let noQuoteReason: string | undefined;

  try {
    const res = await fetch(`${TEXTILE_API_URL}/v2/rfq/preview`, {
      method: "POST",
      headers: textileHeaders(),
      body: JSON.stringify({
        chainId: CELO_CHAIN_ID,
        sellToken: sellToken.address,
        buyToken: corridor.address,
        sellAmount: sellAmountAtomic,
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.ok) {
      const body = (await res.json()) as { data?: RfqPreviewData };
      const data = body.data;
      if (data?.status === "preview" && data.buyAmount) {
        const buyAmountNum = Number(
          formatUnits(BigInt(data.buyAmount), corridor.decimals)
        );
        return {
          corridor: corridor.code,
          sellToken: sellToken.code,
          sellAmountUsd: params.sellAmountUsd,
          sellAmountAtomic,
          buyToken: corridor.code,
          buyAmountAtomic: data.buyAmount,
          buyAmountFormatted: formatAmount(buyAmountNum),
          effectiveRate:
            params.sellAmountUsd > 0 ? buyAmountNum / params.sellAmountUsd : 0,
          source: "textile-rfq-preview",
          quotedAt: new Date().toISOString(),
          feeAmountAtomic: data.feeAmount,
        };
      }
      if (data?.status === "no_quote") {
        noQuoteReason = data.reason || "no_quote";
      }
    }
  } catch {
    // Fall through to the rates feed below.
  }

  const rates = await getLiveCorridorRates();
  const match = rates.find((r) => r.code === corridor.code);
  const rate = match?.rate || FALLBACK_RATES[corridor.code] || 1;
  const buyAmountNum = params.sellAmountUsd * rate;
  const buyAmountAtomic = parseUnits(
    buyAmountNum.toFixed(Math.min(corridor.decimals, 6)),
    corridor.decimals
  ).toString();

  return {
    corridor: corridor.code,
    sellToken: sellToken.code,
    sellAmountUsd: params.sellAmountUsd,
    sellAmountAtomic,
    buyToken: corridor.code,
    buyAmountAtomic,
    buyAmountFormatted: formatAmount(buyAmountNum),
    effectiveRate: rate,
    source: match && match.source !== "fallback" ? "textile-rates-feed" : "fallback",
    quotedAt: match?.fetchedAt || new Date().toISOString(),
    noQuoteReason,
  };
}

/**
 * EIP-712 TakerControl proof for keyless firm quotes.
 * issuedAt is Unix milliseconds and must be within 60 s of Textile's clock.
 * https://fx-docs.textilecredit.com/api/v2/authentication.html#proof-of-control
 */
async function signTakerControlProof(taker: Address): Promise<{
  nonce: Hex;
  issuedAt: number;
  signature: Hex;
}> {
  if (!agentWallet) {
    throw new Error("Agent wallet required to sign Textile TakerControl proof");
  }

  const nonce = toHex(crypto.randomBytes(32));
  const issuedAt = Date.now();

  const signature = await agentWallet.signTypedData({
    account: agentWallet.account!,
    domain: {
      name: "Textile Taker Control",
      version: "1",
      chainId: CELO_CHAIN_ID,
    },
    types: {
      TakerControl: [
        { name: "taker", type: "address" },
        { name: "chainId", type: "uint256" },
        { name: "nonce", type: "bytes32" },
        { name: "issuedAt", type: "uint256" },
      ],
    },
    primaryType: "TakerControl",
    message: {
      taker,
      chainId: BigInt(CELO_CHAIN_ID),
      nonce,
      issuedAt: BigInt(issuedAt),
    },
  });

  return { nonce, issuedAt, signature };
}

async function requestFirmQuote(body: Record<string, unknown>): Promise<RfqFirmData> {
  const send = async (extra: Record<string, unknown> = {}) =>
    fetch(`${TEXTILE_API_URL}/v2/rfq/request`, {
      method: "POST",
      headers: textileHeaders(),
      body: JSON.stringify({ ...body, ...extra }),
      signal: AbortSignal.timeout(FIRM_REQUEST_TIMEOUT_MS),
    });

  let res = await send();
  // Keyless callers prove wallet control once per ~12 h; Textile asks with a 401.
  if (res.status === 401 && !process.env.TEXTILE_API_KEY) {
    const takerProof = await signTakerControlProof(body.taker as Address);
    res = await send({ takerProof });
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Textile FX firm quote failed (HTTP ${res.status}): ${errText}`);
  }

  const parsed = (await res.json()) as { data?: RfqFirmData };
  if (!parsed.data) {
    throw new Error("Textile FX firm quote returned no data");
  }
  return parsed.data;
}

export async function executeTextileSwapAndPayout(params: {
  corridorCode: string;
  sellAmountUsd: number;
  recipient: Address;
  sellTokenCode?: "USDT" | "USDC";
  allowPreviewFallback?: boolean;
}): Promise<ExecutedTextilePayout> {
  const corridor = PAYOUT_CORRIDORS[params.corridorCode];
  if (!corridor) {
    throw new Error(`Unsupported corridor: ${params.corridorCode}`);
  }
  const sellToken = FUNDING_TOKENS[params.sellTokenCode || "USDT"];
  const taker = getAgentAddress();

  if (!taker || !agentWallet) {
    if (!params.allowPreviewFallback) {
      throw new Error(
        "AGENT_PRIVATE_KEY is not configured for live Celo mainnet execution."
      );
    }
    const preview = await previewTextileQuote({
      corridorCode: corridor.code,
      sellAmountUsd: params.sellAmountUsd,
      sellTokenCode: params.sellTokenCode,
    });
    return {
      mode: "preview",
      rfqId: null,
      sellToken: sellToken.code,
      sellAmountUsd: params.sellAmountUsd,
      buyToken: corridor.code,
      buyAmountAtomic: preview.buyAmountAtomic,
      buyAmountFormatted: preview.buyAmountFormatted,
      effectiveRate: preview.effectiveRate,
      feeAmountAtomic: null,
      approvalTxHash: null,
      swapTxHash: null,
      payoutTxHash: null,
      attributionVerified: false,
      recipient: params.recipient,
      quotedAt: preview.quotedAt,
    };
  }

  const sellAmountAtomic = parseUnits(
    params.sellAmountUsd.toFixed(sellToken.decimals),
    sellToken.decimals
  ).toString();

  // 1. Firm quote, bound to the agent wallet as taker.
  const rfq = await requestFirmQuote({
    chainId: CELO_CHAIN_ID,
    sellToken: sellToken.address,
    buyToken: corridor.address,
    sellAmount: sellAmountAtomic,
    taker,
  });

  if (rfq.status === "no_quote" || !rfq.quote || !rfq.transactions) {
    const retry = rfq.retryAfterMs ? ` Retry in ${Math.ceil(rfq.retryAfterMs / 1000)} s.` : "";
    throw new Error(
      `Textile FX has no quote for ${params.sellAmountUsd} ${sellToken.code} -> ${corridor.code} right now (${rfq.reason || "no_quote"}).${retry}`
    );
  }

  const { quote, transactions } = rfq;
  const required = BigInt(quote.takerPays);
  const reactor = quote.reactor;

  // 2. Approve takerPays to the reactor if the standing allowance is short.
  let approvalTxHash: Hash | null = null;
  const allowance = await getTokenAllowance(sellToken.address, taker, reactor);
  if (allowance < required) {
    if (allowance > 0n) {
      await resetTokenAllowance({ tokenAddress: sellToken.address, spender: reactor });
    }
    const approval = await sendTaggedTransaction({
      to: transactions.approval.to,
      data: transactions.approval.data,
      value: transactions.approval.value ? BigInt(transactions.approval.value) : 0n,
    });
    approvalTxHash = approval.hash;
  }

  // 3. Never broadcast a quote past its accept cutoff.
  if (Date.now() >= Date.parse(quote.expiresAt)) {
    throw new Error("Textile FX quote expired during approval. Request a new payout.");
  }

  // 4. Broadcast the swap from the attribution-tagged agent wallet.
  const balanceBefore = await getTokenBalance(corridor.address, taker);
  const swapResult = await sendTaggedTransaction({
    to: transactions.swap.to,
    data: transactions.swap.data,
    value: transactions.swap.value ? BigInt(transactions.swap.value) : 0n,
  });

  if (rfq.claimToken) {
    await fetch(`${TEXTILE_API_URL}/v2/rfq/${rfq.rfqId}/submit`, {
      method: "POST",
      headers: textileHeaders({ "X-Rfq-Claim": rfq.claimToken }),
      body: JSON.stringify({ txHash: swapResult.hash }),
    }).catch(() => {
      // Reporting is a courtesy; settlement is reconciled onchain.
    });
  }

  // 5. Pay out exactly what the swap delivered, never pre-existing balance.
  const balanceAfter = await getTokenBalance(corridor.address, taker);
  const delivered = balanceAfter - balanceBefore;
  if (delivered <= 0n) {
    throw new Error(
      `Textile FX swap ${swapResult.hash} confirmed but delivered no ${corridor.code} to the agent wallet.`
    );
  }

  const payoutResult = await transferLocalStablecoin({
    tokenAddress: corridor.address,
    recipient: params.recipient,
    amount: delivered,
  });

  const buyAmountNum = Number(formatUnits(delivered, corridor.decimals));

  return {
    mode: "mainnet",
    rfqId: rfq.rfqId,
    sellToken: sellToken.code,
    sellAmountUsd: params.sellAmountUsd,
    buyToken: corridor.code,
    buyAmountAtomic: delivered.toString(),
    buyAmountFormatted: formatAmount(buyAmountNum),
    effectiveRate: params.sellAmountUsd > 0 ? buyAmountNum / params.sellAmountUsd : 0,
    feeAmountAtomic: quote.feeAmount,
    approvalTxHash,
    swapTxHash: swapResult.hash,
    payoutTxHash: payoutResult.hash,
    attributionVerified:
      swapResult.attributionVerified && payoutResult.attributionVerified,
    recipient: params.recipient,
    quotedAt: new Date().toISOString(),
  };
}
