// The SRE agent's incident runner. Starts a Claude Managed Agents session for one alert, answers
// the agent's custom tool calls (read-only Azure and GitHub reads, status updates, the post-mortem
// and the fix proposal), and saves what happened in sre-output/.
//   npm run sre:demo                                    the demo incident on the sre-demo branch
//   npm run sre -- --tool demo-tool --alert <alert id>  a real Azure Monitor alert
// Flags: --no-fix (diagnose only).
import { toFile } from "@anthropic-ai/sdk";
import {
  appendFileSync,
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFix } from "./apply-fix.js";
import { anthropicClient, errorLine, git, loadConfig, loadLock, type SreTool } from "./config.js";
import { validateProposal } from "./fix.js";
import { azureRead, clock, demoRead, type DemoIncident } from "./tools.js";

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const demo = args.includes("--demo");
const diagnoseOnly = args.includes("--no-fix");

const config = loadConfig();
const lock = loadLock();
if (!lock.agentId || !lock.environmentId || !lock.teamMemoryId || !lock.notebookMemoryId) {
  throw new Error("The SRE agent isn't set up yet: run npm run sre:setup first.");
}

// ── Which incident ──────────────────────────────────────────────────────────────

const incident: DemoIncident | undefined = demo
  ? (JSON.parse(readFileSync("sre/demo/incident.json", "utf8")) as DemoIncident)
  : undefined;
const toolName = incident?.tool ?? flag("--tool");
const tool: SreTool | undefined = config.tools.find((t) => t.name === toolName);
if (!tool) throw new Error(`No tool named "${toolName}" in ops/sre-agent.json.`);
const alertId = flag("--alert") ?? "";
if (!demo && !alertId) throw new Error("Give the alert: --alert <alert id or name>.");

const baseBranch = incident?.baseBranch ?? tool.baseBranch;
const firedAt = demo
  ? new Date(Date.now() - 2 * 60_000)
  : new Date(flag("--fired-at") ?? Date.now());
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const incidentId = incident?.id ?? `INC-${stamp.slice(0, 10)}-${tool.name}`;
const outDir = join("sre-output", `${incidentId}-${stamp}`);
mkdirSync(outDir, { recursive: true });

const client = anthropicClient();
const transcript: string[] = [];
const log = (line: string) => {
  transcript.push(line);
  appendFileSync(join(outDir, "transcript.md"), `${line}\n\n`);
};

// ── The code the agent works on: a snapshot of the deployed branch ──────────────

git(["fetch", "--quiet", "origin", baseBranch]);
const tarDir = mkdtempSync(join(tmpdir(), "sre-snapshot-"));
const tarPath = join(tarDir, "repo.tar.gz");
git(["archive", "--format=tar.gz", "-o", tarPath, `origin/${baseBranch}`]);
const uploaded = await client.files.upload({
  file: await toFile(createReadStream(tarPath), "repo.tar.gz", { type: "application/gzip" }),
});
rmSync(tarDir, { recursive: true, force: true });

const alertName = incident?.alert.name ?? alertId;
const session = await client.beta.sessions.create({
  agent: { type: "agent", id: lock.agentId, version: lock.agentVersion as number },
  environment_id: lock.environmentId,
  title: `${incidentId}: ${alertName}`,
  resources: [
    { type: "file", file_id: uploaded.id, mount_path: "/workspace/repo.tar.gz" },
    {
      type: "memory_store",
      memory_store_id: lock.teamMemoryId,
      access: "read_only",
      instructions: "The platform team's shared knowledge. Read it before you investigate.",
    },
    {
      type: "memory_store",
      memory_store_id: lock.notebookMemoryId,
      access: "read_write",
      instructions:
        "Your own notebook from earlier incidents. Read it first; add a short note at the end.",
    },
  ],
  budget: {
    type: "limit",
    max_list_cost: { amount: String(Math.round(config.budgetUsd * 100)), currency: "USD" },
  },
});
const sessionUrl = `https://platform.claude.com/workspaces/default/sessions/${session.id}`;
console.log(`Incident ${incidentId} on ${tool.name}. Session: ${sessionUrl}`);
log(
  `# ${incidentId}: ${alertName}\n\nTool: ${tool.name} · deployed branch: ${baseBranch} · session: ${sessionUrl}`,
);

