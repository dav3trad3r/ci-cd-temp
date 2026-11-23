// 2026-11-23: rollback shared a queue with deployments, so it waited behind a running deploy and a
// newer merge could cancel it while it waited. Rollback now has its own queue. Because it can now
// run during a deploy, nothing else may overwrite it: staging leaves pinned traffic alone, promote
// stops if traffic moved under it, and rollback checks that its change stuck.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  deployStaging,
  followsLatest,
  promote,
  rollback,
  timing,
  type TrafficEntry,
} from "../../scripts/platform/deploy.js";
import { manifestSchema } from "../../scripts/platform/model.js";

const azure = vi.hoisted(() => ({
  calls: [] as string[][],
  answer: (() => null) as (args: string[]) => unknown,
}));

vi.mock("node:child_process", async (original) => {
  const { promisify } = await import("node:util");
  const real = await original<typeof import("node:child_process")>();
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async (_command: string, args: string[]) => {
      azure.calls.push(args);
      const answer = azure.answer(args);
      if (answer instanceof Error) throw answer;
      return { stdout: answer === null ? "" : JSON.stringify(answer), stderr: "" };
    },
  });
  return { ...real, execFile };
});

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
  healthPath: "/healthz",
  dockerfile: ".platform/Dockerfile",
});

const target = { app: "notes-tool", group: "rg-notes-tool" };
const fqdn = "notes-tool.lemon-1.australiaeast.azurecontainerapps.io";
const OLD = "notes-tool--old";
const NEW = "notes-tool--new";

const app = (traffic: TrafficEntry[]) => ({
  properties: {
    latestReadyRevisionName: NEW,
    configuration: { ingress: { fqdn, traffic } },
  },
});
const on = (revision: string, others: TrafficEntry[] = []) => [
  { revisionName: revision, weight: 100 },
  ...others,
];

/** Azure, answering each read of the app with the next state, then repeating the last. */
function fakeAzure(states: TrafficEntry[][]) {
  let read = 0;
  azure.answer = (args) => {
    const line = args.join(" ");
    if (line.startsWith("containerapp show")) {
      const state = states[Math.min(read, states.length - 1)] as TrafficEntry[];
      read += 1;
      return app(state);
    }
    if (line.startsWith("containerapp revision show")) {
      return { health: "Healthy", provisioning: "Provisioned", running: "Running" };
    }
    return null;
  };
}

const trafficMoves = () =>
  azure.calls
    .filter((args) => args.join(" ").startsWith("containerapp ingress traffic set"))
    .map((args) => args[args.indexOf("--revision-weight") + 1]);

let answerStatus = 200;
beforeEach(() => {
  vi.stubEnv("GITHUB_ACTIONS", "false"); // the release check calls GitHub only in Actions
  azure.calls.length = 0;
  answerStatus = 200;
  timing.retry = 0;
  timing.trafficCheck = 0;
  timing.busyWait = 1_000;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: answerStatus })),
  );
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("a rollback has its own queue, and everything else keeps the shared one", () => {
  const workflow = readFileSync("platform/files/platform.yml", "utf8");
  expect(workflow).toContain(
    "group: platform-${{ github.ref }}${{ inputs.action == 'rollback' && '-rollback' || '' }}",
  );
  expect(workflow).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
});

describe("staging can't undo a rollback", () => {
  test("it leaves traffic that's already pinned alone", async () => {
    fakeAzure([on(OLD)]);
    await deployStaging(target, manifest, "acr.azurecr.io/notes-tool:abc", "abc1234", "1");
    expect(trafficMoves()).toEqual([]);
  });

  test("it still pins traffic that follows the newest revision", async () => {
    fakeAzure([[{ latestRevision: true, weight: 100 }]]);
    await deployStaging(target, manifest, "acr.azurecr.io/notes-tool:abc", "abc1234", "1");
    expect(trafficMoves()).toEqual([`${NEW}=100`]);
  });

  test("traffic follows the newest revision only when no revision is pinned", () => {
    const state = { fqdn, latestReady: NEW };
    expect(followsLatest({ ...state, traffic: [] })).toBe(true);
    expect(followsLatest({ ...state, traffic: [{ latestRevision: true, weight: 100 }] })).toBe(
      true,
    );
    expect(followsLatest({ ...state, traffic: on(OLD) })).toBe(false);
  });
});

describe("promote can't overwrite a rollback", () => {
  test("it stops if traffic moved while it was running", async () => {
    fakeAzure([on(OLD), on("notes-tool--rolled-back")]);
    await expect(promote(target, manifest, NEW)).rejects.toThrow("moved");
    expect(trafficMoves()).toEqual([]);
  });

  test("it moves traffic when nothing else has", async () => {
    fakeAzure([on(OLD)]);
    await promote(target, manifest, NEW);
    expect(trafficMoves()).toEqual([`${NEW}=100`]);
  });

  test("a failed release goes back to what was live", async () => {
    answerStatus = 500;
    fakeAzure([on(OLD), on(OLD), on(NEW)]);
    await expect(promote(target, manifest, NEW)).rejects.toThrow();
    expect(trafficMoves()).toEqual([`${NEW}=100`, `${OLD}=100`]);
  });

  test("a failed release leaves a rollback that happened meanwhile", async () => {
    answerStatus = 500;
    fakeAzure([on(OLD), on(OLD), on("notes-tool--rolled-back")]);
    await expect(promote(target, manifest, NEW)).rejects.toThrow();
    expect(trafficMoves()).toEqual([`${NEW}=100`]);
  });
});

describe("a rollback sticks", () => {
  const live = on(NEW, [{ revisionName: OLD, weight: 0, label: "previous" }]);
  const back = on(OLD, [{ revisionName: NEW, weight: 0 }]);

  test("it moves traffic once when nothing interferes", async () => {
    fakeAzure([live, back]);
    await rollback(target, manifest);
    expect(trafficMoves()).toEqual([`${OLD}=100`]);
  });

  const refuse = (message: string, times: number) => {
    const inner = azure.answer;
    let left = times;
    azure.answer = (args) => {
      if (args.join(" ").startsWith("containerapp ingress traffic set") && left > 0) {
        left -= 1;
        azure.calls.pop();
        return Object.assign(new Error("az failed"), { stderr: message });
      }
      return inner(args);
    };
  };

  test("it waits for an update Azure is still provisioning", async () => {
    fakeAzure([live, back]);
    refuse("ERROR: (ContainerAppOperationInProgress) Cannot modify a container app", 2);
    await rollback(target, manifest);
    expect(trafficMoves()).toEqual([`${OLD}=100`]);
  });

  test("any other Azure error still stops it", async () => {
    fakeAzure([live, back]);
    refuse("ERROR: (AuthorizationFailed) not allowed", 1);
    await expect(rollback(target, manifest)).rejects.toThrow("az failed");
    expect(trafficMoves()).toEqual([]);
  });

  test("it puts traffic back if a deploy overwrites it", async () => {
    fakeAzure([live, live, back]);
    await rollback(target, manifest);
    expect(trafficMoves()).toEqual([`${OLD}=100`, `${OLD}=100`]);
  });
});
