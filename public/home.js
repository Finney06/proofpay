// Landing page: live numbers, the rate calculator and the hero payout loop.
(() => {
  const { $, api, postJson, num, clock } = window.PP;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.querySelectorAll(".js-host").forEach((el) => {
    el.textContent = location.host;
  });

  // Example payout of $5, replaced by a live Textile FX quote.
  const live = { total: 7263.84, rate: 1452.77 };

  function paint() {
    document.querySelectorAll(".js-total").forEach((el) => (el.textContent = `₦${num(live.total)}`));
    document.querySelectorAll(".js-rate").forEach((el) => (el.textContent = `₦${num(live.rate)}`));
    document.querySelectorAll(".js-five").forEach((el) => (el.textContent = `₦${num(live.total, 0)}`));
  }

  async function loadQuote() {
    const { ok, data } = await postJson("/api/quote", { corridorCode: "cNGN", sellAmountUsd: 5 });
    if (!ok || data.source === "fallback") return;
    live.total = Number(String(data.buyAmountFormatted).replace(/,/g, ""));
    live.rate = Number(data.effectiveRate);
    paint();
  }

  // ---------- rate calculator ----------
  let corridors = [];

  function renderCalc() {
    const amount = Number($("rc-amount").value);
    $("rc-out").innerHTML = corridors
      .map((c) => {
        const v = Number.isFinite(amount) && amount > 0 ? amount * c.rate : null;
        const shown = v == null ? "–" : `${c.fiatSymbol}${num(v, v >= 1000 ? 0 : 2)}`;
        return `<li><span class="calc-cur"><b>${c.code}</b>${c.country}</span><span class="calc-val">${shown}</span></li>`;
      })
      .join("");
    const note = $("rc-note");
    if (corridors.some((c) => c.source === "fallback")) {
      note.textContent = "Textile FX can't be reached right now, so these are indicative rates.";
    } else if (corridors.some((c) => c.source === "stale")) {
      note.textContent = "Last known Textile FX rates.";
    } else {
      const at = corridors.find((c) => c.fetchedAt)?.fetchedAt;
      note.innerHTML = `<span class="live-dot"></span>Live from Textile FX · updated ${clock(at).slice(0, 5)}`;
    }
  }

  async function loadRates() {
    const { ok, data } = await api("/api/corridors");
    if (!ok) {
      $("rc-note").textContent = "Couldn't load rates. Try again in a moment.";
      return;
    }
    corridors = data.corridors || [];
    renderCalc();
  }

  $("rc-amount").addEventListener("input", renderCalc);

  // ---------- hero: one payout, approved on a loop ----------
  const status = $("shot-status");
  const btn = $("shot-btn");
  const toast = $("shot-toast");

  function setState(state) {
    if (state === "ready") {
      status.className = "status status-approve";
      status.textContent = "Ready to approve";
      btn.className = "pay-btn";
      btn.textContent = "Approve and pay $5.00";
      toast.classList.remove("show");
    } else if (state === "busy") {
      btn.className = "pay-btn busy";
      btn.textContent = "Converting on Textile FX…";
    } else {
      status.className = "status status-paid";
      status.textContent = "Paid";
      btn.className = "pay-btn done";
      btn.textContent = "View receipt";
      toast.classList.add("show");
    }
  }

  async function loop() {
    for (;;) {
      setState("ready");
      await sleep(2600);
      btn.classList.add("pressed");
      await sleep(180);
      setState("busy");
      await sleep(1300);
      setState("paid");
      await sleep(4600);
    }
  }

  const nav = document.querySelector(".site-nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  document.querySelectorAll(".menu-panel a").forEach((a) => a.addEventListener("click", () => a.closest("details").removeAttribute("open")));

  paint();
  loadQuote();
  loadRates();
  setInterval(loadRates, 60000);
  if (reduceMotion) setState("paid");
  else loop();
})();
