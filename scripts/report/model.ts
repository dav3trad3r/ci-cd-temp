// The afternoon platform report's rules: raw Azure and GitHub JSON in, plain facts out.
// Nothing here calls the network or the Azure CLI, so every rule is unit-tested
// (tests/unit/daily-report.test.ts). collect.ts does the calling.

export interface ToolConfig {
  name: string;
  owner: string;
  resourceGroup: string;
  /** The tool's parameters file, e.g. infra/tools/leasing-assistant.bicepparam. */
  parameters: string;
  /** Only needed with a .json parameters file; a .bicepparam file names its own template. */
  template?: string;
  /** Daily spend the owner expects, in the billing currency. Over it shows under "Needs a decision". */
  dailyBudget?: number;
}

export interface ReportConfig {
  title: string;
  timeZone: string;
  tools: ToolConfig[];
  /** Resource groups watched as well as each tool's own, such as the shared platform group. */
  watchResourceGroups?: string[];
  foundry: {
    /** The Foundry resource name; the SDK calls https://{resource}.services.ai.azure.com/anthropic/. */
    resource?: string;
    model: string;
    /** "key": an API key from ANTHROPIC_FOUNDRY_API_KEY or Key Vault. "entra": the pipeline's own identity, no key. */
    auth: "key" | "entra";
    keyVault?: string;
    secretName?: string;
  };
  github?: { query?: string };
}

export interface DriftItem {
  tool: string;
  change: string;
  resource: string;
  details: string[];
}
export interface OutsideItem {
  name: string;
  type: string;
  resourceGroup: string;
}
export interface ChangeItem {
  resource: string;
  changeType: string;
  changedBy: string;
  clientType: string;
  time: string;
}
export interface AlertItem {
  name: string;
  severity: string;
  state: string;
  tool: string;
  started: string;
}
export interface CostRow {
  tool: string;
  amount: number;
  budget?: number;
}
export interface ShippedItem {
  title: string;
  url: string;
  repo: string;
  exception: boolean;
}

export interface Facts {
  title: string;
  date: string;
  tools: { name: string; owner: string }[];
  drift: DriftItem[];
  outsideCode: OutsideItem[];
  changes: ChangeItem[];
  alerts: AlertItem[];
  cost: { currency: string; rows: CostRow[] } | null;
  shipped: ShippedItem[];
  /** Checks that couldn't run. Reported, never hidden. */
  problems: string[];
}

export function emptyFacts(config: ReportConfig, now: Date): Facts {
  return {
    title: config.title,
    date: formatDate(now, config.timeZone),
    tools: config.tools.map((t) => ({ name: t.name, owner: t.owner })),
    drift: [],
    outsideCode: [],
    changes: [],
    alerts: [],
    cost: null,
    shipped: [],
    problems: [],
  };
}

export function formatDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(now);
}

// ── Drift: Bicep what-if ────────────────────────────────────────────────────────

/** What-if change types that mean Azure and the code disagree. "Ignore" (in Azure, not in
 *  the code) is left to the managed-by tag query, which also catches resources what-if skips. */
const DRIFT_CHANGES: Record<string, string> = {
  Modify: "was changed outside the code",
  Create: "is in the code but missing from Azure",
  Delete: "is in Azure but due to be deleted",
};

export function driftLabel(change: string): string {
  return DRIFT_CHANGES[change] ?? change;
}

/** Arguments for `az deployment group what-if`. ProviderNoRbac checks only read access, so the
 *  report's identity never needs permission to deploy. */
export function whatIfArgs(tool: ToolConfig): string[] {
  const args = [
    "deployment",
    "group",
    "what-if",
    "--resource-group",
    tool.resourceGroup,
    "--parameters",
    tool.parameters,
    "--validation-level",
    "ProviderNoRbac",
    "--no-pretty-print",
    "--result-format",
    "FullResourcePayloads",
  ];
  if (tool.template && !tool.parameters.endsWith(".bicepparam")) {
    args.push("--template-file", tool.template);
  }
  return args;
}

interface WhatIfDelta {
  path?: string;
  propertyChangeType?: string;
  before?: unknown;
  after?: unknown;
  children?: WhatIfDelta[] | null;
}
interface WhatIfChange {
  resourceId?: string;
  changeType?: string;
  delta?: WhatIfDelta[] | null;
}

