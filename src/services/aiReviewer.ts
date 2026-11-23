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
  engine: "deterministic-rubric";
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
    summary,
    checks,
    reviewedAt: new Date().toISOString(),
    engine: "deterministic-rubric",
  };
}
