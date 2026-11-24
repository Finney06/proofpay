const { $, esc, api, postJson, num, usd, fiatSymbol, rateDigits, timeAgo, dateTime, clock, txLink, addressLink, shortAddr, payoutStatus, badge, reviewEngineLabel, copyText, ICON } = window.PP;

const state = {
  health: null,
  corridors: [],
  tasks: [],
  receipts: [],
  filter: "all",
  openId: null,
  convCode: "cNGN",
  approving: null,
  errors: {},
};

function corridor(code) {
  return state.corridors.find((c) => c.code === code);
}

function estimateLocal(code, usdAmount) {
  const c = corridor(code);
  if (!c) return "";
  return `${c.fiatSymbol}${num(usdAmount * c.rate, 0)}`;
}

function receiptFor(task) {
  return task.receiptId ? state.receipts.find((r) => r.id === task.receiptId) : null;
}

function freelancerLink(task) {
  return `${location.origin}/t/${encodeURIComponent(task.id)}`;
}

function lastUpdated(task, receipt) {
  return (
    receipt?.createdAt ||
    task.approval?.approvedAt ||
    task.aiReview?.reviewedAt ||
    task.submission?.submittedAt ||
    task.createdAt
  );
}

/* ---------- Health ---------- */
async function loadHealth() {
  const { ok, data } = await api("/api/health");
  const env = $("env");
  if (!ok) {
    env.innerHTML = `<span class="pill on-dark">Status unavailable</span>`;
    return;
  }
  state.health = data;

  if (data.executionMode === "mainnet" && data.agentWallet) {
    env.innerHTML = `
      <span class="agent">Agent ${addressLink(data.agentWallet)} · ${num(data.balances?.usdt)} USD₮</span>
      <span class="pill live">Celo mainnet</span>`;
    $("preview-notice").hidden = true;
  } else {
    env.innerHTML = `<span class="pill on-dark gold">Preview</span>`;
    $("preview-notice").hidden = false;
  }

  const cap = data.guardrails?.perHumanDailyCapUsd;
  if (cap != null) {
    $("rule-client-cap").textContent = usd(cap);
    $("rule-human-cap").textContent = usd(cap);
  }
  $("rule-tag").textContent = data.attributionTag || "–";
}

/* ---------- Rates ---------- */
async function loadCorridors() {
  const { ok, data } = await api("/api/corridors");
  if (!ok) {
    $("conv-source").textContent = "Couldn't load rates.";
    $("conv-source").className = "source-line warn";
    return;
  }
  const firstLoad = state.corridors.length === 0;
  state.corridors = data.corridors || [];
  if (firstLoad) {
    $("corridorCode").innerHTML = state.corridors
      .map((c) => `<option value="${esc(c.code)}">${esc(c.code)} · ${esc(c.country)}</option>`)
      .join("");
    $("corridorCode").value = "cNGN";
  }
  renderCorridors();
  renderPayouts();
  await updateConverter();
}

function renderCorridors() {
  $("corridor-grid").innerHTML = state.corridors
    .map((c) => {
      const indicative = c.source === "fallback" ? " *" : "";
      return `
        <button type="button" class="corridor-btn${c.code === state.convCode ? " active" : ""}" data-code="${esc(c.code)}">
          <strong>${esc(c.code)} · ${esc(c.country)}</strong>
          <span>${esc(c.fiatSymbol)}${num(c.rate, rateDigits(c.rate))}${indicative}</span>
        </button>`;
    })
    .join("");
  $("corridor-grid").querySelectorAll(".corridor-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.convCode = btn.dataset.code;
      renderCorridors();
      updateConverter();
    })
  );
}

let convTimer = null;
let convSeq = 0;

async function updateConverter() {
  const amount = Number($("conv-usd").value);
  const code = state.convCode;
  const source = $("conv-source");
  $("conv-code-tag").textContent = code;

  if (!Number.isFinite(amount) || amount < 1) {
    $("conv-out").textContent = "–";
    source.textContent = "Textile FX quotes start at 1 USD₮.";
    source.className = "source-line";
    return;
  }

  const seq = ++convSeq;
  const { ok, data } = await postJson("/api/quote", { corridorCode: code, sellAmountUsd: amount });
  if (seq !== convSeq) return;

  if (!ok) {
    $("conv-out").textContent = "–";
    source.textContent = data.error || "No price available right now.";
    source.className = "source-line warn";
    return;
  }

  $("conv-out").textContent = `${fiatSymbol(code)}${data.buyAmountFormatted}`;
  const rate = `1 USD₮ = ${fiatSymbol(code)}${num(data.effectiveRate, rateDigits(data.effectiveRate))}`;
  if (data.source === "textile-rfq-preview") {
    source.textContent = `${rate} · live Textile FX quote at ${clock(data.quotedAt).slice(0, 5)}. The firm price is set when you approve.`;
    source.className = "source-line";
  } else if (data.source === "textile-rates-feed") {
    const why = data.noQuoteReason ? "No maker priced this exact size just now, so this uses the rates feed. " : "";
    source.textContent = `${rate} · ${why}Textile FX at ${clock(data.quotedAt).slice(0, 5)}.`;
    source.className = data.noQuoteReason ? "source-line warn" : "source-line";
  } else {
    source.textContent = `${rate} · Textile FX can't be reached, so this is an indicative rate, not a live one.`;
    source.className = "source-line warn";
  }
}

