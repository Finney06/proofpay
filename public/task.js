const { $, esc, api, postJson, usd, fiatSymbol, shortAddr, payoutStatus, badge, reviewEngineLabel, ICON } = window.PP;

const taskId = decodeURIComponent(location.pathname.split("/").filter(Boolean).pop() || "");

async function load() {
  const { ok, data } = await api(`/api/tasks/${encodeURIComponent(taskId)}`);
  $("loading").hidden = true;
  if (!ok || !data.task) {
    $("not-found").hidden = false;
    return;
  }
  const task = data.task;
  let receipt = null;
  if (task.receiptId) {
    const r = await api(`/api/receipts/${encodeURIComponent(task.receiptId)}`);
    if (r.ok) receipt = r.data.receipt;
  }
  render(task, receipt);
}

function render(task, receipt) {
  $("ticket").hidden = false;
  document.title = `ProofPay · ${task.title}`;
  $("t-from").textContent = task.businessName;
  $("t-title").textContent = task.title;
  $("t-budget").textContent = `${usd(task.budgetUsd)} USD₮`;
  $("t-wallet").textContent = shortAddr(task.freelancerWallet);
  $("t-brief").textContent = task.brief;
  $("t-status").innerHTML = badge(payoutStatus(task, receipt));

  $("t-checks").innerHTML = task.aiReview
    ? task.aiReview.checks
        .map((c) => `<li class="${c.passed ? "pass" : "fail"}"><span class="mark">${c.passed ? ICON.check : ICON.cross}</span><span>${esc(c.item)}<small>${esc(c.note)}</small></span></li>`)
        .join("")
    : (task.checklist.length ? task.checklist : ["Matches the brief"])
        .map((item) => `<li><span class="mark">${ICON.dot}</span><span>${esc(item)}</span></li>`)
        .join("");

  const sym = fiatSymbol(task.corridorCode);
  const top = $("t-top");
  top.classList.remove("is-paid", "is-preview");

  if (receipt) {
    const live = receipt.payout.mode === "mainnet";
    top.classList.add(live ? "is-paid" : "is-preview");
    $("t-amount").innerHTML = `${sym}${esc(receipt.payout.buyAmountFormatted)}<small>${esc(receipt.payout.buyToken)}</small>`;
    $("t-amount-label").textContent = live ? "In your wallet" : "Approved in preview mode. Nothing was sent.";
  } else {
    $("t-amount-label").textContent = `You'll receive about this in ${task.corridorCode} when ${task.businessName} approves`;
    $("t-amount").innerHTML = `${usd(task.budgetUsd)}<small>USD₮</small>`;
    postJson("/api/quote", { corridorCode: task.corridorCode, sellAmountUsd: task.budgetUsd }).then((quote) => {
      $("t-amount").innerHTML = quote.ok
        ? `${sym}${esc(quote.data.buyAmountFormatted)}<small>${esc(task.corridorCode)}</small>`
        : `${usd(task.budgetUsd)}<small>USD₮</small>`;
    });
  }

  const submitPanel = $("submit-panel");
  const statePanel = $("state-panel");

  if (task.status === "OPEN") {
    submitPanel.hidden = false;
    statePanel.hidden = true;
    return;
  }

  submitPanel.hidden = true;
  statePanel.hidden = false;

  if (task.status === "VETTED") {
    const passed = task.aiReview.verdict === "PASS";
    statePanel.innerHTML = `
      <div class="state"><span class="mark">${ICON.dot}</span><div>
        <strong>Handed in. Waiting for ${esc(task.businessName)} to approve.</strong>
        <p>${passed ? "Every check passed." : "Some checks need a closer look, so the client will open your work first."} You're paid the moment they approve.</p>
      </div></div>`;
    return;
  }

  if (task.status === "PAID" && receipt) {
    const live = receipt.payout.mode === "mainnet";
    statePanel.innerHTML = `
      <div class="state${live ? " ok" : ""}"><span class="mark">${live ? ICON.check : ICON.dot}</span><div>
        <strong>${live ? `Paid. ${sym}${esc(receipt.payout.buyAmountFormatted)} ${esc(receipt.payout.buyToken)} is in your wallet.` : "Approved in preview mode. No money was sent."}</strong>
        <p><a href="/receipt/${esc(receipt.id)}">View the receipt</a></p>
        ${live ? tokenTip(receipt.payout.buyToken) : ""}
      </div></div>`;
    if (live) loadTokenAddress(receipt.payout.buyToken);
  }
}

/* Most wallets don't list local stablecoins by default, so show how to add it once. */
function tokenTip(code) {
  return `<details class="token-tip"><summary>Can't see your ${esc(code)}?</summary>
    <p>Wallets only show tokens you've added. In MetaMask: switch to the <strong>Celo</strong> network, tap <strong>Import tokens</strong>, and paste this address:</p>
    <p class="mono" id="token-address">Loading…</p></details>`;
}

async function loadTokenAddress(code) {
  const { ok, data } = await api("/api/corridors");
  const el = $("token-address");
  if (!el) return;
  const c = ok && data.corridors.find((x) => x.code === code);
  el.textContent = c ? c.tokenAddress : "See the receipt for the token.";
}

$("submit-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const error = $("submit-error");
  error.hidden = true;
  const url = $("deliverableUrl").value.trim();
  const notes = $("deliverableNotes").value.trim();

  if (!/^https?:\/\/\S+$/i.test(url)) {
    error.textContent = "Add a link that starts with https://";
    error.hidden = false;
    return;
  }
  if (notes.length < 10) {
    error.textContent = "Say what you delivered in a sentence or two.";
    error.hidden = false;
    return;
  }

  const btn = $("submit-btn");
  btn.disabled = true;
  btn.textContent = "Checking your work…";
  const { ok, data } = await postJson(`/api/tasks/${encodeURIComponent(taskId)}/submit`, {
    deliverableUrl: url,
    deliverableNotes: notes,
  });
  btn.disabled = false;
  btn.textContent = "Hand in work";

  if (!ok) {
    error.textContent = data.error || "Couldn't hand it in. Try again.";
    error.hidden = false;
    return;
  }
  await load();
});

load();
