// The deploy stage, on Azure Container Apps (actions/deploy). The image is built once, then:
//   image     build it, tagged with the commit, and push it to the registry
//   staging   start it as a new revision with no production traffic, and test it
//   promote   after a Pipeline approver's OK, move production traffic, and put it back if it fails
//   rollback  move production traffic to the revision that was live before
// The previous revision keeps running, so going back takes seconds and needs no rebuild.
import { execFile } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { safeEnv } from "./env.js";
import { loadManifest, type Manifest } from "./model.js";

const exec = promisify(execFile);

export interface TrafficEntry {
  revisionName?: string;
  weight?: number;
  label?: string;
  latestRevision?: boolean;
}

export interface AppState {
  fqdn: string;
  latestReady: string;
  traffic: TrafficEntry[];
}

/** Revision suffixes must start with a letter. The attempt makes a re-run safe. */
export function revisionSuffix(sha: string, attempt: string | number = 1): string {
  return `r${sha.slice(0, 7).toLowerCase()}-${attempt}`;
}

/** Container Apps gives each labelled revision its own address: app---label.rest-of-domain. */
export function labelUrl(fqdn: string, label: string): string {
  const [host, ...rest] = fqdn.split(".");
  return `https://${host}---${label}.${rest.join(".")}`;
}

/** The revision serving production now. */
export function liveRevision(state: AppState): string | undefined {
  const serving = state.traffic.filter((t) => (t.weight ?? 0) > 0);
  const top = serving.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0];
  if (!top) return state.latestReady || undefined;
  return top.latestRevision ? state.latestReady : top.revisionName;
}

export function labelledRevision(state: AppState, label: string): string | undefined {
  return state.traffic.find((t) => t.label === label)?.revisionName;
}

/** Tools sit behind sign-in, so a redirect or 401 still proves the revision is answering. The
 *  revision's own health probe, which bypasses sign-in, is what proves the app is well. */
export const answering = (status: number) => status >= 200 && status < 500;

interface Target {
  app: string;
  group: string;
}

async function az(args: string[]): Promise<unknown> {
  const { stdout } = await exec("az", [...args, "--only-show-errors", "--output", "json"], {
    maxBuffer: 16 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  return stdout.trim() ? JSON.parse(stdout) : null;
}

async function readApp({ app, group }: Target): Promise<AppState> {
  const result = (await az([
    "containerapp",
    "show",
    "--name",
    app,
    "--resource-group",
    group,
  ]).catch(() => null)) as {
    properties?: {
      latestReadyRevisionName?: string;
      configuration?: { ingress?: { fqdn?: string; traffic?: TrafficEntry[] } };
    };
  } | null;
  const ingress = result?.properties?.configuration?.ingress;
  if (!ingress?.fqdn) {
    throw new Error(
      `${app} isn't provisioned in ${group}. Deploy its Bicep parameters file first (README, "Connect a tool to Azure").`,
    );
  }
  return {
    fqdn: ingress.fqdn,
    latestReady: result?.properties?.latestReadyRevisionName ?? "",
    traffic: ingress.traffic ?? [],
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntilAnswering(url: string, tries = 40): Promise<number> {
  let last = 0;
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
      });
      last = response.status;
      if (answering(last)) return last;
    } catch {
      last = 0;
    }
    await sleep(5_000);
  }
  throw new Error(`${url} never answered properly (last status ${last || "no response"}).`);
}

/** A revision that isn't healthy within this time is treated as broken. */
const HEALTH_DEADLINE = 4 * 60_000;

/** True once healthy, false while starting, and an error once it's clearly failed. */
export function revisionVerdict(state: {
  health?: string;
  provisioning?: string;
  running?: string;
}): boolean {
  if (state.provisioning === "Failed" || state.running === "Failed") {
    throw new Error("the revision failed to start.");
  }
  return state.health === "Healthy";
}

