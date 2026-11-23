// 2026-11-23: CodeQL flagged two high-severity alerts on the files the platform generates for each
// tool. Quotes were escaped but backslashes weren't, so a start command like `node C:\app\run.js`
// produced a Dockerfile CMD that wasn't valid JSON, and a backslash before a quote could end the
// string early. In Bicep, `${...}` inside a value was also read as code rather than text.
// Generated values are now written with each format's own rules.
import { describe, expect, test } from "vitest";
import { GENERATED_DOCKERFILE } from "../../scripts/platform/detect.js";
import {
  manifestSchema,
  newRegistryEntry,
  type Manifest,
  type Settings,
} from "../../scripts/platform/model.js";
import { bicepParamFile, dockerfileFor } from "../../scripts/platform/tool-files.js";

const manifest: Manifest = manifestSchema.parse({
  name: "notes-tool",
  kind: "migrated",
  owner: "sam@example.com",
  stack: "node",
  nodeVersion: "22",
  packageManager: "npm",
  commands: {
    install: "npm ci --no-audit --no-fund",
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
  dockerfile: GENERATED_DOCKERFILE,
});

const settings = (costCentre: string): Settings => ({
  org: "acme",
  platformRepo: "ci-cd-temp",
  approversTeam: "pipeline-approvers",
  azure: {
    environmentId: "/subscriptions/x/env",
    actionGroupId: "/subscriptions/x/ag",
    registryName: "acracme",
    registryResourceGroup: "rg-platform",
    costCentre,
  },
});

describe("values in generated files stay plain text", () => {
  test.each([
    "npm start",
    'node "my app.js"',
    "node C:\\app\\run.js",
    'echo \\" && echo injected',
    "node server.js\nRUN echo injected",
  ])("a Dockerfile runs exactly this start command: %s", (start) => {
    const text = dockerfileFor({ ...manifest, start }) ?? "";
    const cmd = text.split("\n").find((line) => line.startsWith("CMD "));
    expect(JSON.parse(cmd?.slice(4) ?? "")).toEqual(["sh", "-c", start]);
    expect(text.split("\n").filter((line) => line.startsWith("RUN echo"))).toEqual([]);
  });

  test.each([
    ["OPS\\", "'OPS\\\\'"],
    ["it's", "'it\\'s'"],
    ["OPS\\'", "'OPS\\\\\\''"],
    ["${evil}", "'\\${evil}'"],
    ["two\nlines", "'two\\nlines'"],
  ])("a Bicep value keeps its meaning: %s", (costCentre, written) => {
    const entry = newRegistryEntry({
      name: "notes-tool",
      kind: "migrated",
      owner: "sam@example.com",
      org: "acme",
    });
    const text = bicepParamFile(entry, manifest, settings(costCentre));
    expect(text).toContain(`param costCentre = ${written}\n`);
  });
});