// ── Custom tools: run here, with this process's credentials ─────────────────────

const updates: string[] = [];
let postmortem = "";
let fixAttempts = 0;
let fixOutcome = "";

async function postToTeams(text: string) {
  const webhook = process.env.TEAMS_WEBHOOK_URL;
  if (!webhook) return;
  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        contentUrl: null,
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          body: [
            {
              type: "TextBlock",
              text: `${incidentId} · ${tool?.name}`,
              weight: "Bolder",
              wrap: true,
            },
            { type: "TextBlock", text, wrap: true },
          ],
        },
      },
    ],
  };
  await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(card),
  }).catch(() => undefined);
}

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  if (name === "post_update") {
    const text = String(input.text ?? "").slice(0, 2000);
    updates.push(`${clock(new Date())} ${text}`);
    console.log(`\n[update] ${text}\n`);
    await postToTeams(text);
    return "Posted to the incident channel.";
  }

  if (name === "record_postmortem") {
    postmortem = String(input.markdown ?? "");
    writeFileSync(join(outDir, "postmortem.md"), postmortem);
    return "Saved the post-mortem.";
  }

  if (name === "propose_fix") {
    if (diagnoseOnly)
      return "Not in this run: it's diagnosis only. Post your diagnosis and the fix you'd make instead.";
    if (fixAttempts >= 3)
      return "Refused: three attempts already. Post what a person should do instead.";
    fixAttempts += 1;
    const { proposal, problems } = validateProposal(input);
    if (!proposal) return `Refused before applying:\n- ${problems.join("\n- ")}`;
    console.log(
      `\n[fix] attempt ${fixAttempts}: ${proposal.kind}, "${proposal.title}". Applying and checking...`,
    );
    const result = await applyFix(proposal, {
      repo: tool!.repo,
      baseBranch,
      incidentId,
      tool: tool!.name,
      author: config.commitAuthor,
      reviewer: tool!.githubReviewer || undefined,
      sessionUrl,
      outDir,
    });
    const passed = result.checks.length ? `\nPassed:\n- ${result.checks.join("\n- ")}` : "";
    if (!result.ok) {
      fixOutcome = `proposed but not opened: ${result.problems[0]?.split("\n")[0]}`;
      console.log(`[fix] refused: ${result.problems[0]?.split("\n")[0]}`);
      return `Refused:\n- ${result.problems.join("\n- ")}${passed}`;
    }
    fixOutcome = result.prUrl
      ? `Draft pull request: ${result.prUrl}`
      : `Branch ${result.branch} pushed with every check passing; pull request drafted in ${result.prDraftFile}`;
    console.log(`[fix] ${fixOutcome}`);
    return result.prUrl
      ? `Draft pull request opened for review: ${result.prUrl}${passed}`
      : `Every check passed and branch ${result.branch} is pushed. This machine has no GitHub token, so the draft pull request is saved for a person to open.${passed}`;
  }

  return demo && incident
    ? demoRead(name, input, incident, firedAt)
    : azureRead(name, input, tool!, alertId, firedAt);
}

// ── The event loop: stream-first, lossless reconnect, stop on a final idle ──────

const seen = new Set<string>();
const answered = new Set<string>();
let finalText = "";
let usage = "";
let stopReason = "";

type Event = { id: string; type: string } & Record<string, unknown>;