async function waitUntilHealthy({ app, group }: Target, revision: string, url: string) {
  const deadline = Date.now() + HEALTH_DEADLINE;
  while (Date.now() < deadline) {
    const state = (await az([
      "containerapp",
      "revision",
      "show",
      "--name",
      app,
      "--resource-group",
      group,
      "--revision",
      revision,
      "--query",
      "{health:properties.healthState,provisioning:properties.provisioningState,running:properties.runningState}",
    ])) as { health?: string; provisioning?: string; running?: string };
    if (revisionVerdict(state)) return;
    // A revision scaled to zero only starts when something calls it.
    await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) }).catch(
      () => undefined,
    );
    await sleep(5_000);
  }
  throw new Error(`${revision} wasn't healthy within ${HEALTH_DEADLINE / 60_000} minutes.`);
}

const setTraffic = ({ app, group }: Target, revision: string) =>
  az([
    "containerapp",
    "ingress",
    "traffic",
    "set",
    "--name",
    app,
    "--resource-group",
    group,
    "--revision-weight",
    `${revision}=100`,
  ]);

const setLabel = ({ app, group }: Target, label: string, revision: string) =>
  az([
    "containerapp",
    "revision",
    "label",
    "add",
    "--name",
    app,
    "--resource-group",
    group,
    "--label",
    label,
    "--revision",
    revision,
    "--no-prompt",
    "--yes",
  ]);