/* ---------- Payouts ---------- */
async function loadPayouts() {
  const [tasksRes, receiptsRes] = await Promise.all([api("/api/tasks"), api("/api/receipts")]);
  if (tasksRes.ok) state.tasks = tasksRes.data.tasks || [];
  if (receiptsRes.ok) state.receipts = receiptsRes.data.receipts || [];
  renderStats();
  renderPayouts();
}

function renderStats() {
  const live = state.receipts.filter((r) => r.payout?.mode === "mainnet");
  const previews = state.receipts.length - live.length;
  const paidUsd = live.reduce((sum, r) => sum + Number(r.payout.sellAmountUsd || 0), 0);

  $("stat-paid").innerHTML = usd(paidUsd) + (previews > 0 && live.length === 0 ? `<small>${previews} in preview</small>` : "");
  $("stat-freelancers").textContent = String(new Set(live.map((r) => r.freelancerWallet.toLowerCase())).size);
  $("stat-approve").textContent = String(state.tasks.filter((t) => t.status === "VETTED").length);

  const durations = live
    .map((r) => {
      const task = state.tasks.find((t) => t.id === r.taskId);
      const from = task?.submission?.submittedAt;
      return from ? Date.parse(r.approvedAt) - Date.parse(from) : null;
    })
    .filter((ms) => ms != null && ms >= 0)
    .sort((a, b) => a - b);

  if (durations.length === 0) {
    $("stat-time").textContent = "–";
  } else {
    const minutes = Math.max(1, Math.round(durations[Math.floor(durations.length / 2)] / 60000));
    $("stat-time").innerHTML = minutes < 120 ? `${minutes} min<small>typical</small>` : `${Math.round(minutes / 60)} h<small>typical</small>`;
  }
}

function matchesFilter(status) {
  if (state.filter === "all") return true;
  if (state.filter === "approve") return status.key === "approve" || status.key === "flagged";
  if (state.filter === "paid") return status.key === "paid" || status.key === "preview";
  return status.key === state.filter;
}

function renderPayouts() {
  const list = $("payout-list");
  const counts = { all: 0, waiting: 0, approve: 0, paid: 0 };

  const items = state.tasks.map((task) => {
    const receipt = receiptFor(task);
    const status = payoutStatus(task, receipt);
    counts.all += 1;
    if (status.key === "waiting") counts.waiting += 1;
    if (status.key === "approve" || status.key === "flagged") counts.approve += 1;
    if (status.key === "paid" || status.key === "preview") counts.paid += 1;
    return { task, receipt, status };
  });

  document.querySelectorAll("[data-count]").forEach((el) => {
    el.textContent = String(counts[el.dataset.count] ?? 0);
  });

  if (state.tasks.length === 0) {
    list.innerHTML = `
      <div class="empty">
        <strong>No payouts yet</strong>
        <span>Post your first job, then send the freelancer their link.</span>
        <button class="btn small" type="button" data-action="new">New payout</button>
      </div>`;
    list.querySelector("[data-action=new]").addEventListener("click", openDialog);
    return;
  }

  const visible = items.filter((i) => matchesFilter(i.status));
  if (visible.length === 0) {
    list.innerHTML = `<div class="empty">Nothing here right now.</div>`;
    return;
  }

  list.innerHTML = visible
    .map(({ task, receipt, status }) => {
      const open = state.openId === task.id;
      const est = estimateLocal(task.corridorCode, task.budgetUsd);
      const local = receipt
        ? `${fiatSymbol(receipt.payout.buyToken)}${esc(receipt.payout.buyAmountFormatted)} ${esc(receipt.payout.buyToken)}`
        : est
          ? `about ${est} ${esc(task.corridorCode)}`
          : esc(task.corridorCode);
      return `
        <article class="payout${open ? " open" : ""}" data-id="${esc(task.id)}">
          <button class="payout-row" type="button" aria-expanded="${open}">
            <span>
              <span class="title">${esc(task.title)}</span><br />
              <span class="who">${esc(task.freelancerName)} · for ${esc(task.businessName)}</span>
            </span>
            <span class="money">
              <span class="usd">${usd(task.budgetUsd)}</span><br />
              <span class="local">${local}</span>
            </span>
            <span class="meta-line">${badge(status)}<span>${esc(timeAgo(lastUpdated(task, receipt)))}</span></span>
          </button>
          ${open ? `<div class="payout-detail">${renderDetail(task, receipt, status)}</div>` : ""}
        </article>`;
    })
    .join("");

  list.querySelectorAll(".payout").forEach((card) => {
    card.querySelector(".payout-row").addEventListener("click", () => {
      state.openId = state.openId === card.dataset.id ? null : card.dataset.id;
      renderPayouts();
    });
  });
  list.querySelectorAll("[data-approve]").forEach((btn) => btn.addEventListener("click", () => approve(btn.dataset.approve)));
  list.querySelectorAll("[data-fund]").forEach((btn) => btn.addEventListener("click", () => fundPayout(btn.dataset.fund)));
  list.querySelectorAll("[data-refund]").forEach((btn) => btn.addEventListener("click", () => refundPayout(btn.dataset.refund)));
  list.querySelectorAll("[data-limit]").forEach((btn) => btn.addEventListener("click", () => openLimitSheet(btn.dataset.limit)));
  list.querySelectorAll("[data-revoke]").forEach((btn) => btn.addEventListener("click", () => cancelLimit(btn.dataset.revoke)));
  list.querySelectorAll("[data-copy]").forEach((btn) => btn.addEventListener("click", () => copyText(btn.dataset.copy, btn)));
}

