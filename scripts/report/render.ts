// Turns the day's facts into words: a plain report that always works, the prompt the agent
// writes from, and the Teams card. No network calls, so all of it is unit-tested.
import type { Facts } from "./model.js";
import { driftLabel } from "./model.js";

const money = (amount: number, currency: string) => `${amount.toFixed(2)} ${currency}`;

/** Items a person should act on today. Shared by the plain report and the agent's prompt. */
export function decisions(facts: Facts): string[] {
  const out: string[] = [];
  for (const d of facts.drift) {
    const detail = d.details.length > 0 ? `: ${d.details.slice(0, 3).join("; ")}` : "";
    out.push(`${d.tool}: ${d.resource} ${driftLabel(d.change)}${detail}`);
  }
  if (facts.outsideCode.length > 0) {
    const names = facts.outsideCode
      .slice(0, 5)
      .map((r) => `${r.name} (${r.type}, ${r.resourceGroup})`)
      .join(", ");
    const more = facts.outsideCode.length > 5 ? ` and ${facts.outsideCode.length - 5} more` : "";
    out.push(`Made outside the code: ${names}${more}`);
  }
  if (facts.cost) {
    for (const row of facts.cost.rows) {
      if (row.budget !== undefined && row.amount > row.budget) {
        out.push(
          `${row.tool} spent ${money(row.amount, facts.cost.currency)} yesterday, over its ${money(row.budget, facts.cost.currency)} daily budget`,
        );
      }
    }
  }
  for (const a of facts.adoption) {
    if (a.serious > 0) {
      out.push(
        `${a.tool}: ${a.serious} serious ${a.serious === 1 ? "issue" : "issues"} (secrets in the browser or exposed data) must be fixed before it can deploy`,
      );
    }
  }
  for (const a of facts.alerts) {
    if (a.state !== "Closed" && (a.severity === "Sev0" || a.severity === "Sev1")) {
      out.push(`${a.tool}: ${a.severity} alert still open (${a.name})`);
    }
  }
  return out;
}

/** The report without the agent: complete, correct and dull. It goes out whenever the agent can't. */
export function renderPlain(facts: Facts): string {
  const lines: string[] = [`**${facts.title} · ${facts.date}**`, ""];

  const todo = decisions(facts);
  lines.push("**Needs a decision**");
  lines.push(
    ...(todo.length > 0 ? todo.map((t) => `- ${t}`) : ["- Nothing needs a decision today."]),
  );
  lines.push("");

  lines.push("**By tool**");
  for (const tool of facts.tools) {
    const parts: string[] = [];
    const cost = facts.cost?.rows.find((r) => r.tool === tool.name);
    if (cost && facts.cost) {
      parts.push(
        cost.budget !== undefined
          ? `${money(cost.amount, facts.cost.currency)} of ${money(cost.budget, facts.cost.currency)} yesterday`
          : `${money(cost.amount, facts.cost.currency)} yesterday`,
      );
    }
    const drift = facts.drift.filter((d) => d.tool === tool.name).length;
    parts.push(drift === 0 ? "no drift" : `${drift} drift ${drift === 1 ? "item" : "items"}`);
    const alerts = facts.alerts.filter((a) => a.tool === tool.name).length;
    parts.push(alerts === 0 ? "no alerts" : `${alerts} ${alerts === 1 ? "alert" : "alerts"}`);
    const adoption = facts.adoption.find((a) => a.tool === tool.name);
    if (adoption && adoption.known + adoption.serious > 0) {
      const left = adoption.known + adoption.serious;
      parts.push(`${left} known ${left === 1 ? "issue" : "issues"} to work down`);
    }
    const kind = tool.kind === "migrated" ? ", migrated" : "";
    lines.push(`- ${tool.name} (${tool.owner}${kind}): ${parts.join(" · ")}`);
  }
  // Spend no tool owns: resources without a tool tag, or tagged for a tool not in the config.
  const unowned = (facts.cost?.rows ?? []).filter(
    (r) => !facts.tools.some((t) => t.name === r.tool),
  );
  if (facts.cost && unowned.length > 0) {
    const currency = facts.cost.currency;
    const total = unowned.reduce((sum, r) => sum + r.amount, 0);
    const named = unowned.map((r) => `${r.tool} ${money(r.amount, currency)}`).join(", ");
    lines.push(`- Not linked to a tool: ${money(total, currency)} yesterday (${named})`);
  }
  lines.push("");

  if (facts.shipped.length > 0) {
    lines.push("**Shipped in the last 24 hours**");
    for (const s of facts.shipped) {
      lines.push(
        `- ${s.title} (${s.repo})${s.exception ? ", with an approved guardrail exception" : ""}`,
      );
    }
    lines.push("");
  }

  if (facts.changes.length > 0) {
    lines.push("**Changes made in Azure**");
    for (const c of facts.changes.slice(0, 10)) {
      lines.push(`- ${c.resource}: ${c.changeType} by ${c.changedBy} via ${c.clientType}`);
    }
    lines.push("");
  }

  if (facts.problems.length > 0) {
    lines.push("**Couldn't check**");
    lines.push(...facts.problems.map((p) => `- ${p}`));
    lines.push("");
  }

  return lines.join("\n").trim();
}

export interface Prompt {
  system: string;
  user: string;
}

/** The agent explains the facts; it never decides what is true. */
export function buildPrompt(facts: Facts): Prompt {
  const system = [
    "You write the afternoon platform report for executives and tool owners who are not engineers.",
    "Use only the facts in the JSON you are given. Never add, guess or round up anything that isn't there.",
    "Start with one sentence saying whether anything needs a decision today.",
    "Then list each item that needs a decision, what it means in plain words, and who should act (the tool's owner).",
    "Then give one short line per tool. Then say what shipped.",
    "Say 'changed outside the code' rather than 'drift'. Name every check that couldn't run, in one line.",
    "Write in plain Australian English, under 200 words.",
    "Format for a Microsoft Teams card: bold with **, bullet lines starting with '- ', no headings, no tables.",
  ].join("\n");
  const user = [
    `Today's facts for ${facts.title}, ${facts.date}.`,
    `Items that need a decision, already worked out: ${JSON.stringify(decisions(facts))}`,
    "",
    "```json",
    JSON.stringify(facts, null, 2),
    "```",
  ].join("\n");
  return { system, user };
}

/** A Teams "Workflows" webhook message: one Adaptive Card, one text block per line. */
export function teamsPayload(title: string, text: string) {
  const body: Record<string, unknown>[] = [
    { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true },
  ];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed === `**${title}**`) continue;
    const bullet = trimmed.startsWith("- ");
    body.push({
      type: "TextBlock",
      text: bullet ? `• ${trimmed.slice(2)}` : trimmed,
      wrap: true,
      spacing: bullet ? "Small" : "Medium",
    });
  }
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body,
        },
      },
    ],
  };
}

/** The GitHub Actions run summary: what was sent, plus the plain facts underneath. */
export function stepSummary(sent: string, plain: string, writer: string): string {
  return [
    sent,
    "",
    `_Written by: ${writer}_`,
    "",
    "<details><summary>All facts (plain report)</summary>",
    "",
    plain,
    "",
    "</details>",
    "",
  ].join("\n");
}