async function buildImage(manifest: Manifest, registry: string, sha: string): Promise<string> {
  if (!manifest.dockerfile) throw new Error(`${manifest.name} has no Dockerfile to build.`);
  if (!registry) throw new Error("Set the AZURE_REGISTRY variable to the registry's name.");
  const image = `${registry}.azurecr.io/${manifest.name}:${sha}`;
  await az(["acr", "login", "--name", registry]);
  // The build runs the tool's own install scripts, so it gets no pipeline credentials.
  await exec("docker", ["build", "--file", manifest.dockerfile, "--tag", image, "."], {
    env: { ...safeEnv(), DOCKER_BUILDKIT: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  await exec("docker", ["push", image], { maxBuffer: 16 * 1024 * 1024 });
  return image;
}

async function deployStaging(
  target: Target,
  manifest: Manifest,
  image: string,
  sha: string,
  attempt: string,
): Promise<string> {
  const before = await readApp(target);
  const live = liveRevision(before);
  await az([
    "containerapp",
    "revision",
    "set-mode",
    "--name",
    target.app,
    "--resource-group",
    target.group,
    "--mode",
    "multiple",
  ]);
  // Pin production to what's live now, so the new revision starts with no traffic.
  if (live) await setTraffic(target, live);

  const suffix = revisionSuffix(sha, attempt);
  const revision = `${target.app}--${suffix}`;
  await az([
    "containerapp",
    "update",
    "--name",
    target.app,
    "--resource-group",
    target.group,
    "--image",
    image,
    "--revision-suffix",
    suffix,
  ]);
  try {
    await setLabel(target, "staging", revision);
    const url = `${labelUrl(before.fqdn, "staging")}${manifest.healthPath}`;
    await waitUntilHealthy(target, revision, url);
    const status = await waitUntilAnswering(url);
    console.log(
      `Staging: ${revision} is healthy and answered ${status}. Live traffic hasn't moved.`,
    );
    return revision;
  } catch (error) {
    await az([
      "containerapp",
      "revision",
      "deactivate",
      "--name",
      target.app,
      "--resource-group",
      target.group,
      "--revision",
      revision,
    ]).catch(() => undefined);
    console.error(
      `${revision} was switched off and live traffic hasn't moved. Any migration it ran at startup is still in the database.`,
    );
    throw error;
  }
}

/** Pipeline approvers hold the Maintain role on each tool. Everyone else has Write at most. */
export const canRelease = (role: string | undefined) => role === "admin" || role === "maintain";

export function hasRequiredReviewers(environment: unknown): boolean {
  const rules = (environment as { protection_rules?: { type?: string }[] } | null)
    ?.protection_rules;
  return (rules ?? []).some((rule) => rule.type === "required_reviewers");
}

/** Live traffic never moves without a person, on any GitHub plan, and if this can't be proved
 *  the release stops. Required reviewers on a private repository need GitHub Enterprise: without
 *  them an environment would simply run, so that setting is checked rather than trusted. */
async function assertReleaseAllowed() {
  if (process.env.GITHUB_ACTIONS !== "true") return;
  const repo = process.env.GITHUB_REPOSITORY ?? "";
  const token = process.env.DEPLOY_GITHUB_TOKEN ?? "";
  const ask = async (path: string) => {
    const api = process.env.GITHUB_API_URL || "https://api.github.com";
    const response = await fetch(`${api}/repos/${repo}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "ci-cd-temp-platform",
      },
    });
    if (!response.ok)
      throw new Error(`Can't confirm the approval: GitHub answered ${response.status}.`);
    return response.json() as Promise<unknown>;
  };

  if (process.env.PRODUCTION_GATE === "environment") {
    if (!hasRequiredReviewers(await ask("/environments/production"))) {
      throw new Error(
        'PRODUCTION_GATE is "environment", but the production environment has no required reviewers. Add them (GitHub Enterprise), or remove the variable and promote by hand.',
      );
    }
    return;
  }
  const actor = process.env.GITHUB_TRIGGERING_ACTOR || process.env.GITHUB_ACTOR || "";
  const { role_name: role } = (await ask(
    `/collaborators/${encodeURIComponent(actor)}/permission`,
  )) as { role_name?: string };
  if (!canRelease(role)) {
    throw new Error(`${actor} isn't a Pipeline approver on this tool, so this was stopped.`);
  }
  console.log(`Approved by ${actor}.`);
}

async function promote(target: Target, manifest: Manifest, wanted: string) {
  await assertReleaseAllowed();
  const before = await readApp(target);
  // Promoted by hand, it's whatever is on the staging address now.
  const revision = wanted || labelledRevision(before, "staging");
  if (!revision) throw new Error("No revision to promote.");
  const previous = liveRevision(before);
  if (previous === revision) {
    console.log(`${revision} is already live.`);
    return;
  }
  if (previous) await setLabel(target, "previous", previous);
  await setTraffic(target, revision);
  try {
    const status = await waitUntilAnswering(`https://${before.fqdn}${manifest.healthPath}`, 12);
    console.log(`Production: ${revision} is live and answered ${status}.`);
  } catch (error) {
    if (previous) {
      await setTraffic(target, previous);
      console.error(`Production didn't answer, so traffic went back to ${previous}.`);
    }
    throw error;
  }
}

async function rollback(target: Target, manifest: Manifest) {
  await assertReleaseAllowed();
  const state = await readApp(target);
  const previous = labelledRevision(state, "previous");
  if (!previous) throw new Error("There's no previous revision to go back to.");
  const current = liveRevision(state);
  await setTraffic(target, previous);
  if (current && current !== previous) await setLabel(target, "previous", current);
  const status = await waitUntilAnswering(`https://${state.fqdn}${manifest.healthPath}`, 12);
  console.log(`Rolled back to ${previous}, which answered ${status}.`);
}

async function main() {
  const mode = process.argv[2];
  const manifest = loadManifest(resolve(process.env.PLATFORM_TOOL_PATH || "."));
  const target: Target = {
    app: process.env.AZURE_CONTAINER_APP || manifest.name,
    group: process.env.AZURE_RESOURCE_GROUP || `rg-${manifest.name}`,
  };
  const sha = process.env.GITHUB_SHA ?? "";
  const attempt = process.env.GITHUB_RUN_ATTEMPT ?? "1";
  const output = (key: string, value: string) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
    console.log(`${key}: ${value}`);
  };

  if (mode === "image") {
    output("image", await buildImage(manifest, process.env.DEPLOY_REGISTRY ?? "", sha));
  } else if (mode === "staging") {
    const image = process.env.DEPLOY_IMAGE ?? "";
    if (!image) throw new Error("No image to deploy.");
    output("revision", await deployStaging(target, manifest, image, sha, attempt));
  } else if (mode === "promote") {
    await promote(target, manifest, process.env.DEPLOY_REVISION ?? "");
  } else if (mode === "rollback") {
    await rollback(target, manifest);
  } else {
    throw new Error("Choose a mode: image, staging, promote or rollback.");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const message = (error as { stderr?: string }).stderr || (error as Error).message;
    console.error(String(message).trim().split("\n").slice(-6).join("\n"));
    process.exit(1);
  });
}
