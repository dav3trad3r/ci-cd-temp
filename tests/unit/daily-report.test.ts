import { describe, expect, test } from "vitest";
import {
  emptyFacts,
  mergedSearchQuery,
  outsideCodeQuery,
  parseAlerts,
  parseCost,
  parsePulls,
  parseWhatIf,
  safeGroups,
  whatIfArgs,
  type ReportConfig,
} from "../../scripts/report/model.js";
import { buildPrompt, decisions, renderPlain, teamsPayload } from "../../scripts/report/render.js";
import { sampleFacts } from "../../scripts/report/sample.js";

const tool = {
  name: "leasing-assistant",
  owner: "jane@example.com",
  resourceGroup: "rg-leasing",
  parameters: "infra/tools/leasing.bicepparam",
  dailyBudget: 5,
};
const config: ReportConfig = {
  title: "Platform report",
  timeZone: "Australia/Brisbane",
  tools: [tool],
  foundry: { model: "claude-opus-5-5", auth: "key" },
};
const now = new Date("2026-11-23T05:00:00Z");

describe("drift (Bicep what-if)", () => {
  test("reports settings changed outside the code and resources missing from Azure", () => {
    const result = {
      changes: [
        {
          resourceId:
            "/subscriptions/s/resourceGroups/rg-leasing/providers/Microsoft.KeyVault/vaults/kv1",
          changeType: "NoChange",
        },
        {
          resourceId:
            "/subscriptions/s/resourceGroups/rg-leasing/providers/Microsoft.App/containerApps/leasing-assistant",
          changeType: "Modify",
          delta: [
            {
              path: "properties.template",
              propertyChangeType: "Modify",
              children: [
                { path: "scale.minReplicas", propertyChangeType: "Modify", before: 1, after: 0 },
              ],
            },
          ],
        },
        {
          resourceId:
            "/subscriptions/s/resourceGroups/rg-leasing/providers/Microsoft.Insights/metricAlerts/http-5xx",
          changeType: "Create",
        },
        {
          resourceId:
            "/subscriptions/s/resourceGroups/rg-leasing/providers/Microsoft.Storage/storageAccounts/st1",
          changeType: "Ignore",
        },
        {
          resourceId:
            "/subscriptions/s/resourceGroups/rg-leasing/providers/Microsoft.App/containerApps/x",
          changeType: "Deploy",
        },
      ],
    };
    expect(parseWhatIf("leasing-assistant", result)).toEqual([
      {
        tool: "leasing-assistant",
        change: "Modify",
        resource: "containerApps/leasing-assistant",
        details: ["properties.template.scale.minReplicas: Azure has 1, the code says 0"],
      },
      {
        tool: "leasing-assistant",
        change: "Create",
        resource: "metricAlerts/http-5xx",
        details: [],
      },
    ]);
  });

  // Shapes taken from a what-if run on a real, unchanged deployment (22 Nov 2026): without
  // these rules it reported three "drifted" resources that hadn't changed.
  test("leaves out the noise what-if repeats on every run", () => {
    const app = "/subscriptions/s/resourceGroups/rg/providers/Microsoft.App/containerApps/demo";
    const role =
      "/subscriptions/s/resourceGroups/rg/providers/Microsoft.Authorization/roleAssignments/r1";
    const result = {
      changes: [
        {
          resourceId: app,
          changeType: "Modify",
          delta: [
            {
              path: "properties.template.scale.cooldownPeriod",
              propertyChangeType: "Delete",
              before: 300,
            },
            {
              path: "properties.configuration.secrets.0.keyVaultUrl",
              propertyChangeType: "Modify",
              before: "https://kv.vault.azure.net/secrets/x",
              after: "[format('{0}secrets/{1}', reference('kv').vaultUri, 'x')]",
            },
          ],
        },
        {
          resourceId: role,
          changeType: "Modify",
          delta: [
            {
              path: "properties.principalType",
              propertyChangeType: "NoEffect",
              after: "ServicePrincipal",
            },
          ],
        },
      ],
    };
    expect(parseWhatIf("demo", result)).toEqual([]);
  });

  test("runs what-if with read-only checks, and lets a .bicepparam file name its template", () => {
    const args = whatIfArgs({ ...tool, template: "infra/tool.bicep" });
    expect(args).toEqual(
      expect.arrayContaining(["--validation-level", "ProviderNoRbac", "--no-pretty-print"]),
    );
    expect(args).not.toContain("--template-file");
    expect(whatIfArgs({ ...tool, parameters: "p.json", template: "infra/tool.bicep" })).toContain(
      "--template-file",
    );
  });
});