function renderChecks(task) {
  const review = task.aiReview;
  if (!review) {
    const items = task.checklist.length ? task.checklist : ["Matches the brief"];
    return items
      .map((item) => `<li><span class="mark">${ICON.dot}</span><span>${esc(item)}<small>Checked when the work comes in</small></span></li>`)
      .join("");
  }
  return review.checks
    .map(
      (c) => `<li class="${c.passed ? "pass" : "fail"}"><span class="mark">${c.passed ? ICON.check : ICON.cross}</span><span>${esc(c.item)}<small>${esc(c.note)}</small></span></li>`
    )
    .join("");
}

function step(done, time, title, detail) {
  return `<li class="${done ? "" : "todo"}"><span class="dot">${done ? ICON.check : ICON.dot}</span><div><div class="ev">${title}</div>${detail ? `<small>${detail}</small>` : ""}${time ? `<time>${esc(dateTime(time))}</time>` : ""}</div></li>`;
}

function renderDetail(task, receipt, status) {
  const review = task.aiReview;
  const sub = task.submission;
  const payout = receipt?.payout;
  const live = payout && payout.mode === "mainnet";
  const est = estimateLocal(task.corridorCode, task.budgetUsd);

  const steps = [
    step(true, task.createdAt, "Payout created", `${usd(task.budgetUsd)} USD₮, paid out in ${esc(task.corridorCode)}`),
    ...(task.funding ? [step(true, task.funding.fundedAt, `Paid in by ${esc(shortAddr(task.funding.funder))}`, txLink(task.funding.txHash))] : []),
    ...(task.altana
      ? [step(true, task.altana.grantedAt, `Spending limit set on ${esc(shortAddr(task.altana.wallet))}`, task.altana.grantTxHash ? txLink(task.altana.grantTxHash) : "Altana wallet")]
      : []),
    ...(task.altana?.revokedAt ? [step(true, task.altana.revokedAt, "You cancelled the limit", task.altana.revokeTxHash ? txLink(task.altana.revokeTxHash) : "")] : []),
    sub
      ? step(true, sub.submittedAt, "Work handed in", `<a href="${esc(sub.deliverableUrl)}" target="_blank" rel="noopener">${esc(sub.deliverableUrl)}</a>`)
      : step(false, null, `Waiting for ${esc(task.freelancerName)} to hand in the work`, ""),
    review
      ? step(true, review.reviewedAt, review.verdict === "PASS" ? "Checked: everything passed" : "Checked: some items need a look", `${review.checks.filter((c) => c.passed).length} of ${review.checks.length} checks passed`)
      : step(false, null, "Checked", ""),
    task.approval ? step(true, task.approval.approvedAt, "You approved", "") : step(false, null, "Your approval", ""),
  ];

  if (payout && live) {
    steps.push(step(true, receipt.createdAt, "Converted on Textile FX", txLink(payout.swapTxHash)));
    steps.push(step(true, receipt.createdAt, `Paid ${fiatSymbol(payout.buyToken)}${esc(payout.buyAmountFormatted)} ${esc(payout.buyToken)}`, txLink(payout.payoutTxHash)));
  } else if (payout) {
    steps.push(step(true, receipt.createdAt, "Approved in preview", "Nothing was sent. The rate came from Textile FX."));
  } else {
    steps.push(step(false, null, `Paid in ${esc(task.corridorCode)}`, ""));
  }

  let actions = "";
  const busy = state.approving === task.id;
  const funded = task.funding && task.funding.status === "funded";
  const limited = task.altana && task.altana.status === "granted";
  const closed = ["PAID", "REFUNDED", "CANCELLED"].includes(task.status);
  const canFund = !funded && !limited && !closed && state.health?.executionMode === "mainnet";
  const fundBtn = canFund
    ? `<button class="btn small" type="button" data-fund="${esc(task.id)}" ${busy ? "disabled" : ""}>${busy && state.busyLabel ? esc(state.busyLabel) : `Pay in ${usd(task.budgetUsd)} from your wallet`}</button>
       <button class="btn secondary small" type="button" data-limit="${esc(task.id)}" ${busy ? "disabled" : ""}>Keep it in my wallet instead</button>`
    : "";
  const refundBtn = funded && task.status !== "PAID"
    ? `<button class="btn secondary small" type="button" data-refund="${esc(task.id)}" ${busy ? "disabled" : ""}>Reject and refund</button>`
    : limited && !closed
    ? `<button class="btn secondary small" type="button" data-revoke="${esc(task.id)}" ${busy ? "disabled" : ""}>Reject and cancel the limit</button>`
    : "";
  const heldNote = funded
    ? `<span class="hint">${usd(task.budgetUsd)} is held. It goes to ${esc(task.freelancerName)} only when you approve.</span>`
    : limited
    ? `<span class="hint">Your ${usd(task.budgetUsd)} stays in your Altana wallet until you approve. The limit ends ${esc(dateTime(new Date(task.altana.session.expiry * 1000).toISOString()))}.</span>`
    : "";

  if (status.key === "waiting") {
    actions = `
      ${fundBtn}
      <button class="btn ${canFund ? "secondary " : ""}small" type="button" data-copy="${esc(freelancerLink(task))}">Copy freelancer link</button>
      <a class="btn secondary small" href="/t/${esc(task.id)}" target="_blank" rel="noopener">Open their page</a>
      ${refundBtn}
      ${heldNote || (canFund ? `<span class="hint">Paying in first shows your freelancer the money is ready.</span>` : "")}`;
  } else if (status.key === "approve" || status.key === "flagged") {
    const label = busy ? (state.busyLabel ? esc(state.busyLabel) : "Converting on Textile FX…") : `${status.key === "flagged" ? "Approve anyway, pay" : "Approve and pay"} ${usd(task.budgetUsd)}`;
    actions = `
      ${canFund ? fundBtn : `<button class="btn paid small" type="button" data-approve="${esc(task.id)}" ${busy ? "disabled" : ""}>${label}</button>`}
      ${refundBtn}
      <a class="btn secondary small" href="/t/${esc(task.id)}" target="_blank" rel="noopener">Open their page</a>
      <span class="hint">${canFund ? "Pay in, or keep the money in your wallet with a spending limit, then approve." : status.key === "flagged" ? "Some checks failed. Open the work before you pay." : `${esc(task.freelancerName)} gets about ${esc(est)} ${esc(task.corridorCode)}.`}</span>`;
  } else if (task.status === "REFUNDED") {
    actions = `<span class="hint">Refunded to ${esc(shortAddr(task.funding?.funder || ""))}. ${task.funding?.refundTxHash ? txLink(task.funding.refundTxHash) : ""}</span>`;
  } else if (task.status === "CANCELLED") {
    actions = `<span class="hint">You cancelled the spending limit. Nothing left your wallet.</span>`;
  } else if (receipt) {
    actions = `
      <a class="btn small" href="/receipt/${esc(receipt.id)}">View receipt</a>
      <button class="btn secondary small" type="button" data-copy="${esc(`${location.origin}/receipt/${receipt.id}`)}">Copy receipt link</button>`;
  }

  return `
    <div class="detail-grid">
      <div class="detail-card">
        <h3>Brief</h3>
        <p>${esc(task.brief)}</p>
        ${sub ? `<h3>What they said they delivered</h3><p>${esc(sub.deliverableNotes)}</p>` : ""}
        <h3>Checklist</h3>
        <ul class="checks">${renderChecks(task)}</ul>
        ${review ? `<div class="review-line"><span>${esc(reviewEngineLabel(review.engine))}</span><span>${review.score}/100</span></div>` : ""}
      </div>
      <div class="detail-card">
        <h3>Progress</h3>
        <ol class="activity">${steps.join("")}</ol>
        <p class="small muted">${live ? "Paid to" : "Pays to"} ${addressLink(task.freelancerWallet, true)}</p>
      </div>
    </div>
    <div class="detail-actions">${actions}</div>
    ${state.errors[task.id] ? `<p class="form-error inline-error">${esc(state.errors[task.id])}</p>` : ""}`;
}

