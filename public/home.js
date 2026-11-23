// Landing page: the self-printing receipt, the live ticker and the rate board.
(() => {
  const { $, api, postJson, num, clock } = window.PP;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.querySelectorAll(".js-host").forEach((el) => {
    el.textContent = location.host;
  });

  // Example payout: $5. Replaced by a live Textile FX quote.
  const live = { total: 7263.84, rate: 1452.77 };

  function paintLiveNumbers() {
    document.querySelectorAll(".js-total").forEach((el) => {
      el.textContent = `₦${num(live.total)}`;
    });
    document.querySelectorAll(".js-rate").forEach((el) => {
      el.textContent = `₦${num(live.rate)}`;
    });
    document.querySelectorAll(".js-five").forEach((el) => {
      el.textContent = `₦${num(live.total, 0)}`;
    });
  }

  async function loadQuote() {
    const { ok, data } = await postJson("/api/quote", { corridorCode: "cNGN", sellAmountUsd: 5 });
    if (!ok) return;
    live.total = Number(String(data.buyAmountFormatted).replace(/,/g, ""));
    live.rate = Number(data.effectiveRate);
    paintLiveNumbers();
  }

  // ---------- ticker + rate board ----------
  let corridors = [];

  function renderTicker() {
    const items = corridors
      .map((c) => `<span><b>${c.code}</b> ${c.fiatSymbol}${num(c.rate, c.rate >= 100 ? 2 : 4)}</span>`)
      .join("");
    // Two copies so the scrolling loop is seamless; one when motion is off.
    $("ticker-run").innerHTML = reduceMotion ? items : items + items;
  }

  function renderBoard() {
    const amount = Number($("rc-amount").value);
    $("rc-out").innerHTML = corridors
      .map((c) => {
        const value = Number.isFinite(amount) && amount > 0 ? amount * c.rate : null;
        const shown = value == null ? "–" : `${c.fiatSymbol}${num(value, value >= 1000 ? 0 : 2)}`;
        return `<li><span class="code">${c.code}</span><span class="country">${c.country}</span><span class="val">${shown}</span></li>`;
      })
      .join("");

    const note = $("rc-note");
    if (corridors.some((c) => c.source === "fallback")) {
      note.textContent = "Textile FX can't be reached right now, so these are indicative rates, not live ones.";
    } else if (corridors.some((c) => c.source === "stale")) {
      note.textContent = "Last known Textile FX rates. The latest refresh failed.";
    } else {
      const at = corridors.find((c) => c.fetchedAt)?.fetchedAt;
      note.innerHTML = `<span class="live-dot"></span>Textile FX, ${clock(at).slice(0, 5)}`;
    }
  }

  async function loadRates() {
    const { ok, data } = await api("/api/corridors");
    if (!ok) {
      $("rc-note").textContent = "Couldn't load rates. Try again in a moment.";
      return;
    }
    corridors = data.corridors || [];
    renderTicker();
    renderBoard();
  }

  $("rc-amount").addEventListener("input", renderBoard);

  // ---------- the receipt that prints itself ----------
  const slip = $("slip");
  const checks = [...$("slip-checks").querySelectorAll("li")];
  const status = $("slip-status");
  const approve = $("slip-approve");
  const btn = $("slip-btn");
  const total = $("slip-total");
  const foot = $("slip-foot");
  let runId = 0;

  function countUp(el, to, ms, id) {
    const start = performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        if (id !== runId) return resolve();
        const t = Math.min(1, (now - start) / ms);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = `₦${num(to * eased)}`;
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  async function play() {
    const id = ++runId;
    const alive = () => id === runId;

    slip.classList.remove("printed", "done");
    slip.classList.add("printing");
    checks.forEach((li) => li.classList.remove("ok"));
    status.textContent = "Waiting for the work";
    approve.hidden = true;
    btn.className = "slip-btn";
    btn.textContent = "Approve and pay $5.00";
    total.classList.remove("show", "done");
    foot.classList.remove("show");
    foot.textContent = "";
    void slip.offsetWidth;
    slip.classList.add("printed");

    await sleep(1300);
    if (!alive()) return;

    status.textContent = "Checking the delivery…";
    for (const li of checks) {
      await sleep(560);
      if (!alive()) return;
      li.classList.add("ok");
    }
    await sleep(350);
    status.textContent = "Delivery checked";

    approve.hidden = false;
    await sleep(1100);
    if (!alive()) return;
    btn.classList.add("pressed");
    await sleep(200);
    btn.classList.remove("pressed");
    btn.textContent = "Converting on Textile FX…";
    btn.classList.add("busy");
    await sleep(1000);
    if (!alive()) return;

    approve.hidden = true;
    total.classList.add("show");
    await countUp(total.querySelector(".js-total"), live.total, 900, id);
    if (!alive()) return;
    total.classList.add("done");
    foot.textContent = "tx 0x8f3a…21c4 · Celo · 2 s after approval";
    foot.classList.add("show");
    slip.classList.add("done");

    await sleep(5200);
    if (alive()) play();
  }

  $("replay").addEventListener("click", () => {
    if (reduceMotion) return;
    document.querySelector(".slip-stage").scrollIntoView({ behavior: "smooth", block: "center" });
    play();
  });

  paintLiveNumbers();
  loadQuote();
  loadRates();
  setInterval(loadRates, 60000);
  if (!reduceMotion) setTimeout(play, 2600);
})();
