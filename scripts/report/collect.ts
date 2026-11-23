// Gathers the day's facts with read-only calls: the Azure CLI (already signed in by the
// workflow through OIDC) and the GitHub search API. Each source is tried on its own; one that
// fails is listed under "Couldn't check" instead of stopping the report.
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  alertsQuery,
  changesQuery,
  costQueryBody,
  emptyFacts,
  mergedSearchQuery,
  outsideCodeQuery,
  parseAdoption,
  parseAlerts,
  parseChanges,
  parseCost,
  parseOutside,
  parsePulls,
  parseWhatIf,
  repoQuery,
  whatIfArgs,
  type Facts,
  type ReportConfig,
} from "./model.js";

const run = promisify(execFile);

export async function az(args: string[]): Promise<unknown> {
  const { stdout } = await run("az", [...args, "--only-show-errors", "--output", "json"], {
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32", // az is a .cmd file on Windows
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

// Long values (queries, JSON bodies) reach the CLI as @file arguments, so no shell can
// reinterpret their quotes or pipes. On Windows, az runs through cmd.exe.
async function withFile<T>(content: string, use: (arg: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "daily-report-"));
  const file = join(dir, "arg.txt");
  writeFileSync(file, content);
  try {
    return await use(`@${file}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function graph(query: string): Promise<Record<string, unknown>[]> {
  const result = (await withFile(query, (arg) =>
    az(["graph", "query", "--graph-query", arg, "--first", "1000"]),
  )) as { data?: Record<string, unknown>[] } | null;
  return result?.data ?? [];
}

function costQuery(url: string, body: unknown): Promise<unknown> {
  return withFile(JSON.stringify(body), (arg) =>
    az(["rest", "--method", "post", "--url", url, "--body", arg]),
  );
}

/** The Azure CLI's own "ERROR:" line when there is one, not the command that was run. */
function firstLine(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const raw =
    typeof stderr === "string" && stderr.trim()
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const line = lines.find((l) => l.startsWith("ERROR")) ?? lines[0] ?? raw;
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

async function attempt(label: string, problems: string[], work: () => Promise<void>) {
  try {
    await work();
  } catch (error) {
    problems.push(`${label}: ${firstLine(error)}`);
  }
}

export async function collect(config: ReportConfig, now = new Date()): Promise<Facts> {
  const facts = emptyFacts(config, now);
  const { problems } = facts;
  const groups = [
    ...config.tools.map((t) => t.resourceGroup),
    ...(config.watchResourceGroups ?? []),
  ];

  for (const tool of config.tools) {
    await attempt(`Drift check for ${tool.name}`, problems, async () => {
      facts.drift.push(...parseWhatIf(tool.name, await az(whatIfArgs(tool))));
    });
  }

  await attempt("Resources made outside the code", problems, async () => {
    facts.outsideCode = parseOutside(await graph(outsideCodeQuery(groups)));
  });

  await attempt("Changes made in Azure", problems, async () => {
    facts.changes = parseChanges(await graph(changesQuery(groups)));
  });

  await attempt("Alerts", problems, async () => {
    facts.alerts = parseAlerts(await graph(alertsQuery()), config.tools);
  });

  await attempt("Yesterday's spend", problems, async () => {
    const subscription = (await az(["account", "show", "--query", "id"])) as string;
    const url = `https://management.azure.com/subscriptions/${subscription}/providers/Microsoft.CostManagement/query?api-version=2023-11-01`;
    // Accounts bill under "Cost" or the older "PreTaxCost" depending on their agreement type.
    let column: "Cost" | "PreTaxCost" = "Cost";
    let result: unknown;
    for (let tries = 1; result === undefined; tries++) {
      try {
        result = await costQuery(url, costQueryBody(now, column));
      } catch (error) {
        const reason = firstLine(error);
        // Cost Management limits how often it can be asked (HTTP 429): wait and ask again.
        if (/429|too many requests/i.test(reason) && tries < 3) {
          await new Promise((resolve) => setTimeout(resolve, 30_000 * tries));
        } else if (column === "Cost" && /400|bad ?request/i.test(reason)) {
          column = "PreTaxCost";
        } else {
          throw error;
        }
      }
    }
    facts.cost = parseCost(result, config.tools);
  });

  for (const tool of config.tools.filter((t) => t.repo)) {
    await attempt(`Checks baseline for ${tool.name}`, problems, async () => {
      const token = process.env.GITHUB_TOKEN;
      const response = await fetch(
        `https://api.github.com/repos/${tool.repo}/contents/.platform/baseline.json?ref=${encodeURIComponent(tool.baseBranch ?? "main")}`,
        {
          headers: {
            Accept: "application/vnd.github.raw+json",
            "User-Agent": "ci-cd-temp-daily-report",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
      );
      if (response.status === 404) {
        facts.adoption.push(parseAdoption(tool, null));
        return;
      }
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`);
      facts.adoption.push(parseAdoption(tool, await response.json()));
    });
  }

  await attempt("What shipped (GitHub)", problems, async () => {
    const base =
      config.github?.query ||
      repoQuery(config.tools) ||
      (process.env.GITHUB_REPOSITORY ? `repo:${process.env.GITHUB_REPOSITORY}` : "");
    if (!base) throw new Error("register a tool, set github.query, or run this in GitHub Actions");
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const q = encodeURIComponent(mergedSearchQuery(base, since));
    const token = process.env.GITHUB_TOKEN;
    const response = await fetch(`https://api.github.com/search/issues?q=${q}&per_page=50`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "ci-cd-temp-daily-report",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!response.ok) throw new Error(`GitHub search answered ${response.status}`);
    facts.shipped = parsePulls(await response.json());
  });

  return facts;
}
