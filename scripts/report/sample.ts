// Example facts for a dry run (`npm run report:sample`), so the report can be seen and tested
// before Azure, Foundry or Teams are connected. Every value here is made up.
import { emptyFacts, type Facts, type ReportConfig } from "./model.js";

export function sampleFacts(config: ReportConfig, now = new Date()): Facts {
  const facts = emptyFacts(config, now);
  const tool = config.tools[0]?.name ?? "leasing-assistant";
  facts.title = `${config.title} (example data)`;
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
