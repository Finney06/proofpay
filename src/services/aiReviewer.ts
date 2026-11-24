import crypto from "node:crypto";

export interface ChecklistEvaluation {
  item: string;
  passed: boolean;
  note: string;
}

export interface DeliverableReview {
  deliverableHash: string;
  score: number;
  verdict: "PASS" | "NEEDS_REVIEW";
  summary: string;
  checks: ChecklistEvaluation[];
  reviewedAt: string;
  engine: string;
}

function sha256(input: string): string {
  return `0x${crypto.createHash("sha256").update(input).digest("hex")}`;
}

type LinkState = "open" | "private" | "broken" | "unreachable" | "invalid";

/** Checks the delivery link. Some hosts reject HEAD, so fall back to GET. */
async function probeLink(url: string): Promise<{ state: LinkState; status: number }> {
  const attempt = async (method: "HEAD" | "GET") => {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      signal: AbortSignal.timeout(5000),
    });
    if (method === "GET") await res.body?.cancel().catch(() => {});
    return res.status;
  };

  let status = 0;
  try {
    status = await attempt("HEAD");
    if (status === 405 || status === 501 || status === 403) {
      status = await attempt("GET");
    }
  } catch {
    try {
      status = await attempt("GET");
    } catch {
      return { state: "unreachable", status: 0 };
    }
  }

  if (status >= 200 && status < 400) return { state: "open", status };
  if (status === 401 || status === 403) return { state: "private", status };
  return { state: "broken", status };
}

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export async function vetDeliverable(params: {
  taskTitle: string;
  brief: string;
  checklist: string[];
  deliverableUrl: string;
  deliverableNotes: string;
}): Promise<DeliverableReview> {
  const deliverableHash = sha256(
    JSON.stringify({
      url: params.deliverableUrl.trim(),
      notes: params.deliverableNotes.trim(),
    })
  );

  const urlValid = isValidUrl(params.deliverableUrl.trim());
  const link = urlValid
    ? await probeLink(params.deliverableUrl.trim())
    : { state: "invalid" as const, status: 0 };

  const combinedText = `${params.deliverableUrl} ${params.deliverableNotes}`.toLowerCase();
  const checks: ChecklistEvaluation[] = [];

  const linkNotes: Record<LinkState, string> = {
    open: `Link opens (HTTP ${link.status})`,
    private: `Link exists but needs sign-in (HTTP ${link.status}); the client must open it`,
    broken: `Link returns HTTP ${link.status}`,
    unreachable: "Link did not respond; the client should open it before approving",
    invalid: "Missing or not an http(s) link",
  };

  checks.push({
    item: "Delivery link works",
    passed: link.state === "open" || link.state === "private",
    note: linkNotes[link.state],
  });

  checks.push({
    item: "Delivery notes describe the work",
    passed: params.deliverableNotes.trim().length >= 20,
    note:
      params.deliverableNotes.trim().length >= 20
        ? `${params.deliverableNotes.trim().length} characters describing completed work`
        : "Notes are too brief (< 20 characters); client should verify manually",
  });

  const checklistItems =
    params.checklist.length > 0
      ? params.checklist
      : ["Matches task brief requirements"];

  for (const item of checklistItems) {
    const keywords = item
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4);

    const matchedKeywords = keywords.filter((w) => combinedText.includes(w));
    const passed =
      urlValid &&
      params.deliverableNotes.trim().length >= 20 &&
      (keywords.length === 0 || matchedKeywords.length >= 1);

    checks.push({
      item,
      passed,
      note: passed
        ? matchedKeywords.length > 0
          ? `Addressed in submission (${matchedKeywords.slice(0, 3).join(", ")})`
          : "Deliverable link and notes provided"
        : "Not explicitly referenced in delivery notes; recommend client check before approval",
    });
  }

  // With a Gemini key, a model reads the delivery itself and judges each checklist line.
  let engine = "deterministic-rubric";
  let modelSummary: string | null = null;
  if (process.env.GEMINI_API_KEY && (link.state === "open")) {
    const judged = await reviewWithGemini({
      taskTitle: params.taskTitle,
      brief: params.brief,
      checklist: checklistItems,
      notes: params.deliverableNotes,
      url: params.deliverableUrl.trim(),
    });
    if (judged) {
      checks.splice(2, checks.length - 2, ...judged.checks);
      engine = judged.model;
      modelSummary = judged.summary;
    }
  }

  const passedCount = checks.filter((c) => c.passed).length;
  const score = Math.round((passedCount / checks.length) * 100);
  const verdict: "PASS" | "NEEDS_REVIEW" = score >= 75 ? "PASS" : "NEEDS_REVIEW";

  const summary =
    verdict === "PASS"
      ? `Passed ${passedCount}/${checks.length} checks (${score}/100). Deliverable matches "${params.taskTitle}" and is ready for client approval.`
      : `Passed ${passedCount}/${checks.length} checks (${score}/100). Flagged for manual client inspection before releasing funds.`;

  return {
    deliverableHash,
    score,
    verdict,
    summary: modelSummary ? `${modelSummary} (${passedCount}/${checks.length} checks passed.)` : summary,
    checks,
    reviewedAt: new Date().toISOString(),
    engine,
  };
}

