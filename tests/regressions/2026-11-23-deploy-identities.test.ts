// 2026-11-23: the setup steps led to one Azure identity for every tool's staging, production and
// builds, so a mistake in one pipeline could reach the others. Each tool now gets its own two
// identities: one that can only push its image, and one that can only release its own app.
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { manifestSchema, newRegistryEntry } from "../../scripts/platform/model.js";
import { bicepParamFile } from "../../scripts/platform/tool-files.js";

const tool = readFileSync("infra/tool.bicep", "utf8");
const push = readFileSync("infra/modules/acr-push.bicep", "utf8");

/** Each role assignment in a template, as its own block of text. */
const assignments = (text: string) =>
  text
    .split(/(?=^resource )/m)
    .filter((block) => block.includes("Microsoft.Authorization/roleAssignments"));

describe("each tool's deploy identities", () => {
  test("the build identity is trusted only from the tool's main branch", () => {
    const block = tool.slice(tool.indexOf("resource buildFromBranch"));
    expect(block).toContain("subject: 'repo:${githubRepo}:ref:refs/heads/${deployBranch}'");
  });

  test("the release identity is trusted only from the tool's two environments", () => {
    expect(tool).toContain("subject: 'repo:${githubRepo}:environment:staging'");
    expect(tool).toContain("subject: 'repo:${githubRepo}:environment:production'");
    expect(tool.match(/federatedIdentityCredentials@/g)).toHaveLength(3);
  });

  test("the release identity can reach only this tool's app and database job", () => {
    const release = assignments(tool).filter((b) => b.includes("releaseIdentity"));
    expect(release).toHaveLength(2);
    expect(release[0]).toContain("scope: app");
    expect(release[1]).toContain("scope: migrationJob");
  });

  test("no deploy identity is granted anything across a resource group", () => {
    for (const block of assignments(tool).filter((b) => /build|release/i.test(b))) {
      expect(block).not.toMatch(/scope: resourceGroup\(\)|scope: subscription\(\)/);
    }
  });

  test("the build identity can push only to the tool's own repository", () => {
    expect(push).toContain("StringEqualsIgnoreCase \\'${repository}\\'");
    expect(push).toContain("condition: perRepository ? onlyThisRepository : null");
    expect(tool).toContain("repository: name");
  });

  test("a tool's parameters name its repository and branch", () => {
    const manifest = manifestSchema.parse({
      name: "notes-tool",
      kind: "new",
      owner: "sam@example.com",
      stack: "node",
      nodeVersion: "22",
      packageManager: "npm",
      commands: {
        install: "npm ci",
        format: null,
        lint: null,
        typecheck: null,
        test: null,
        build: null,
        smoke: null,
        eval: null,
      },
      webDir: null,
      start: "npm start",
      port: 8080,
      healthPath: "/",
      dockerfile: ".platform/Dockerfile",
    });
    const entry = newRegistryEntry({
      name: "notes-tool",
      kind: "new",
      owner: "sam@example.com",
      org: "acme",
      baseBranch: "trunk",
    });
    const text = bicepParamFile(entry, manifest, {
      org: "acme",
      platformRepo: "ci-cd-temp",
      approversTeam: "pipeline-approvers",
      azure: {
        environmentId: "/subscriptions/x/env",
        actionGroupId: "/subscriptions/x/ag",
        registryName: "acracme",
        registryResourceGroup: "rg-platform",
        costCentre: "OPS",
      },
    });
    expect(text).toContain("param githubRepo = 'acme/notes-tool'\n");
    expect(text).toContain("param deployBranch = 'trunk'\n");
  });
});