async function handle(event: Event) {
  if (event.type === "agent.message") {
    const blocks = (event.content as { type: string; text?: string }[]) ?? [];
    const text = blocks.map((b) => (b.type === "text" ? (b.text ?? "") : "")).join("");
    if (text.trim()) {
      finalText = text;
      process.stdout.write(`${text}\n`);
      log(text);
    }
  } else if (event.type === "user.custom_tool_result") {
    answered.add(String(event.custom_tool_use_id));
  } else if (event.type === "agent.custom_tool_use" && !answered.has(event.id)) {
    const name = String(event.name);
    const input = (event.input as Record<string, unknown>) ?? {};
    console.log(
      `-> ${name}${name === "propose_fix" ? "" : ` ${JSON.stringify(input).slice(0, 120)}`}`,
    );
    let result: string;
    try {
      result = await runTool(name, input);
    } catch (error) {
      result = `The tool failed: ${errorLine(error)}`;
    }
    log(
      `**${name}** ${name === "propose_fix" ? `(${String(input.kind)}: ${String(input.title)})` : JSON.stringify(input).slice(0, 300)}\n\n\`\`\`\n${result.slice(0, 1500)}\n\`\`\``,
    );
    answered.add(event.id);
    await client.beta.sessions.events.send(session.id, {
      events: [
        {
          type: "user.custom_tool_result",
          custom_tool_use_id: event.id,
          content: [{ type: "text", text: result }],
        },
      ],
    });
  } else if (event.type === "agent.tool_use") {
    console.log(`   (workspace) ${String(event.name)}`);
  } else if (event.type === "session.usage") {
    usage = JSON.stringify(event).slice(0, 600);
  } else if (event.type === "session.error") {
    console.error(`Session error: ${JSON.stringify(event).slice(0, 300)}`);
  }
}

const isFinal = (event: Event) => {
  if (event.type === "session.status_terminated") return true;
  if (event.type !== "session.status_idle") return false;
  const reason = (event.stop_reason as { type?: string } | undefined)?.type ?? "";
  if (reason === "requires_action") return false;
  stopReason = reason;
  return true;
};

const kickoff = [
  `Alert on ${tool.name}: "${alertName}" fired at ${clock(firedAt)} AEST. This is incident ${incidentId}.`,
  `The deployed code is the ${baseBranch} branch of ${tool.repo}; its snapshot is at /mnt/session/uploads/workspace/repo.tar.gz.`,
  diagnoseOnly
    ? "This run is diagnosis only: don't propose a fix."
    : "Investigate, keep people updated, and propose a fix if the evidence supports one.",
].join(" ");

const deadline = Date.now() + config.timeoutMinutes * 60_000;
let started = false;
let finished = false;
while (!finished) {
  try {
    const stream = await client.beta.sessions.events.stream(session.id);
    if (!started) {
      started = true;
      await client.beta.sessions.events.send(session.id, {
        events: [{ type: "user.message", content: [{ type: "text", text: kickoff }] }],
      });
    } else {
      // Reconnected: catch up from the full history before reading the live stream again.
      const history: Event[] = [];
      for await (const e of client.beta.sessions.events.list(session.id))
        history.push(e as unknown as Event);
      for (const e of history)
        if (e.type === "user.custom_tool_result") answered.add(String(e.custom_tool_use_id));
      for (const e of history) {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          await handle(e);
        }
        if (isFinal(e)) finished = true;
      }
      if (finished) break;
    }
    for await (const raw of stream) {
      const event = raw as unknown as Event;
      if (!seen.has(event.id)) {
        seen.add(event.id);
        await handle(event);
      }
      if (isFinal(event)) {
        finished = true;
        break;
      }
      if (Date.now() > deadline) {
        await client.beta.sessions.events.send(session.id, {
          events: [{ type: "user.interrupt" }],
        });
        stopReason = "timed out";
        finished = true;
        break;
      }
    }
  } catch (error) {
    if (Date.now() > deadline) throw error;
    console.error(`The event stream dropped (${errorLine(error)}); reconnecting.`);
  }
}

await client.files.delete(uploaded.id).catch(() => undefined);

// ── What happened ───────────────────────────────────────────────────────────────

const summary = [
  `## ${incidentId}: ${alertName}`,
  "",
  `**Tool:** ${tool.name} · **Stopped:** ${stopReason || "end of session"} · **Session:** ${sessionUrl}`,
  "",
  `**Fix:** ${fixOutcome || "none proposed"}`,
  "",
  "**Updates posted:**",
  ...(updates.length ? updates.map((u) => `- ${u}`) : ["- none"]),
  "",
  "**Agent's closing summary:**",
  "",
  finalText || "(none)",
  "",
  postmortem ? "<details><summary>Post-mortem</summary>\n\n" + postmortem + "\n\n</details>" : "",
  "",
].join("\n");
writeFileSync(join(outDir, "summary.md"), summary);
if (usage) writeFileSync(join(outDir, "usage.json"), `${usage}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
console.log(
  `\nDone: ${stopReason || "session ended"}. ${fixOutcome || "No fix proposed."}\nSaved in ${outDir}.`,
);
