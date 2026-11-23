import type { Address } from "viem";

export const CELO_CHAIN_ID = 42220;
export const CELO_CAIP2 = "eip155:42220";
export const CELO_RPC_URL = process.env.CELO_RPC_URL || "https://forno.celo.org";
export const CELO_EXPLORER_TX = "https://celoscan.io/tx/";
export const CELO_EXPLORER_ADDRESS = "https://celoscan.io/address/";

// Assigned hackathon attribution tag (ERC-8021)
export const ATTRIBUTION_TAG =
  process.env.CELO_ATTRIBUTION_TAG || "celo_325d8d38061f";

// Canonical Celo Mainnet protocol contracts
export const CONTRACTS = {
  TEXTILE_LIMIT_ORDER_REACTOR:
    "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3" as Address,
  ERC8004_IDENTITY_REGISTRY:
    "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432" as Address,
  PERMIT2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
} as const;

export interface CorridorToken {
  code: string;
  symbol: string;
  name: string;
  country: string;
  flag: string;
  fiatSymbol: string;
  address: Address;
  decimals: number;
  tickerId: string;
  x402ExtraName: string;
  x402ExtraVersion: string;
  transferMethod: "eip3009" | "permit2";
}

export const FUNDING_TOKENS: Record<string, CorridorToken> = {
  USDT: {
    code: "USDT",
    symbol: "USD₮",
    name: "Tether USD",
    country: "Global USD",
    flag: "USD",
    fiatSymbol: "$",
    address: "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e",
    decimals: 6,
    tickerId: "USDT_USDT",
    x402ExtraName: "Tether USD",
    x402ExtraVersion: "1",
    transferMethod: "eip3009",
  },
  USDC: {
    code: "USDC",
    symbol: "USDC",
    name: "USD Coin",
    country: "Global USD",
    flag: "USD",
    fiatSymbol: "$",
    address: "0xcebA9300f2b948710d2653dD7B07f33A8B32118C",
    decimals: 6,
    tickerId: "USDC_USDT",
    x402ExtraName: "USDC",
    x402ExtraVersion: "2",
    transferMethod: "eip3009",
  },
};

// Local stablecoin corridors supported on Textile FX (Celo Mainnet)
// Default payout corridor is cNGN (Nigerian Naira)
export const PAYOUT_CORRIDORS: Record<string, CorridorToken> = {
  cNGN: {
    code: "cNGN",
    symbol: "cNGN",
    name: "Compliant Nigerian Naira",
    country: "Nigeria",
    flag: "NG",
    fiatSymbol: "₦",
    address: "0xF6829D7393dAe24509eb1E52eE8e572e2E271a4f",
    decimals: 6,
    tickerId: "USDT_NGN",
    x402ExtraName: "cNGN",
    x402ExtraVersion: "1",
    transferMethod: "permit2",
  },
  wBRL: {
    code: "wBRL",
    symbol: "wBRL",
    name: "Ripio Brazilian Real",
    country: "Brazil",
    flag: "BR",
    fiatSymbol: "R$",
    address: "0xD76f5Faf6888e24D9F04Bf92a0c8B921FE4390e0",
    decimals: 18,
    tickerId: "USDT_WBRL",
    x402ExtraName: "Real Brasileño",
    x402ExtraVersion: "1",
    transferMethod: "permit2",
  },
  IDRX: {
    code: "IDRX",
    symbol: "IDRX",
    name: "Indonesian Rupiah",
    country: "Indonesia",
    flag: "ID",
    fiatSymbol: "Rp",
    address: "0x18Bc5bcC660cf2B9cE3cd51a404aFe1a0cBD3C22",
    decimals: 2,
    tickerId: "USDT_IDR",
    x402ExtraName: "IDRX",
    x402ExtraVersion: "1",
    transferMethod: "permit2",
  },
  wARS: {
    code: "wARS",
    symbol: "wARS",
    name: "Ripio Argentine Peso",
    country: "Argentina",
    flag: "AR",
    fiatSymbol: "ARS ",
    address: "0x0DC4F92879B7670e5f4e4e6e3c801D229129D90D",
    decimals: 18,
    tickerId: "USDT_WARS",
    x402ExtraName: "Peso Argentino",
    x402ExtraVersion: "1",
    transferMethod: "permit2",
  },
  wMXN: {
    code: "wMXN",
    symbol: "wMXN",
    name: "Ripio Mexican Peso",
    country: "Mexico",
    flag: "MX",
    fiatSymbol: "MX$",
    address: "0x337E7456B420bD3481e7FA61fA9850343d610d34",
    decimals: 18,
    tickerId: "USDT_MXN",
    x402ExtraName: "Peso Mexicano",
    x402ExtraVersion: "1",
    transferMethod: "permit2",
  },
  wCOP: {
    code: "wCOP",
    symbol: "wCOP",
    name: "Ripio Colombian Peso",
    country: "Colombia",
    flag: "CO",
    fiatSymbol: "COP ",
    address: "0x8a1D45e102e886510e891d2Ec656a708991e2D76",
    decimals: 18,
    tickerId: "USDT_COP",
    x402ExtraName: "Peso Colombiano",
    x402ExtraVersion: "1",
    transferMethod: "permit2",
  },
};

export const DEFAULT_PAYOUT_CORRIDOR = "cNGN";

export const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "transfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;
