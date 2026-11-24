# ProofPay

**Pay freelancers in naira once their work is checked.** A business funds a job in USD₮. The freelancer submits the work from a link. ProofPay checks the delivery against the brief's checklist, and when the business approves, it converts the USD₮ to cNGN on Textile FX and sends it to the freelancer's own Celo wallet, with a public receipt for every step.

Built for [Agents Open for Business](https://www.loops.house/agents-open-for-business) on Celo mainnet (chain 42220).

## Why

Nigerian freelancers paid by remote clients usually lose money and days between the dollar invoice and naira in their account: platform fees, slow transfers and the gap between the official and the street rate. ProofPay pays straight into the freelancer's own Celo wallet in cNGN (MetaMask shows it once cNGN is imported as a token) at the rate Textile FX makers quote at that moment, and only after the client has seen the work.

## How a payout works

1. **Create a payout.** The client sets a brief, an acceptance checklist, a budget in USD₮ and the freelancer's Celo wallet. The wallet can't be ProofPay's own agent wallet.
2. **Freelancer delivers.** They open `/t/<payoutId>`, see what they'll receive in naira, and submit a link plus notes.
3. **ProofPay checks it.** It opens the link, fingerprints the delivery (SHA-256), and with `GEMINI_API_KEY` set, Gemini reads the delivered page, image or PDF and judges each checklist line. Without a key, or when the link is private, a rule-based check runs instead. The receipt names which one ran (`src/services/aiReviewer.ts`).
4. **Client approves.** ProofPay requests a firm Textile FX RFQ quote, approves USD₮ to the reactor, broadcasts the swap, then transfers exactly the cNGN the swap delivered to the freelancer. Each step's transaction is on the receipt at `/receipt/<id>`.

### Where the client's money comes from

- **Pay into the escrow contract.** With `ESCROW_ADDRESS` set, the client's wallet approves USD₮ and calls `fund` on `ProofPayEscrow` (`contracts/ProofPayEscrow.sol`). The contract has no owner: only the wallet that paid in can `release` (to the agent, which converts and pays the freelancer) or `refund` (back to itself). ProofPay checks the payout can go ahead (`POST /api/tasks/:id/approve?check=1`) before the client releases, then verifies the `Released` event before converting. Without `ESCROW_ADDRESS`, the client sends USD₮ to the agent wallet instead, approves with a wallet signature, and refunds are sent back by the agent.
- **Keep it in an Altana wallet.** The client opens a passkey Altana wallet and grants ProofPay a session key that can call only USD₮, with a spend cap of the budget plus $0.50 for fees, until an expiry they pick. Nothing moves until they approve; ProofPay then pulls exactly the budget with `execute` and converts it. Rejecting revokes the session onchain. See **Altana** below.
- **Operator.** Unfunded payouts can only be released with `OPERATOR_KEY`.

## Tracks

**Stablecoin Corridors (Textile FX).** USD₮ → cNGN by default, plus wBRL, IDRX, wARS, wMXN and wCOP. Payouts go to wallets outside the team.

- RFQ client: `src/services/textileFx.ts` (`/v2/rfq/preview`, `/v2/rfq/request`, `/v2/rfq/{id}/submit`), following the [v2 RFQ docs](https://fx-docs.textilecredit.com/api/v2/rfq.html): EIP-712 TakerControl proof with millisecond `issuedAt`, `no_quote` handling, allowance reset for USD₮, and an `expiresAt` check before the swap is broadcast.
- The payout transfer sends the measured balance change from the swap, never pre-existing balance.

**Self Agent ID: Verified Agent Payments.** `POST /api/agent/payout` lets other agents release payouts for checked work.

- `src/services/selfGate.ts`: requests without an `x-self-agent-signature` get HTTP 403 before any quote. Signed requests are verified by `SelfAgentVerifier` from `@selfxyz/agent-sdk` on Celo mainnet, over the raw request body.
- The daily limit is keyed to the human's nullifier, so a second agent run by the same person shares the first one's limit (HTTP 429).
- Verified requests then pay a 0.01 USD₮ fee over x402 through `https://api.x402.celo.org` (`src/services/x402Service.ts`).

**Altana Agent Wallets.** The client keeps custody; ProofPay acts under a session the chain enforces.

- Browser (`public/altana.js`, loaded on demand from the SDK's ESM bundle): `createPasskeyWallet` / `recoverFromPasskey`, `grantSession` with `permissions.calls` = USD₮ only, `permissions.spend` = budget + fee headroom per month, `feeToken` USD₮, and `appCode` set to the attribution tag. `register: true` also lists the key in the KeyStore (about 9.2 CELO); the default skips that.
- Server (`src/services/altana.ts`): `checkSession` rejects a session that expires within 10 minutes, can't call USD₮, or caps below the budget. The session key is stored AES-256-GCM encrypted; the client gets a one-time owner token (only its hash is stored) that approving and revoking require.
- On approval, `pullBudget` runs `execute` with the session to transfer the budget to the agent, then the normal Textile FX payout runs. The receipt shows the pull transaction as "Taken under the client's Altana limit".

## Attribution

Every transaction ProofPay sends goes through one wallet client, extended with `withAttribution("celo_325d8d38061f")` from `@celo/attribution-tags` (`src/services/celoWallet.ts`). After each transaction, `verifyTx` checks that the tag is in the calldata and the result is stored on the receipt. Reverted transactions throw instead of being recorded.

x402 settlements are submitted by the Celo facilitator, which doesn't write attribution tags yet; they're credited by PayTo address.

## Run it

```bash
npm install
cp .env.example .env
npm run test:e2e      # live Textile rates and RFQ preview, delivery review, per-human limit
npm run dev           # landing page at http://localhost:3000, the app at /app
```

Without `AGENT_PRIVATE_KEY` the server runs in **preview mode**: rates and quotes are live from Textile FX, but approving a payout broadcasts nothing, and the UI and receipt say so. Set the key (a dedicated wallet holding USD₮ and a little CELO for gas) to pay out on mainnet. On mainnet, a payout the client paid into is approved with their wallet signature, and one under an Altana limit with their owner token; anything else needs `OPERATOR_KEY`, because it would spend the agent wallet's own USD₮.

### Escrow contract

```bash
npm run compile:contracts     # solc 0.8.28 + OpenZeppelin SafeERC20 / ReentrancyGuard
npm run test:escrow           # 11 contract checks on a local chain (ganache)
npm run build && npm run test:escrow-server   # the real server against the local chain
npm run deploy:escrow         # Celo mainnet, from the agent wallet; then set ESCROW_ADDRESS
```

### Register the agent (ERC-8004)

```bash
# needs AGENT_PRIVATE_KEY and a public PUBLIC_BASE_URL in .env
npm run register:erc8004
```

The registration file is served at `/registration.json` and `/.well-known/agent.json`.

## Code map

| | |
|---|---|
| Token and contract addresses | `src/config/celo.ts` |
| Tagged wallet client, `verifyTx` | `src/services/celoWallet.ts` |
| Textile FX RFQ client and payout | `src/services/textileFx.ts` |
| Self Agent ID gate, per-human limit | `src/services/selfGate.ts` |
| x402 verify and settle | `src/services/x402Service.ts` |
| Delivery review (Gemini or rule-based) and fingerprint | `src/services/aiReviewer.ts` |
| Altana session checks, encrypted key, budget pull | `src/services/altana.ts` |
| Escrow contract and its tests | `contracts/ProofPayEscrow.sol`, `scripts/test-escrow*.ts` |
| Storage (Postgres via `DATABASE_URL`, else a JSON file) | `src/services/store.ts` |
| API routes | `src/routes/api.ts` |
| Landing page (`/`), app (`/app`), freelancer page (`/t/:id`), receipt (`/receipt/:id`) | `public/` |

## License

MIT