export function parseWhatIf(tool: string, result: unknown): DriftItem[] {
  const changes = (result as { changes?: WhatIfChange[] } | null)?.changes ?? [];
  const items: DriftItem[] = [];
  for (const c of changes) {
    if (c.changeType === undefined || !(c.changeType in DRIFT_CHANGES)) continue;
    const details = c.changeType === "Modify" ? flattenDelta(c.delta ?? []) : [];
    // A "Modify" made only of noise (below) isn't drift.
    if (c.changeType === "Modify" && details.length === 0) continue;
    items.push({
      tool,
      change: c.changeType,
      resource: shortName(c.resourceId ?? "unknown"),
      details,
    });
  }
  return items;
}

// What-if repeats three kinds of noise on every run, found on a real deployment (22 Nov 2026):
// - "Delete": a setting Azure fills in that the code doesn't mention (exposedPort 0, cooldownPeriod 300)
// - "NoEffect": what-if itself says nothing would change
// - an "after" value still written as an expression ("[reference(...)]"), only known at deploy time
// Resources made outside the code are caught by the managed-by tag check instead.
function isNoise(d: WhatIfDelta): boolean {
  if (d.propertyChangeType === "Delete" || d.propertyChangeType === "NoEffect") return true;
  return typeof d.after === "string" && d.after.startsWith("[") && d.after.endsWith("]");
}

// what-if describes what a deployment would do: "before" is Azure today, "after" is the code.
function flattenDelta(delta: WhatIfDelta[], prefix = ""): string[] {
  const lines: string[] = [];
  for (const d of delta) {
    const path = prefix && d.path ? `${prefix}.${d.path}` : (d.path ?? prefix);
    if (d.children && d.children.length > 0) {
      lines.push(...flattenDelta(d.children, path));
    } else if (!isNoise(d)) {
      lines.push(`${path}: Azure has ${show(d.before)}, the code says ${show(d.after)}`);
    }
  }
  return lines;
}