describe("queries", () => {
  test("only well-formed resource group names reach a query", () => {
    expect(safeGroups(["rg-platform", "rg-platform", "x') | delete", "rg_tools.1"])).toEqual([
      "rg-platform",
      "rg_tools.1",
    ]);
    expect(outsideCodeQuery(["rg-a", "bad'name"])).toContain("in~ ('rg-a')");
  });

  test("the GitHub search covers merges in the last 24 hours", () => {
    expect(mergedSearchQuery("org:place", new Date("2026-11-22T05:00:00Z"))).toBe(
      "org:place is:pr is:merged merged:>=2026-11-22T05:00:00+00:00",
    );
  });
});

describe("cost, alerts and pull requests", () => {
  test("spend per tool comes from the tool tag, and spend outside any tool is still shown", () => {
    const result = {
      properties: {
        columns: [{ name: "Cost" }, { name: "TagKey" }, { name: "TagValue" }, { name: "Currency" }],
        rows: [
          [7.4, "tool", "leasing-assistant", "AUD"],
          [2.5, "tool", "", "AUD"],
        ],
      },
    };
    expect(parseCost(result, [tool])).toEqual({
      currency: "AUD",
      rows: [
        { tool: "leasing-assistant", amount: 7.4, budget: 5 },
        { tool: "untagged", amount: 2.5 },
      ],
    });
  });

  test("alerts are matched to a tool by resource group", () => {
    const rows = [
      {
        name: "5xx",
        severity: "Sev1",
        state: "New",
        target: "/subscriptions/s/resourceGroups/RG-LEASING/providers/x/y",
      },
      {
        name: "cpu",
        severity: "Sev3",
        state: "New",
        target: "/subscriptions/s/resourceGroups/rg-other/providers/x/y",
      },
    ];
    expect(parseAlerts(rows, [tool]).map((a) => a.tool)).toEqual(["leasing-assistant", "platform"]);
  });

  test("a pull request approved with the guardrail-change label is marked as an exception", () => {
    const result = {
      items: [
        {
          title: "Raise budget",
          html_url: "u1",
          repository_url: "https://api.github.com/repos/place/tool",
          labels: [{ name: "guardrail-change" }],
        },
        {
          title: "Fix typo",
          html_url: "u2",
          repository_url: "https://api.github.com/repos/place/tool",
          labels: [],
        },
      ],
    };
    expect(parsePulls(result).map((p) => [p.repo, p.exception])).toEqual([
      ["place/tool", true],
      ["place/tool", false],
    ]);
  });
});

describe("the report", () => {
  test("a quiet day says so plainly", () => {
    const text = renderPlain(emptyFacts(config, now));
    expect(text).toContain("Nothing needs a decision today.");
    expect(text).toContain("leasing-assistant (jane@example.com): no drift · no alerts");
  });

  test("spend that no tool owns is shown, so it can't hide", () => {
    const facts = emptyFacts(config, now);
    facts.cost = {
      currency: "AUD",
      rows: [
        { tool: "leasing-assistant", amount: 1, budget: 5 },
        { tool: "untagged", amount: 0.24 },
      ],
    };
    expect(renderPlain(facts)).toContain(
      "- Not linked to a tool: 0.24 AUD yesterday (untagged 0.24 AUD)",
    );
  });

  test("drift, hand-made resources, overspend and open severe alerts need a decision", () => {
    const facts = sampleFacts(config, now);
    facts.alerts.push({
      name: "5xx",
      severity: "Sev1",
      state: "New",
      tool: "leasing-assistant",
      started: "",
    });
    const todo = decisions(facts);
    expect(todo).toHaveLength(4);
    expect(todo[0]).toContain("changed outside the code");
    expect(todo[2]).toBe(
      "leasing-assistant spent 7.40 AUD yesterday, over its 5.00 AUD daily budget",
    );
  });

  test("a check that couldn't run is reported, not hidden", () => {
    const facts = emptyFacts(config, now);
    facts.problems.push("Yesterday's spend: AuthorizationFailed");
    expect(renderPlain(facts)).toContain(
      "**Couldn't check**\n- Yesterday's spend: AuthorizationFailed",
    );
  });

  test("the agent is told to use only the facts it is given", () => {
    const prompt = buildPrompt(sampleFacts(config, now));
    expect(prompt.system).toContain("Use only the facts");
    expect(prompt.user).toContain("scale.minReplicas: Azure has 1, the code says 0");
  });

  test("the Teams card has one text block per line, with bullets kept", () => {
    const card = teamsPayload(
      "Platform report · Mon 23 Nov 2026",
      "All clear today.\n- leasing-assistant: no drift",
    );
    const body = card.attachments[0]?.content.body ?? [];
    expect(body.map((b) => b.text)).toEqual([
      "Platform report · Mon 23 Nov 2026",
      "All clear today.",
      "• leasing-assistant: no drift",
    ]);
  });
});
