const { $, esc, api, num, usd, fiatSymbol, rateDigits, dateTime, txLink, addressLink, reviewEngineLabel, copyText } = window.PP;

function row(label, value) {
  return `<div class="row"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

async function init() {
  const id = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");
  const { ok, data } = await api(`/api/receipts/${encodeURIComponent(id)}`);
  $("receipt-loading").hidden = true;

  if (!ok || !data.receipt) {
    $("receipt-error").hidden = false;
    return;
  }

  const r = data.receipt;
  const p = r.payout;
  const sym = fiatSymbol(p.buyToken);
  const live = p.mode === "mainnet";

  document.title = `ProofPay · Receipt for ${r.taskTitle}`;
  $("r-top").classList.add(live ? "is-paid" : "is-preview");
  $("r-to-label").textContent = live ? "Paid to" : "Preview for";
  $("r-to").textContent = r.freelancerName;
  $("r-badge").innerHTML = live ? `<span class="pill paid">Paid</span>` : `<span class="pill">Preview, not sent</span>`;
  $("r-amount").innerHTML = `${sym}${esc(p.buyAmountFormatted)}<small>${esc(p.buyToken)}</small>`;
  $("r-sub").textContent = live
    ? `${usd(p.sellAmountUsd)} USD₮ converted on Textile FX and sent on Celo`
    : "Approved on a server with no agent wallet, so nothing was sent";

  $("r-client").textContent = r.businessName;
  $("r-task").textContent = r.taskTitle;
  $("r-budget").textContent = `${usd(p.sellAmountUsd)} USD₮`;
  $("r-rate").textContent = `1 USD₮ = ${sym}${num(p.effectiveRate, rateDigits(p.effectiveRate))}`;
  $("r-date").textContent = dateTime(r.createdAt);
  $("r-wallet").innerHTML = addressLink(r.freelancerWallet, true);

  $("r-delivery").innerHTML = `<a href="${esc(r.deliverableUrl)}" target="_blank" rel="noopener">Open the work</a>`;
  $("r-review").textContent = `${r.aiReviewVerdict === "PASS" ? "Passed" : "Flagged"} · ${r.aiReviewScore}/100`;
  $("r-hash").textContent = `${r.deliverableHash.slice(0, 18)}…${r.deliverableHash.slice(-8)}`;
  $("r-hash").title = r.deliverableHash;
  $("r-review-summary").textContent = `${reviewEngineLabel(r.reviewEngine)}. ${r.aiReviewSummary}`;

  $("r-approver").textContent = r.approvedBy;
  if (r.approvalMethod === "self-agent" && r.selfVerification) {
    $("r-method").textContent = "Agent API, Self Agent ID verified";
    $("r-self-row").hidden = false;
    $("r-self").textContent = `#${r.selfVerification.agentId}`;
  } else {
    $("r-method").textContent = `Approved in ProofPay, ${dateTime(r.approvedAt)}`;
  }
  $("r-cap").textContent = r.capCheck
    ? `${usd(r.capCheck.spentTodayUsd)} of ${usd(r.capCheck.dailyCapUsd)}`
    : "–";

  const onchain = [];
  if (live) {
    if (r.fundingTxHash) {
      const who = window.PP.shortAddr(r.fundedBy || "");
      onchain.push(row(r.fundingMethod === "altana" ? `Taken under the client's Altana limit from ${who}` : `Paid in by ${who}`, txLink(r.fundingTxHash)));
    }
    if (p.approvalTxHash) onchain.push(row("USD₮ approval", txLink(p.approvalTxHash)));
    onchain.push(row("Textile FX conversion", txLink(p.swapTxHash)));
    onchain.push(row(`${p.buyToken} to freelancer`, txLink(p.payoutTxHash)));
    if (r.x402TxHash) onchain.push(row("x402 fee", txLink(r.x402TxHash)));
    onchain.push(row("Attribution tag", p.attributionVerified ? "Found in the transactions" : "Not confirmed"));
  } else {
    onchain.push(row("Transactions", '<span class="muted">None. Preview mode sends nothing.</span>'));
  }
  $("r-onchain").innerHTML = onchain.join("");
  $("r-tag").textContent = r.attributionTag;

  $("receipt").hidden = false;
}

$("print-btn").addEventListener("click", () => window.print());
$("copy-link-btn").addEventListener("click", () => copyText(location.href, $("copy-link-btn")));

init();