function show(value: unknown): string {
  if (value === undefined || value === null) return "nothing set";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** ".../providers/Microsoft.App/containerApps/leasing-assistant" → "containerApps/leasing-assistant" */
export function shortName(resourceId: string): string {
  const parts = resourceId.split("/").filter(Boolean);
  return parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : resourceId;
}

// ── Azure Resource Graph queries ────────────────────────────────────────────────

/** Resource group names are letters, digits and . _ - ( ) only; anything else is dropped
 *  rather than pasted into a query. */
export function safeGroups(groups: string[]): string[] {
  return [...new Set(groups)].filter((g) => /^[\w.()-]{1,90}$/.test(g));
}

function inGroups(groups: string[]): string {
  return safeGroups(groups)
    .map((g) => `'${g}'`)
    .join(", ");
}

/** Everything in the watched groups that Bicep didn't create (both templates tag managed-by: bicep). */
export function outsideCodeQuery(groups: string[]): string {
  return [
    "resources",
    `| where resourceGroup in~ (${inGroups(groups)})`,
    "| where tostring(tags['managed-by']) != 'bicep'",
    "| project name, type, resourceGroup",
    "| order by resourceGroup asc, name asc",
  ].join(" ");
}

/** Property changes in the last 24 hours, with who made them and from where (portal, CLI, pipeline). */
export function changesQuery(groups: string[]): string {
  return [
    "resourcechanges",
    "| extend changedAt = todatetime(properties.changeAttributes.timestamp)",
    "| where changedAt > ago(1d)",
    "| extend resourceId = tostring(properties.targetResourceId)",
    "| extend group = tostring(split(resourceId, '/')[4])",
    `| where group in~ (${inGroups(groups)})`,
    "| project resourceId, changeType = tostring(properties.changeType),",
    "changedBy = tostring(properties.changeAttributes.changedBy),",
    "clientType = tostring(properties.changeAttributes.clientType), changedAt",
    "| order by changedAt desc",
  ].join(" ");
}

/** Azure Monitor alerts that started in the last 24 hours. */
export function alertsQuery(): string {
  return [
    "alertsmanagementresources",
    "| where type =~ 'microsoft.alertsmanagement/alerts'",
    "| extend e = properties.essentials",
    "| where todatetime(e.startDateTime) > ago(1d)",
    "| project name, severity = tostring(e.severity), state = tostring(e.alertState),",
    "target = tostring(e.targetResource), started = tostring(e.startDateTime)",
    "| order by started desc",
  ].join(" ");
}

type Row = Record<string, unknown>;
const text = (v: unknown, fallback = ""): string =>
  typeof v === "string" && v ? v : v == null ? fallback : String(v);

export function parseOutside(rows: Row[]): OutsideItem[] {
  return rows.map((r) => ({
    name: text(r.name, "unknown"),
    type: text(r.type, "unknown").split("/").pop() ?? "unknown",
    resourceGroup: text(r.resourceGroup, "unknown"),
  }));
}

export function parseChanges(rows: Row[]): ChangeItem[] {
  return rows.map((r) => ({
    resource: shortName(text(r.resourceId, "unknown")),
    changeType: text(r.changeType, "Update"),
    changedBy: text(r.changedBy, "unknown"),
    clientType: text(r.clientType, "unknown"),
    time: text(r.changedAt),
  }));
}

/** Matches each alert to a tool by the resource group in its target resource. */
export function parseAlerts(rows: Row[], tools: ToolConfig[]): AlertItem[] {
  return rows.map((r) => {
    const target = text(r.target).toLowerCase();
    const tool = tools.find((t) =>
      target.includes(`/resourcegroups/${t.resourceGroup.toLowerCase()}/`),
    );
    return {
      name: text(r.name, "alert"),
      severity: text(r.severity, "Sev?"),
      state: text(r.state, "unknown"),
      tool: tool?.name ?? "platform",
      started: text(r.started),
    };
  });
}

// ── Cost: Azure Cost Management query ───────────────────────────────────────────

/** Yesterday's actual cost, grouped by the `tool` tag both templates set. */
export function costQueryBody(now: Date, costColumn: "Cost" | "PreTaxCost") {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const start = new Date(end.getTime() - 24 * 60 * 60 * 1000);
  return {
    type: "ActualCost",
    timeframe: "Custom",
    timePeriod: { from: start.toISOString(), to: new Date(end.getTime() - 1000).toISOString() },
    dataset: {
      granularity: "None",
      aggregation: { totalCost: { name: costColumn, function: "Sum" } },
      grouping: [{ type: "TagKey", name: "tool" }],
    },
  };
}

export function parseCost(
  result: unknown,
  tools: ToolConfig[],
): { currency: string; rows: CostRow[] } {
  const props = (result as { properties?: { columns?: { name: string }[]; rows?: unknown[][] } })
    ?.properties;
  const columns = (props?.columns ?? []).map((c) => c.name.toLowerCase());
  const costAt = columns.findIndex((c) => c === "cost" || c === "pretaxcost");
  const tagAt = columns.indexOf("tagvalue");
  const currencyAt = columns.indexOf("currency");
  const spent = new Map<string, number>();
  let currency = "";
  for (const row of props?.rows ?? []) {
    const tool = tagAt >= 0 ? text(row[tagAt]) : "";
    const amount = Number(row[costAt] ?? 0);
    if (currencyAt >= 0 && !currency) currency = text(row[currencyAt]);
    const key = tool || "untagged";
    spent.set(key, (spent.get(key) ?? 0) + (Number.isFinite(amount) ? amount : 0));
  }
  const rows: CostRow[] = tools.map((t) => ({
    tool: t.name,
    amount: spent.get(t.name) ?? 0,
    budget: t.dailyBudget,
  }));
  for (const [tool, amount] of spent) {
    if (!tools.some((t) => t.name === tool) && amount > 0) rows.push({ tool, amount });
  }
  return { currency: currency || "AUD", rows };
}

// ── What shipped: GitHub ────────────────────────────────────────────────────────

export function mergedSearchQuery(base: string, since: Date): string {
  return `${base} is:pr is:merged merged:>=${since.toISOString().slice(0, 19)}+00:00`;
}

interface SearchItem {
  title?: string;
  html_url?: string;
  repository_url?: string;
  labels?: { name?: string }[];
}

export function parsePulls(result: unknown): ShippedItem[] {
  const items = (result as { items?: SearchItem[] } | null)?.items ?? [];
  return items.map((i) => ({
    title: i.title ?? "(untitled)",
    url: i.html_url ?? "",
    repo: (i.repository_url ?? "").split("/repos/")[1] ?? "",
    exception: (i.labels ?? []).some((l) => l.name === "guardrail-change"),
  }));
}