function readOperatorKey() {
  try {
    return sessionStorage.getItem("proofpay.operatorKey") || "";
  } catch {
    return "";
  }
}

function saveOperatorKey(key) {
  try {
    if (key) sessionStorage.setItem("proofpay.operatorKey", key);
    else sessionStorage.removeItem("proofpay.operatorKey");
  } catch {
    // Storage unavailable: the key is asked for again next time.
  }
}

/* ---------- Client wallet: MiniPay, Valora or any browser wallet ---------- */
const CELO_CHAIN_HEX = "0xa4ec";

function walletProvider() {
  return window.ethereum || null;
}

async function connectWallet() {
  const eth = walletProvider();
  if (!eth) {
    throw new Error("Open this page in MiniPay, Valora or MetaMask's browser to pay from your wallet.");
  }
  const [account] = await eth.request({ method: "eth_requestAccounts" });
  const chainId = await eth.request({ method: "eth_chainId" });
  if (String(chainId).toLowerCase() !== CELO_CHAIN_HEX) {
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: CELO_CHAIN_HEX }] });
    } catch (err) {
      if (err && err.code === 4902) {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: CELO_CHAIN_HEX, chainName: "Celo", nativeCurrency: { name: "CELO", symbol: "CELO", decimals: 18 }, rpcUrls: ["https://forno.celo.org"], blockExplorerUrls: ["https://celoscan.io"] }],
        });
      } else {
        throw new Error("Switch your wallet to the Celo network and try again.");
      }
    }
  }
  return account;
}

