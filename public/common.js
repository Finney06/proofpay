/* Shared helpers for the ProofPay pages. */
window.PP = (() => {
  const FIAT = {
    cNGN: "₦",
    wBRL: "R$",
    IDRX: "Rp",
    wARS: "ARS ",
    wMXN: "MX$",
    wCOP: "COP ",
  };

  const CELOSCAN = "https://celoscan.io";

  const $ = (id) => document.getElementById(id);

  function esc(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function shortAddr(addr) {
    if (!addr || addr.length < 12) return addr || "";
    return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
  }

  function shortHash(hash) {
    if (!hash || hash.length < 16) return hash || "";
    return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
  }

  async function api(url, opts) {
    try {
      const res = await fetch(url, opts);
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: { error: "Network error. Is the server running?" } };
    }
  }

  function postJson(url, body) {
    return api(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    });
  }

  function num(value, digits = 2) {
    return Number(value || 0).toLocaleString("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function usd(value) {
    return `$${num(value)}`;
  }

  function fiatSymbol(code) {
    return FIAT[code] || "";
  }

  function rateDigits(rate) {
    return rate >= 100 ? 2 : 4;
  }

  function timeAgo(iso) {
    if (!iso) return "";
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 45) return "just now";
    const m = Math.round(s / 60);
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    if (d < 7) return `${d} d ago`;
    return dateShort(iso);
  }

  function dateShort(iso) {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  }

  function dateTime(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleString("en-GB", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function clock(iso) {
    if (!iso) return "";
    return new Date(iso).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }

  function txUrl(hash) {
    return `${CELOSCAN}/tx/${encodeURIComponent(hash)}`;
  }

  function addressUrl(addr) {
    return `${CELOSCAN}/address/${encodeURIComponent(addr)}`;
  }

  const ICON = {
    check:
      '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    cross:
      '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
    dot:
      '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.5" fill="currentColor"/></svg>',
    external:
      '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.5 3.5L7 9" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    copy:
      '<svg class="i" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="7" height="7" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M10.5 3.5h-6a1 1 0 0 0-1 1v6" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    chevron:
      '<svg class="i chev" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  function txLink(hash, label) {
    if (!hash) return "";
    return `<a class="hash" href="${txUrl(hash)}" target="_blank" rel="noopener">${esc(label || shortHash(hash))}${ICON.external}</a>`;
  }

  function addressLink(addr, full = false) {
    if (!addr) return "";
    return `<a class="hash" href="${addressUrl(addr)}" target="_blank" rel="noopener">${esc(full ? addr : shortAddr(addr))}${ICON.external}</a>`;
  }

  /** Display status for a payout task and its receipt (if any). */
  function payoutStatus(task, receipt) {
    if (task.status === "PAID") {
      return receipt && receipt.payout && receipt.payout.mode === "mainnet"
        ? { key: "paid", label: "Paid" }
        : { key: "preview", label: "Approved, preview" };
    }
    if (task.status === "REFUNDED") return { key: "preview", label: "Refunded" };
    if (task.status === "VETTED") {
      return task.aiReview && task.aiReview.verdict === "PASS"
        ? { key: "approve", label: "Ready to approve" }
        : { key: "flagged", label: "Check delivery" };
    }
    return { key: "waiting", label: "Waiting for work" };
  }

  function badge(status) {
    return `<span class="pill ${status.key}">${esc(status.label)}</span>`;
  }

  function reviewEngineLabel(engine) {
    if (engine === "deterministic-rubric") return "Rule-based checklist review";
    if (engine) return `Model review (${engine})`;
    return "Checklist review";
  }

  async function copyText(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      if (button) {
        const original = button.dataset.label || button.textContent;
        button.dataset.label = original;
        button.textContent = "Copied";
        setTimeout(() => {
          button.textContent = original;
        }, 1600);
      }
    } catch {
      window.prompt("Copy this link:", text);
    }
  }

  return {
    $,
    esc,
    shortAddr,
    shortHash,
    api,
    postJson,
    num,
    usd,
    fiatSymbol,
    rateDigits,
    timeAgo,
    dateTime,
    clock,
    txUrl,
    addressUrl,
    txLink,
    addressLink,
    payoutStatus,
    badge,
    reviewEngineLabel,
    copyText,
    ICON,
  };
})();