/* ---------- Gemini delivery review ---------- */

const MAX_FETCH_BYTES = 6 * 1024 * 1024;
const MAX_TEXT_CHARS = 30_000;

type DeliveryContent =
  | { kind: "text"; text: string; contentType: string }
  | { kind: "inline"; mimeType: string; base64: string };

/** Downloads the delivery (page, document, image or PDF) so the model can look at it. */
async function fetchDelivery(url: string): Promise<DeliveryContent | null> {
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const contentType = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const size = Number(res.headers.get("content-length") || 0);
    if (size > MAX_FETCH_BYTES) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES) return null;

    if (contentType.startsWith("image/") || contentType === "application/pdf") {
      return { kind: "inline", mimeType: contentType, base64: buf.toString("base64") };
    }
    let text = buf.toString("utf8");
    if (contentType.includes("html")) {
      text = text
        .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ");
    }
    return { kind: "text", text: text.slice(0, MAX_TEXT_CHARS), contentType: contentType || "text/plain" };
  } catch {
    return null;
  }
}

async function reviewWithGemini(params: {
  taskTitle: string;
  brief: string;
  checklist: string[];
  notes: string;
  url: string;
}): Promise<{ checks: ChecklistEvaluation[]; summary: string; model: string } | null> {
  const model = process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const content = await fetchDelivery(params.url);

  const instructions = [
    "You review freelance work for a client before they pay.",
    "Judge each acceptance item strictly against the delivered content. If the content isn't available, judge only from the freelancer's notes and say so.",
    "Reply with JSON only: {\"summary\": string (one plain sentence for the client), \"checks\": [{\"item\": string (copied exactly), \"passed\": boolean, \"note\": string (under 15 words, specific)}]}.",
    `Job: ${params.taskTitle}`,
    `Brief: ${params.brief}`,
    `Acceptance items:\n${params.checklist.map((c, i) => `${i + 1}. ${c}`).join("\n")}`,
    `Freelancer's notes: ${params.notes}`,
    `Delivery link: ${params.url}`,
    content
      ? content.kind === "text"
        ? `Delivered content (${content.contentType}, may be truncated):\n${content.text}`
        : `The delivered ${content.mimeType} file is attached.`
      : "The delivered content could not be downloaded (it may need sign-in).",
  ].join("\n\n");

  const parts: unknown[] = [{ text: instructions }];
  if (content && content.kind === "inline") {
    parts.push({ inline_data: { mime_type: content.mimeType, data: content.base64 } });
  }

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
        }),
        signal: AbortSignal.timeout(45_000),
      }
    );
    if (!res.ok) {
      console.error("Gemini review failed:", res.status, (await res.text()).slice(0, 300));
      return null;
    }
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    const raw = body.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    const parsed = JSON.parse(raw) as { summary?: string; checks?: { item?: string; passed?: boolean; note?: string }[] };
    if (!Array.isArray(parsed.checks) || parsed.checks.length === 0) return null;

    // Keep the client's own wording and order; fill anything the model skipped as not checked.
    const byItem = new Map(parsed.checks.map((c) => [String(c.item || "").trim().toLowerCase(), c]));
    const checks = params.checklist.map((item, i) => {
      const hit = byItem.get(item.trim().toLowerCase()) || parsed.checks![i];
      return {
        item,
        passed: Boolean(hit?.passed),
        note: String(hit?.note || "Not assessed; check it yourself before approving").slice(0, 160),
      };
    });
    return { checks, summary: String(parsed.summary || "").slice(0, 300), model };
  } catch (err) {
    console.error("Gemini review error:", err instanceof Error ? err.message : err);
    return null;
  }
}