function toHexUtf8(text) {
  return "0x" + Array.from(new TextEncoder().encode(text)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signAs(expected, message) {
  const account = await connectWallet();
  if (expected && account.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Switch to the wallet that paid in (${shortAddr(expected)}) and try again.`);
  }
  return walletProvider().request({ method: "personal_sign", params: [toHexUtf8(message), account] });
}

function walletError(err) {
  if (err && err.code === 4001) return "You cancelled in your wallet. Nothing was sent.";
  return (err && err.message) || "Something went wrong with your wallet.";
}

async function fundPayout(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || state.approving) return;
  state.approving = taskId;
  state.busyLabel = "Waiting for your wallet…";
  delete state.errors[taskId];
  renderPayouts();
  try {
    const info = await api(`/api/tasks/${encodeURIComponent(taskId)}/funding`);
    if (!info.ok) throw new Error(info.data.message || info.data.error || "Funding isn't available right now.");
    const from = await connectWallet();
    const txHash = await walletProvider().request({
      method: "eth_sendTransaction",
      params: [{ from, to: info.data.token, data: info.data.data, value: "0x0" }],
    });
    state.busyLabel = "Confirming on Celo…";
    renderPayouts();
    const res = await postJson(`/api/tasks/${encodeURIComponent(taskId)}/fund`, { txHash });
    if (!res.ok) throw new Error(res.data.error || "Couldn't confirm the payment.");
  } catch (err) {
    state.errors[taskId] = walletError(err);
  }
  state.approving = null;
  state.busyLabel = null;
  await loadPayouts();
}

async function refundPayout(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || state.approving || !task.funding) return;
  if (!window.confirm(`Reject the work and send ${usd(task.budgetUsd)} USD₮ back to your wallet?`)) return;
  state.approving = taskId;
  state.busyLabel = "Refunding…";
  delete state.errors[taskId];
  renderPayouts();
  try {
    const signature = await signAs(task.funding.funder, `Refund ProofPay payout ${task.id}`);
    const res = await postJson(`/api/tasks/${encodeURIComponent(taskId)}/refund`, { signature });
    if (!res.ok) throw new Error(res.data.error || "Refund failed.");
  } catch (err) {
    state.errors[taskId] = walletError(err);
  }
  state.approving = null;
  state.busyLabel = null;
  await loadPayouts();
}

async function approve(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || state.approving) return;

  const limited = task.altana && task.altana.status === "granted";
  const grant = limited ? savedLimit(taskId) : null;
  if (limited && !grant) {
    state.errors[taskId] = "Approve from the browser where you set the spending limit.";
    renderPayouts();
    return;
  }

  if (state.health?.executionMode === "mainnet") {
    const est = estimateLocal(task.corridorCode, task.budgetUsd);
    const ok = window.confirm(
      `Pay ${usd(task.budgetUsd)} USD₮ to ${task.freelancerName}?\n\n${limited ? "ProofPay takes it from your Altana wallet, converts it" : "It converts"} to about ${est} ${task.corridorCode} on Textile FX and goes to ${task.freelancerWallet} on Celo. This can't be undone.`
    );
    if (!ok) return;
  }

  state.approving = taskId;
  delete state.errors[taskId];
  renderPayouts();

  let body = "{}";
  const headers = { "Content-Type": "application/json" };
  if (grant) {
    headers["x-owner-token"] = grant.ownerToken;
  } else if (task.funding && task.funding.status === "funded") {
    try {
      const signature = await signAs(task.funding.funder, `Approve ProofPay payout ${task.id}`);
      body = JSON.stringify({ signature });
    } catch (err) {
      state.approving = null;
      state.errors[taskId] = walletError(err);
      renderPayouts();
      return;
    }
  }

  const send = () =>
    api(`/api/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: "POST",
      headers: { ...headers, "x-operator-key": readOperatorKey() },
      body,
    });

  let { ok, status, data } = await send();
  if (status === 401 && data.error === "OPERATOR_KEY_REQUIRED" && /operator/.test(data.message || "") && !/Fund this payout/.test(data.message || "")) {
    const key = window.prompt("Operator key (needed to release mainnet payouts):");
    if (key) {
      saveOperatorKey(key.trim());
      ({ ok, status, data } = await send());
    }
  }

  state.approving = null;
  if (!ok) {
    if (status === 401) saveOperatorKey("");
    state.errors[taskId] = data.message || data.error || "Payout failed.";
  }
  await Promise.all([loadPayouts(), loadHealth()]);
}

/* ---------- Altana spending limit: the money stays in the client's wallet ---------- */
const USDT_ADDRESS = "0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e";
const ATTRIBUTION_SUFFIX = "63656c6f5f333235643864333830363166110080218021802180218021802180218021";
const FEE_HEADROOM_ATOMIC = 500000n; // $0.50 for Altana's network fee, paid in USD₮
const REGISTRY_CELO = 9.3;
const limitSheet = $("limit-sheet");
const limitState = { taskId: null, wallet: null, balance: null };
let altanaModule = null;

function loadAltana() {
  if (!altanaModule) altanaModule = import("/altana.js?v=1");
  return altanaModule;
}

function savedLimit(taskId) {
  try {
    return JSON.parse(localStorage.getItem(`proofpay.altana.${taskId}`) || "null");
  } catch {
    return null;
  }
}

function limitNeedAtomic(task) {
  return BigInt(Math.round(task.budgetUsd * 1e6)) + FEE_HEADROOM_ATOMIC;
}

function limitError(message) {
  $("limit-error").textContent = message || "";
  $("limit-error").hidden = !message;
}

function limitBusy(btn, label) {
  if (!btn.dataset.label) btn.dataset.label = btn.textContent;
  btn.disabled = Boolean(label);
  btn.textContent = label || btn.dataset.label;
}

function openLimitSheet(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  limitState.taskId = taskId;
  limitState.wallet = null;
  limitState.balance = null;
  $("limit-amount").textContent = usd(task.budgetUsd);
  $("limit-step-wallet").classList.remove("done");
  $("limit-open-row").hidden = false;
  $("limit-wallet").hidden = true;
  $("limit-step-topup").hidden = true;
  $("limit-step-grant").hidden = true;
  $("limit-register").checked = false;
  limitError("");
  loadAltana().catch(() => limitError("Couldn't load Altana. Check your connection and try again."));
  limitSheet.showModal();
}

async function refreshLimitBalance() {
  const task = state.tasks.find((t) => t.id === limitState.taskId);
  if (!task || !limitState.wallet) return;
  const { ok, data } = await api(`/api/balance/${limitState.wallet.address}`);
  if (!ok) {
    limitError(data.error || "Couldn't read the wallet's balance.");
    return;
  }
  limitState.balance = data;
  $("limit-balance").textContent = `${usd(data.usdt)} USD₮ · ${num(data.celo, 2)} CELO`;
  const need = limitNeedAtomic(task);
  const have = BigInt(data.usdtAtomic);
  const short = have < need;
  $("limit-step-topup").hidden = !short;
  $("limit-step-grant").hidden = short;
  $("limit-grant-num").textContent = short ? "3" : "2";
  if (short) {
    $("limit-topup-text").textContent = `It holds ${usd(data.usdt)}. Add ${usd(Number(need - have) / 1e6)} USD₮ so it covers ${usd(task.budgetUsd)} plus Altana's small network fee. The money is still yours: only you can move it, apart from the limit you set next.`;
  }
}

async function openLimitWallet(create) {
  const btn = create ? $("limit-create") : $("limit-open");
  limitError("");
  limitBusy(btn, create ? "Creating…" : "Opening…");
  try {
    const mod = await loadAltana();
    limitState.wallet = await mod.openWallet(create);
    $("limit-address").textContent = limitState.wallet.address;
    $("limit-open-row").hidden = true;
    $("limit-wallet").hidden = false;
    $("limit-step-wallet").classList.add("done");
    await refreshLimitBalance();
  } catch (err) {
    const cancelled = err && (err.name === "NotAllowedError" || /cancel|not allowed/i.test(err.message || ""));
    limitError(
      cancelled
        ? create
          ? "Passkey cancelled. Nothing was created."
          : "No wallet opened. If you haven't made one on this device yet, tap “First time? Create one”."
        : (err && err.message) || "Couldn't open the wallet."
    );
  }
  limitBusy(btn, null);
}

async function topUpLimitWallet() {
  const task = state.tasks.find((t) => t.id === limitState.taskId);
  if (!task || !limitState.wallet || !limitState.balance) return;
  const btn = $("limit-topup");
  limitError("");
  limitBusy(btn, "Waiting for your wallet…");
  try {
    const amount = limitNeedAtomic(task) - BigInt(limitState.balance.usdtAtomic);
    const data =
      "0xa9059cbb" +
      limitState.wallet.address.slice(2).toLowerCase().padStart(64, "0") +
      amount.toString(16).padStart(64, "0") +
      ATTRIBUTION_SUFFIX;
    const from = await connectWallet();
    await walletProvider().request({ method: "eth_sendTransaction", params: [{ from, to: USDT_ADDRESS, data, value: "0x0" }] });
    limitBusy(btn, "Confirming on Celo…");
    for (let i = 0; i < 10; i += 1) {
      await new Promise((r) => setTimeout(r, 3000));
      await refreshLimitBalance();
      if ($("limit-step-topup").hidden) break;
    }
  } catch (err) {
    limitError(walletError(err));
  }
  limitBusy(btn, null);
}

async function grantLimit() {
  const task = state.tasks.find((t) => t.id === limitState.taskId);
  if (!task || !limitState.wallet) return;
  const register = $("limit-register").checked;
  if (register && (limitState.balance?.celo || 0) < REGISTRY_CELO) {
    limitError(`Listing in the registry needs about ${REGISTRY_CELO} CELO in the Altana wallet. Untick it, or add CELO first.`);
    return;
  }
  const btn = $("limit-grant");
  limitError("");
  limitBusy(btn, "Confirm with your passkey…");
  try {
    const mod = await loadAltana();
    await mod.grant({
      taskId: task.id,
      wallet: limitState.wallet,
      budgetAtomic: limitNeedAtomic(task).toString(),
      days: Number($("limit-days").value),
      register,
    });
    limitSheet.close();
    await loadPayouts();
  } catch (err) {
    limitError((err && err.message) || "Couldn't set the limit.");
  }
  limitBusy(btn, null);
}

async function cancelLimit(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || state.approving) return;
  if (!window.confirm(`Reject the work and cancel the spending limit? ${usd(task.budgetUsd)} stays in your wallet and ${task.freelancerName} isn't paid.`)) return;
  state.approving = taskId;
  delete state.errors[taskId];
  renderPayouts();
  try {
    const mod = await loadAltana();
    await mod.revoke(taskId);
  } catch (err) {
    state.errors[taskId] = (err && err.message) || "Couldn't cancel the limit.";
  }
  state.approving = null;
  await loadPayouts();
}

