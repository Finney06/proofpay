// Landing page: live numbers, the payout log replay, the rate calculator, nav state.
(() => {
  const { $, api, postJson, num, clock } = window.PP;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

  document.querySelectorAll(".js-host").forEach((el) => (el.textContent = location.host));

  // Example payout of $5, replaced by a live Textile FX quote.
  const live = { total: 7275.32, rate: 1455.06 };

  function paint() {
    document.querySelectorAll(".js-total").forEach((el) => (el.textContent = `₦${num(live.total)}`));
    document.querySelectorAll(".js-rate").forEach((el) => (el.textContent = `₦${num(live.rate)}`));
    document.querySelectorAll(".js-five").forEach((el) => (el.textContent = `₦${num(live.total, 0)}`));
    document.querySelectorAll(".js-rate-line").forEach((el) => (el.textContent = `₦${num(live.rate)} / $1`));
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

  // ---------- hero: client approves, ProofPay checks, freelancer is paid ----------
  const flow = $("flow");
  const btn = $("flow-btn");
  const total = $("flow-total");
  const wallet = $("flow-wallet");
  const checks = [...$("flow-check").querySelectorAll("li")];

  function countUp(ms) {
    const t0 = performance.now();
    return new Promise((resolve) => {
      const step = (now) => {
        const t = Math.min(1, (now - t0) / ms);
        total.textContent = `₦${num(live.total * (1 - Math.pow(1 - t, 3)))}`;
        if (t < 1) requestAnimationFrame(step);
        else resolve();
      };
      requestAnimationFrame(step);
    });
  }

  function showPaid() {
    checks.forEach((li) => li.classList.add("ok"));
    btn.textContent = "Approved";
    btn.classList.add("done");
    wallet.classList.remove("waiting");
  }

  async function replay() {
    for (;;) {
      checks.forEach((li) => li.classList.remove("ok"));
      btn.className = "party-btn";
      btn.textContent = "Approve and pay";
      wallet.classList.add("waiting");
      total.textContent = "₦0.00";
      flow.classList.remove("moving");
      await sleep(900);
      for (const li of checks) {
        li.classList.add("ok");
        await sleep(520);
      }
      await sleep(500);
      btn.classList.add("pressed");
      await sleep(180);
      btn.classList.remove("pressed");
      btn.textContent = "Converting on Textile FX…";
      flow.classList.add("moving");
      await sleep(1100);
      btn.textContent = "Approved";
      btn.classList.add("done");
      wallet.classList.remove("waiting");
      await countUp(900);
      flow.classList.remove("moving");
      await sleep(4400);
    }
  }

  // ---------- nav ----------
  const nav = document.querySelector(".site-nav");
  const onScroll = () => nav.classList.toggle("scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  document.querySelectorAll(".menu-panel a").forEach((a) =>
    a.addEventListener("click", () => a.closest("details").removeAttribute("open"))
  );

  paint();
  loadQuote();
  loadRates();
  setInterval(loadRates, 60000);
  if (reduceMotion) showPaid();
  else replay();
})();
