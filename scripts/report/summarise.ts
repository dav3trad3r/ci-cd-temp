// The agent step: Claude, through your Microsoft Foundry resource, turns the facts into a
// short report for people who aren't engineers. If it isn't set up, fails or declines, the
// caller sends the plain report instead, so the report always goes out and is always right.
import { AnthropicFoundry } from "@anthropic-ai/foundry-sdk";
import { az } from "./collect.js";
import type { ReportConfig } from "./model.js";
import type { Prompt } from "./render.js";

/** The key comes from the environment (a GitHub secret) or, better, the tool's Key Vault. */
async function foundryKey(foundry: ReportConfig["foundry"]): Promise<string | undefined> {
  if (process.env.ANTHROPIC_FOUNDRY_API_KEY) return process.env.ANTHROPIC_FOUNDRY_API_KEY;
  if (!foundry.keyVault) return undefined;
  const value = await az([
    "keyvault",
    "secret",
    "show",
    "--vault-name",
    foundry.keyVault,
    "--name",
    foundry.secretName ?? "foundry-api-key",
    "--query",
    "value",
  ]);
  return typeof value === "string" ? value : undefined;
}

/** No key at all: the workflow's own Entra identity, signed in through OIDC. */
async function entraToken(): Promise<string> {
  const token = await az([
    "account",
    "get-access-token",
    "--scope",
    "https://ai.azure.com/.default",
    "--query",
    "accessToken",
  ]);
  if (typeof token !== "string") throw new Error("no Entra token from the Azure CLI");
  return token;
}

/** Returns the agent's report, or null when the agent isn't set up or declines. */
export async function summarise(
  prompt: Prompt,
  foundry: ReportConfig["foundry"],
): Promise<string | null> {
  const resource = foundry.resource || process.env.ANTHROPIC_FOUNDRY_RESOURCE;
  if (!resource) return null;

  const client =
    foundry.auth === "entra"
      ? new AnthropicFoundry({ resource, azureADTokenProvider: entraToken })
      : new AnthropicFoundry({ resource, apiKey: await foundryKey(foundry) });

  const message = await client.messages.create({
    model: foundry.model,
    max_tokens: 16000,
    system: prompt.system,
    messages: [{ role: "user", content: prompt.user }],
  });

  if (message.stop_reason === "refusal") return null;
  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") parts.push(block.text);
  }
  const text = parts.join("\n").trim();
  return text || null;
}