$("limit-open").addEventListener("click", () => openLimitWallet(false));
$("limit-create").addEventListener("click", () => openLimitWallet(true));
$("limit-topup").addEventListener("click", topUpLimitWallet);
$("limit-recheck").addEventListener("click", () => refreshLimitBalance());
$("limit-copy").addEventListener("click", (e) => limitState.wallet && copyText(limitState.wallet.address, e.currentTarget));
$("limit-grant").addEventListener("click", grantLimit);
$("limit-close").addEventListener("click", () => limitSheet.close());

/* ---------- New payout ---------- */
const dialog = $("new-payout");

function setDialogMode(done) {
  $("form-fields").hidden = done;
  $("form-done").hidden = !done;
  $("form-cancel").hidden = done;
  $("form-submit").hidden = done;
  $("done-open").hidden = !done;
  $("done-close").hidden = !done;
}

function openDialog() {
  $("payout-form").reset();
  $("budgetUsd").value = "10000";
  setPriceUnit("local");
  $("corridorCode").value = "cNGN";
  $("form-error").hidden = true;
  fieldMessage($("freelancerWallet"), "");
  fieldMessage($("budgetUsd"), "");
  setDialogMode(false);
  updateEstimate();
  dialog.showModal();
  $("businessName").focus();
}

// The client can agree the price in the payout currency (naira by default) or in dollars.
let priceUnit = "local";

