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
  if (status.key === "waiting") {
    actions = `
      <button class="btn small" type="button" data-copy="${esc(freelancerLink(task))}">Copy freelancer link</button>
      <a class="btn secondary small" href="/t/${esc(task.id)}" target="_blank" rel="noopener">Open their page</a>`;
  } else if (status.key === "approve" || status.key === "flagged") {
    const busy = state.approving === task.id;
    const label = busy ? "Converting on Textile FX…" : `${status.key === "flagged" ? "Approve anyway, pay" : "Approve and pay"} ${usd(task.budgetUsd)}`;
    actions = `
      <button class="btn paid small" type="button" data-approve="${esc(task.id)}" ${busy ? "disabled" : ""}>${label}</button>
      <a class="btn secondary small" href="/t/${esc(task.id)}" target="_blank" rel="noopener">Open their page</a>
      <span class="hint">${status.key === "flagged" ? "Some checks failed. Open the work before you pay." : `${esc(task.freelancerName)} gets about ${esc(est)} ${esc(task.corridorCode)}.`}</span>`;
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

async function approve(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task || state.approving) return;

  if (state.health?.executionMode === "mainnet") {
    const est = estimateLocal(task.corridorCode, task.budgetUsd);
    const ok = window.confirm(
      `Pay ${usd(task.budgetUsd)} USD₮ to ${task.freelancerName}?\n\nIt converts to about ${est} ${task.corridorCode} on Textile FX and goes to ${task.freelancerWallet} on Celo. This can't be undone.`
    );
    if (!ok) return;
  }

  state.approving = taskId;
  delete state.errors[taskId];
  renderPayouts();

  const send = () =>
    api(`/api/tasks/${encodeURIComponent(taskId)}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-operator-key": readOperatorKey() },
      body: "{}",
    });

  let { ok, status, data } = await send();
  if (status === 401 && data.error === "OPERATOR_KEY_REQUIRED" && /operator can/.test(data.message || "")) {
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
  $("budgetUsd").value = "5";
  $("corridorCode").value = "cNGN";
  $("form-error").hidden = true;
  setDialogMode(false);
  updateEstimate();
  dialog.showModal();
  $("businessName").focus();
}

function updateEstimate() {
  const amount = Number($("budgetUsd").value);
  const code = $("corridorCode").value;
  const est = Number.isFinite(amount) && amount >= 1 ? estimateLocal(code, amount) : "";
  $("form-estimate").querySelector("strong").textContent = est ? `${est} ${code}` : "–";
}

function fillExample() {
  $("businessName").value = "Lagos Brand Studio";
  $("title").value = "Logo refresh: 3 PNG exports";
  $("brief").value = "Clean up our logo and export it for the website and social media. Keep the wordmark, tighten the spacing, use our green.";
  $("checklist").value = "PNG at 512px and 1024px\nTransparent background\nUses brand green #0C7A4B";
  $("budgetUsd").value = "5";
  $("corridorCode").value = "cNGN";
  $("freelancerName").value = "Tunde Adebayo";
  $("freelancerWallet").value = "";
  updateEstimate();
  $("freelancerWallet").focus();
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

  const fd = new FormData(form);
  const btn = $("form-submit");
  btn.disabled = true;
  btn.textContent = "Creating…";

  const { ok, data } = await postJson("/api/tasks", {
    businessName: fd.get("businessName"),
    title: fd.get("title"),
    brief: fd.get("brief"),
    checklist: fd.get("checklist"),
    budgetUsd: Number(fd.get("budgetUsd")),
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
$("budgetUsd").addEventListener("input", updateEstimate);
$("corridorCode").addEventListener("change", updateEstimate);
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
  if (location.hash === "#new") openDialog();
});
loadPayouts();

setInterval(() => {
  if (!dialog.open && !state.approving) loadPayouts();
}, 15000);
setInterval(loadCorridors, 60000);
