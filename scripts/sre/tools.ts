// The SRE agent's custom tools. The agent decides when to call them; this process runs them
// with its own credentials and returns the result, so the agent's workspace never holds a key.
// Read tools come in two versions: the demo incident (sre/demo/incident.json plus real git
// history) and Azure (Resource Graph, Azure Monitor, Log Analytics, GitHub).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { az, git, type SreTool } from "./config.js";

const noInput = { type: "object" as const, properties: {}, required: [] as string[] };

export const CUSTOM_TOOLS = [
  {
    type: "custom" as const,
    name: "get_alert",
    description: "The alert that started this incident: tool, condition, value and when it fired.",
    input_schema: noInput,
  },
  {
    type: "custom" as const,
    name: "get_metrics",
    description:
      "Request count, 5xx count and 95th-percentile response time for the tool, in 5-minute buckets, ending when the alert fired.",
    input_schema: {
      type: "object" as const,
      properties: {
        minutes_before: {
          type: "number",
          description: "How far back to look. Default 60, max 240.",
        },
      },
      required: [],
    },
  },
  {
    type: "custom" as const,
    name: "get_logs",
    description:
      "The tool's log lines before the alert fired, newest last. Filter by level and by text the line contains.",
    input_schema: {
      type: "object" as const,
      properties: {
        minutes_before: {
          type: "number",
          description: "How far back to look. Default 60, max 240.",
        },
        level: {
          type: "string",
          enum: ["any", "warn", "error"],
          description: "Lowest level to include. Default any.",
        },
        contains: {
          type: "string",
          description:
            "Only lines containing this text (letters, digits, spaces and . _ / : - only).",
        },
      },
      required: [],
    },
  },
  {
    type: "custom" as const,
    name: "get_recent_deploys",
    description:
      "Recent deploys of the tool, newest first: commit, title and when it was deployed.",
    input_schema: noInput,
  },
  {
    type: "custom" as const,
    name: "get_diff",
    description: "The full change made by one commit: message, files and diff.",
    input_schema: {
      type: "object" as const,
      properties: {
        commit: { type: "string", description: "The commit SHA from get_recent_deploys." },
      },
      required: ["commit"],
    },
  },
  {
    type: "custom" as const,
    name: "post_update",
    description:
      "Post a short status update to the people following the incident (the tool owner and platform on-call). Plain English, no jargon.",
    input_schema: {
      type: "object" as const,
      properties: { text: { type: "string", description: "The update, under 120 words." } },
      required: ["text"],
    },
  },
  {
    type: "custom" as const,
    name: "propose_fix",
    description:
      "Propose a fix as a draft pull request. The workflow applies it in a clean copy of the repository, runs the Guardrails rules, lint, types and tests, and opens the draft only if everything passes. It returns the pull request, or the reasons it was refused.",
    input_schema: {
      type: "object" as const,
      properties: {
        kind: { type: "string", enum: ["revert", "code_fix"] },
        title: { type: "string", description: "Pull request title, 10 to 100 characters." },
        summary: { type: "string", description: "What the fix changes and why, for the reviewer." },
        evidence: {
          type: "string",
          description: "The evidence for the cause: timing, error and the changed code.",
        },
        confidence: { type: "number", description: "Your confidence in the cause, 0 to 100." },
        commit: { type: "string", description: "For a revert: the SHA of the commit to revert." },
        files: {
          type: "array",
          description:
            "For a code fix: the full new contents of each changed or added file, with paths relative to the repository root.",
          items: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      },
      required: ["kind", "title", "summary", "evidence", "confidence"],
    },
  },
  {
    type: "custom" as const,
    name: "record_postmortem",
    description:
      "Save the incident's post-mortem (Markdown, following the team's post-mortem conventions).",
    input_schema: {
      type: "object" as const,
      properties: { markdown: { type: "string" } },
      required: ["markdown"],
    },
  },
];

// ── Shared helpers ───────────────────────────────────────────────────────────────

const AEST = "Australia/Brisbane";
export const clock = (d: Date) =>
  new Intl.DateTimeFormat("en-AU", {
    timeZone: AEST,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);

export function minutesBack(input: Record<string, unknown>): number {
  const n = Number(input.minutes_before ?? 60);
  return Number.isFinite(n) ? Math.min(Math.max(n, 5), 240) : 60;
}

/** Text the agent may filter logs by. Anything else is refused rather than escaped into a query. */
export function safeFilter(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return "";
  const s = String(value);
  return /^[\w .:/-]{1,80}$/.test(s) ? s : null;
}

export function isCommit(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{7,40}$/i.test(value);
}

const DIFF_LIMIT = 60_000;
export const truncate = (s: string, limit = DIFF_LIMIT) =>
  s.length > limit ? `${s.slice(0, limit)}\n… (cut at ${limit / 1000} kB)` : s;

// ── Demo incident ────────────────────────────────────────────────────────────────

export interface DemoIncident {
  id: string;
  tool: string;
  baseBranch: string;
  deployMinutesBeforeAlert: number;
  alert: { name: string; severity: string; condition: string; value: number; target: string };
  metrics: {
    intervalMinutes: number;
    startMinutesBeforeAlert: number;
    requests: number[];
    requests_5xx: number[];
    response_time_ms_p95: number[];
  };
  logs: { minutesBeforeAlert: number; level: "info" | "warn" | "error"; message: string }[];
}

const RANK = { info: 0, warn: 1, error: 2 } as const;

export function demoRead(
  name: string,
  input: Record<string, unknown>,
  incident: DemoIncident,
  firedAt: Date,
): string {
  const at = (minutesBefore: number) => new Date(firedAt.getTime() - minutesBefore * 60_000);

  if (name === "get_alert") {
    return JSON.stringify(
      {
        id: incident.id,
        tool: incident.tool,
        ...incident.alert,
        firedAt: `${clock(firedAt)} AEST`,
      },
      null,
      2,
    );
  }

  if (name === "get_metrics") {
    const back = minutesBack(input);
    const m = incident.metrics;
    const rows = ["time (AEST) | requests | 5xx | p95 ms"];
    m.requests.forEach((requests, i) => {
      const minutesBefore = m.startMinutesBeforeAlert - i * m.intervalMinutes;
      if (minutesBefore > back) return;
      rows.push(
        `${clock(at(minutesBefore))} | ${requests} | ${m.requests_5xx[i]} | ${m.response_time_ms_p95[i]}`,
      );
    });
    return rows.join("\n");
  }

  if (name === "get_logs") {
    const back = minutesBack(input);
    const filter = safeFilter(input.contains);
    if (filter === null)
      return "Refused: contains may only use letters, digits, spaces and . _ / : -";
    const level = input.level === "error" ? 2 : input.level === "warn" ? 1 : 0;
    const lines = incident.logs
      .filter((l) => l.minutesBeforeAlert <= back && RANK[l.level] >= level)
      .filter((l) => !filter || l.message.toLowerCase().includes(filter.toLowerCase()))
      .sort((a, b) => b.minutesBeforeAlert - a.minutesBeforeAlert)
      .map((l) => `${clock(at(l.minutesBeforeAlert))} ${l.level.toUpperCase()} ${l.message}`);
    return lines.length ? lines.join("\n") : "No log lines match.";
  }

  if (name === "get_recent_deploys") {
    // Real commits from the deployed branch; the newest one's deploy time is the demo's.
    const log = git([
      "log",
      "-n",
      "5",
      "--format=%H%x09%s%x09%cI",
      `origin/${incident.baseBranch}`,
    ]).trim();
    const deploys = log.split("\n").map((line, i) => {
      const [sha, title, committed] = line.split("\t");
      const when = i === 0 ? at(incident.deployMinutesBeforeAlert) : new Date(committed ?? firedAt);
      return `${sha?.slice(0, 7)} | ${title} | deployed ${clock(when)} AEST${i === 0 ? " (latest)" : ` on ${when.toISOString().slice(0, 10)}`}`;
    });
    return ["commit | title | deployed", ...deploys].join("\n");
  }

  if (name === "get_diff") {
    if (!isCommit(input.commit)) return "Refused: commit must be a SHA from get_recent_deploys.";
    try {
      return truncate(
        git([
          "show",
          "--stat",
          "--patch",
          "--no-color",
          input.commit,
          "--",
          ".",
          ":!package-lock.json",
        ]),
      );
    } catch {
      return `No commit ${input.commit} in this repository.`;
    }
  }

  return `Unknown tool: ${name}`;
}

// ── Azure ────────────────────────────────────────────────────────────────────────

async function withFile<T>(content: string, use: (arg: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "sre-arg-"));
  const file = join(dir, "arg.txt");
  writeFileSync(file, content);
  try {
    return await use(`@${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function azureRead(
  name: string,
  input: Record<string, unknown>,
  tool: SreTool,
  alertId: string,
  firedAt: Date,
): Promise<string> {
  const end = firedAt.toISOString();
  const start = new Date(firedAt.getTime() - minutesBack(input) * 60_000).toISOString();

  if (name === "get_alert") {
    const id = alertId.replace(/'/g, "");
    const query = `alertsmanagementresources | where id =~ '${id}' or name =~ '${id}' | project name, properties.essentials`;
    const result = (await withFile(query, (arg) =>
      az(["graph", "query", "--graph-query", arg, "--first", "5"]),
    )) as { data?: unknown[] };
    return JSON.stringify(result?.data ?? [], null, 2);
  }

  if (name === "get_metrics") {
    const subscription = (await az(["account", "show", "--query", "id"])) as string;
    const resource = `/subscriptions/${subscription}/resourceGroups/${tool.resourceGroup}/providers/Microsoft.App/containerApps/${tool.containerApp}`;
    const result = await az([
      "monitor",
      "metrics",
      "list",
      "--resource",
      resource,
      "--metrics",
      "Requests",
      "--dimension",
      "statusCodeCategory",
      "--interval",
      "PT5M",
      "--aggregation",
      "Total",
      "--start-time",
      start,
      "--end-time",
      end,
    ]);
    return truncate(JSON.stringify(result));
  }

  if (name === "get_logs") {
    if (!tool.logAnalyticsWorkspaceId)
      return "No Log Analytics workspace is set for this tool in ops/sre-agent.json.";
    const filter = safeFilter(input.contains);
    if (filter === null)
      return "Refused: contains may only use letters, digits, spaces and . _ / : -";
    const app = tool.containerApp.replace(/[^\w-]/g, "");
    const query = [
      "union isfuzzy=true",
      "(ContainerAppConsoleLogs_CL | project TimeGenerated, App = ContainerAppName_s, Log = Log_s),",
      "(ContainerAppConsoleLogs | project TimeGenerated, App = ContainerAppName, Log)",
      `| where App == '${app}' and TimeGenerated between (datetime(${start}) .. datetime(${end}))`,
      filter ? `| where Log has '${filter}'` : "",
      input.level === "error" ? "| where Log has_any ('error', 'ERROR', 'Exception')" : "",
      "| order by TimeGenerated asc | take 200",
    ].join(" ");
    const result = await withFile(query, (arg) =>
      az([
        "monitor",
        "log-analytics",
        "query",
        "--workspace",
        tool.logAnalyticsWorkspaceId as string,
        "--analytics-query",
        arg,
      ]),
    );
    return truncate(JSON.stringify(result));
  }

  if (name === "get_recent_deploys") {
    const result = await az([
      "containerapp",
      "revision",
      "list",
      "--name",
      tool.containerApp,
      "--resource-group",
      tool.resourceGroup,
    ]);
    const revisions = (
      (result as { name?: string; properties?: Record<string, unknown> }[]) ?? []
    ).map((r) => ({
      revision: r.name,
      created: r.properties?.createdTime,
      active: r.properties?.active,
      traffic: r.properties?.trafficWeight,
      image: (r.properties?.template as { containers?: { image?: string }[] } | undefined)
        ?.containers?.[0]?.image,
    }));
    return JSON.stringify(revisions, null, 2);
  }

  if (name === "get_diff") {
    if (!isCommit(input.commit)) return "Refused: commit must be a SHA.";
    const t = process.env.SRE_AGENT_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
    const response = await fetch(
      `https://api.github.com/repos/${tool.repo}/commits/${input.commit}`,
      {
        headers: {
          Accept: "application/vnd.github.diff",
          "User-Agent": "ci-cd-temp-sre-agent",
          ...(t ? { Authorization: `Bearer ${t}` } : {}),
        },
      },
    );
    return response.ok
      ? truncate(await response.text())
      : `GitHub answered ${response.status} for ${input.commit}.`;
  }

  return `Unknown tool: ${name}`;
}