function setPriceUnit(unit) {
  priceUnit = unit;
  document.querySelectorAll(".unit-switch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.unit === unit)));
  updateEstimate();
  validateBudget(false);
}

function localSymbol() {
  const c = corridor($("corridorCode").value);
  return c ? c.fiatSymbol : "";
}

/** The budget in USD₮, whichever currency the price was typed in. */
function priceUsd() {
  const v = Number($("budgetUsd").value);
  if (!Number.isFinite(v) || v <= 0) return NaN;
  if (priceUnit === "usd") return v;
  const c = corridor($("corridorCode").value);
  return c && c.rate > 0 ? v / c.rate : NaN;
}

function updateEstimate() {
  const code = $("corridorCode").value;
  $("unit-local").textContent = localSymbol() || "₦";
  const usdAmount = priceUsd();
  const label = $("form-estimate").querySelector("span");
  const out = $("form-estimate").querySelector("strong");
  if (!Number.isFinite(usdAmount)) {
    out.textContent = "–";
    return;
  }
  if (priceUnit === "usd") {
    label.textContent = "Your freelancer receives about";
    out.textContent = usdAmount >= 1 ? `${estimateLocal(code, usdAmount)} ${code}` : "–";
  } else {
    label.textContent = "You fund about";
    out.textContent = `${usd(Math.ceil(usdAmount * 100) / 100)} USD₮`;
  }
}

function fillExample() {
  $("businessName").value = "Lagos Brand Studio";
  $("title").value = "Logo refresh: 3 PNG exports";
  $("brief").value = "Clean up our logo and export it for the website and social media. Keep the wordmark, tighten the spacing, use our green.";
  $("checklist").value = "PNG at 512px and 1024px\nTransparent background\nUses brand green #0C7A4B";
  $("budgetUsd").value = "7500";
  $("corridorCode").value = "cNGN";
  setPriceUnit("local");
  $("freelancerName").value = "Tunde Adebayo";
  $("freelancerWallet").value = "";
  updateEstimate();
  $("freelancerWallet").focus();
}

function fieldMessage(input, message) {
  let el = input.parentElement.querySelector(".field-error");
  if (!message) {
    input.removeAttribute("aria-invalid");
    if (el) el.remove();
    return true;
  }
  if (!el) {
    el = document.createElement("span");
    el.className = "field-error";
    el.setAttribute("role", "alert");
    input.insertAdjacentElement("afterend", el);
  }
  input.setAttribute("aria-invalid", "true");
  el.textContent = message;
  return false;
}

function validateWallet(force) {
  const input = $("freelancerWallet");
  const v = input.value.trim();
  if (!v && !force) return fieldMessage(input, "");
  if (!v) return fieldMessage(input, "Paste the freelancer's wallet address.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
    return fieldMessage(input, "That doesn't look like a Celo address. It starts with 0x and has 42 characters.");
  }
  const agent = state.health?.agentWallet;
  if (agent && v.toLowerCase() === agent.toLowerCase()) {
    return fieldMessage(input, "That's ProofPay's own wallet. Use the freelancer's address.");
  }
  return fieldMessage(input, "");
}

function validateBudget(force) {
  const input = $("budgetUsd");
  if (!input.value && !force) return fieldMessage(input, "");
  const v = priceUsd();
  const sym = localSymbol();
  const c = corridor($("corridorCode").value);
  const inLocal = (usdValue) => (c ? `${sym}${num(usdValue * c.rate, 0)}` : usd(usdValue));
  if (!Number.isFinite(v) || v < 1) {
    return fieldMessage(input, priceUnit === "usd" ? "The smallest payout is $1." : `The smallest payout is about ${inLocal(1)} ($1).`);
  }
  if (v > 5000) {
    return fieldMessage(input, priceUnit === "usd" ? "The largest payout is $5,000." : `The largest payout is about ${inLocal(5000)} ($5,000).`);
  }
  return fieldMessage(input, "");
}

async function submitPayout(e) {
  e.preventDefault();
  const form = $("payout-form");
  const error = $("form-error");
  error.hidden = true;

  const missing = [...form.querySelectorAll("[required]")].find((el) => !el.value.trim());
  if (missing) {
    error.textContent = `Fill in "${form.querySelector(`label[for="${missing.id}"]`)?.textContent || "this field"}".`;
    error.hidden = false;
    missing.focus();
    return;
  }

  if (!validateWallet(true) || !validateBudget(true)) return;

  const fd = new FormData(form);
  const btn = $("form-submit");
  btn.disabled = true;
  btn.textContent = "Creating…";

  const { ok, data } = await postJson("/api/tasks", {
    businessName: fd.get("businessName"),
    title: fd.get("title"),
    brief: fd.get("brief"),
    checklist: fd.get("checklist"),
    budgetUsd: Math.ceil(priceUsd() * 100) / 100,
    corridorCode: fd.get("corridorCode"),
    freelancerName: fd.get("freelancerName"),
    freelancerWallet: String(fd.get("freelancerWallet") || "").trim(),
  });

  btn.disabled = false;
  btn.textContent = "Create payout";

  if (!ok) {
    error.textContent = data.error || "Couldn't create the payout.";
    error.hidden = false;
    return;
  }

  const task = data.task;
  const link = freelancerLink(task);
  const est = estimateLocal(task.corridorCode, task.budgetUsd);
  const message = `Hi ${task.freelancerName}, here's the ProofPay link for "${task.title}" (${usd(task.budgetUsd)}, about ${est} ${task.corridorCode}). Hand in the work here and you'll be paid as soon as I approve: ${link}`;

  $("done-freelancer").textContent = task.freelancerName;
  $("done-link").textContent = link;
  $("done-open").href = link;
  $("done-wa").href = `https://wa.me/?text=${encodeURIComponent(message)}`;
  $("done-copy").onclick = () => copyText(link, $("done-copy"));
  setDialogMode(true);

  state.openId = task.id;
  state.filter = "all";
  syncTabs();
  await loadPayouts();
}

function syncTabs() {
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", String(t.dataset.filter === state.filter)));
}

/* ---------- Agent API try-out ---------- */
async function tryUnsigned() {
  const btn = $("try-unsigned");
  const out = $("try-output");
  btn.disabled = true;
  const sample = state.tasks.find((t) => t.status === "VETTED") || state.tasks[0];
  const { status, data } = await postJson("/api/agent/payout", { taskId: sample ? sample.id : "tsk_example" });
  btn.disabled = false;
  out.hidden = false;
  out.textContent = `HTTP ${status}\n${JSON.stringify(data, null, 2)}`;
}

/* ---------- Wire up ---------- */
$("new-payout-btn").addEventListener("click", openDialog);
$("use-example").addEventListener("click", fillExample);
$("form-cancel").addEventListener("click", () => dialog.close());
$("done-close").addEventListener("click", () => dialog.close());
$("payout-form").addEventListener("submit", submitPayout);
$("budgetUsd").addEventListener("input", () => {
  updateEstimate();
  validateBudget(false);
});
$("freelancerWallet").addEventListener("input", () => {
  if ($("freelancerWallet").getAttribute("aria-invalid")) validateWallet(false);
});
$("freelancerWallet").addEventListener("blur", () => validateWallet(false));
$("corridorCode").addEventListener("change", () => {
  updateEstimate();
  validateBudget(false);
});
document.querySelectorAll(".unit-switch button").forEach((b) => b.addEventListener("click", () => setPriceUnit(b.dataset.unit)));
$("try-unsigned").addEventListener("click", tryUnsigned);
$("conv-usd").addEventListener("input", () => {
  clearTimeout(convTimer);
  convTimer = setTimeout(updateConverter, 300);
});

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    state.filter = tab.dataset.filter;
    syncTabs();
    renderPayouts();
  })
);

// Deep links: /app#tsk_… opens that payout, /app#new opens the form.
if (/^#tsk_[a-z0-9]+$/i.test(location.hash)) {
  state.openId = location.hash.slice(1);
}

loadHealth();
loadCorridors().then(() => {
  if (location.hash !== "#new") return;
  openDialog();
  const params = new URLSearchParams(location.search);
  const usdParam = Number(params.get("usd"));
  if (params.get("cur") && corridor(params.get("cur"))) $("corridorCode").value = params.get("cur");
  if (Number.isFinite(usdParam) && usdParam > 0) {
    setPriceUnit("usd");
    $("budgetUsd").value = String(usdParam);
  }
  updateEstimate();
});
loadPayouts();

setInterval(() => {
  if (!dialog.open && !state.approving) loadPayouts();
}, 15000);
setInterval(loadCorridors, 60000);
