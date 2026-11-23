// Example facts for a dry run (`npm run report:sample`), so the report can be seen and tested
// before Azure, Foundry or Teams are connected. Every value here is made up.
import { emptyFacts, type Facts, type ReportConfig } from "./model.js";

const EXAMPLE_TOOLS: ReportConfig["tools"] = [
  {
    name: "leasing-assistant",
    owner: "jane.citizen@example.com",
    resourceGroup: "rg-leasing-assistant",
    parameters: "infra/tools/example.bicepparam",
    dailyBudget: 5,
    kind: "new",
  },
  {
    name: "inspection-notes",
    owner: "sam.citizen@example.com",
    resourceGroup: "rg-inspection-notes",
    parameters: "infra/tools/example.bicepparam",
    dailyBudget: 3,
    kind: "migrated",
  },
];

export function sampleFacts(input: ReportConfig, now = new Date()): Facts {
  const config = input.tools.length ? input : { ...input, tools: EXAMPLE_TOOLS };
  const facts = emptyFacts(config, now);
  const tool = config.tools[0]?.name ?? "leasing-assistant";
  facts.title = `${config.title} (example data)`;
  facts.adoption = config.tools.map((t, i) => ({
    tool: t.name,
    kind: t.kind ?? "new",
    serious: i === 1 ? 1 : 0,
    known: i === 1 ? 3 : 0,
  }));
  facts.drift = [
    {
      tool,
      change: "Modify",
      resource: `containerApps/${tool}`,
      details: ["properties.template.scale.minReplicas: Azure has 1, the code says 0"],
    },
  ];
  facts.outsideCode = [
    { name: "sttempexport4821", type: "storageAccounts", resourceGroup: `rg-${tool}` },
  ];
  facts.changes = [
    {
      resource: `containerApps/${tool}`,
      changeType: "Update",
      changedBy: "jane.citizen@example.com",
      clientType: "Azure Portal",
      time: new Date(now.getTime() - 5 * 60 * 60 * 1000).toISOString(),
    },
  ];
  facts.alerts = [
    {
      name: `${tool} 5xx responses`,
      severity: "Sev2",
      state: "Closed",
      tool,
      started: new Date(now.getTime() - 9 * 60 * 60 * 1000).toISOString(),
    },
  ];
  facts.cost = {
    currency: "AUD",
    rows: config.tools.map((t, i) => ({
      tool: t.name,
      amount: i === 0 ? 7.4 : 1.15,
      budget: t.dailyBudget,
    })),
  };
  facts.shipped = [
    {
      title: "Add the quote export button",
      url: "https://github.com/example/leasing-assistant/pull/42",
      repo: "example/leasing-assistant",
      exception: false,
    },
    {
      title: "Raise the bundle budget for the new chart library",
      url: "https://github.com/example/leasing-assistant/pull/43",
      repo: "example/leasing-assistant",
      exception: true,
    },
  ];
  return facts;
}
