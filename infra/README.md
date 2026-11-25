# Azure infrastructure

Templates that put a tool on Azure the standard way, written in [Bicep](https://learn.microsoft.com/azure/azure-resource-manager/bicep/overview) (Azure's template language, which compiles to ARM templates). The infrastructure lives in code, is reviewed in pull requests and is previewed before it changes anything. Nobody sets up a tool by clicking through the portal.

| File                       | Deployed                                   | What it creates                                                                                                                                                                                                                           |
| -------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform.bicep`           | Once per environment, by the platform team | A Log Analytics workspace for every tool's logs, a Container Apps environment (Consumption, billed only while apps run), a container registry with its admin password switched off, and an action group that emails the platform team.    |
| `tool.bicep`               | Once per tool                              | The tool's container app with Entra sign-in and scale to zero, its own managed identity and Key Vault, secrets passed in as environment variables, a 5xx alert to the platform team, and owner, cost-centre and data-classification tags. |
| `tools/example.bicepparam` | Copy one per tool                          | The inputs for one tool: name, owner, cost centre, data classification, image and secrets.                                                                                                                                                |
| `modules/acr-pull.bicep`   | By `tool.bicep`                            | Lets the tool's identity pull images from the registry, with no password.                                                                                                                                                                 |

CI lints and compiles every template on each pull request (`npm run check:infra`).

## What every tool gets

- **Sign-in:** Entra ID sits in front of the app, so only people in your organisation's tenant can open it, with your MFA and Conditional Access rules. The app needs no sign-in code. It receives the person's identity in the `X-MS-CLIENT-PRINCIPAL-NAME` header. To limit a tool to certain people, set **Assignment required** on its enterprise application in Entra and assign groups.
- **No passwords in configuration:** the tool's own identity pulls its image and reads its secrets. Each tool has its own Key Vault, so one tool can never read another tool's secrets.
- **Cost control:** it scales to zero when unused and starts on the smallest size (0.25 CPU, 0.5 GiB). Raise the size only when the metrics show a need.
- **Visibility:** logs go to the shared workspace, server errors alert the platform team, and the tags show who owns the tool, who pays for it and how sensitive its data is.

## Put a tool on Azure

1. **Platform, once:** fill in `platform.bicepparam` and deploy `platform.bicep` into the platform resource group. Its outputs are the IDs the tools need.
2. **A resource group per tool,** tagged from the start:
   ```bash
   az group create -n rg-leasing-assistant -l australiaeast --tags owner=jane@example.com cost-centre=PM-OPS data-classification=Confidential
   ```
3. **An Entra app registration for sign-in.** The address is predictable (`<tool>.<platform defaultDomain>`), so create it first:
   ```bash
   az ad app create --display-name "leasing-assistant" --sign-in-audience AzureADMyOrg \
     --web-redirect-uris https://leasing-assistant.<defaultDomain>/.auth/login/aad/callback \
     --enable-id-token-issuance true
   az ad sp create --id <appId>
   ```
4. **A parameter file:** copy `tools/example.bicepparam` to `tools/leasing-assistant.bicepparam` and fill it in. For the first deploy, keep the default quickstart image and leave `secrets` empty.
5. **Preview, then deploy:**
   ```bash
   az deployment group what-if -g rg-leasing-assistant -f infra/tool.bicep -p infra/tools/leasing-assistant.bicepparam
   az deployment group create  -g rg-leasing-assistant -f infra/tool.bicep -p infra/tools/leasing-assistant.bicepparam
   ```
6. **Secrets:** add each secret to the tool's Key Vault (the `keyVaultName` output), list it under `secrets`, and deploy again.
7. **Real image:** the deploy pipeline builds the image, pushes it to the registry tagged with the commit, and runs step 5 with `image=<registry>.azurecr.io/<tool>:<commit>`. Infrastructure and app then never drift apart.

## Good to know

- **Database changes run as a job.** Set `migrateCommand` and the template adds a manual Container Apps job with the app's image, identity and secrets. The deploy pipeline runs it after approval and before traffic moves, and stops the release if the job is missing or runs a different command from the tool's manifest.
- **Registries have two permission modes.** Newer registries default to per-repository permissions (ABAC), where the classic AcrPull role does nothing and pulling needs Container Registry Repository Reader. `modules/acr-pull.bicep` reads the registry's mode and assigns the right role. In ABAC mode you can go further and limit each tool to its own repository with a role-assignment condition.
- **The first deploy with a private image can fail with `UNAUTHORIZED`** while a brand-new identity's permission spreads. Start with the public quickstart image (step 4), or run the deploy again a few minutes later.
- **Free trial subscriptions allow only one Container Apps environment,** so `platform.bicep` needs a pay-as-you-go or company subscription.
- **Data classification is a label, not a control.** For Confidential or Restricted data, also decide on private networking (a virtual network and private endpoints), log retention, and who can read the logs.
- **Purge protection is on by default** for each tool's Key Vault, so a deleted vault can be recovered for 90 days. Once on, it can't be turned off; pass `keyVaultPurgeProtection=false` only in a sandbox.
- **Enforce the tags across the whole subscription** with Azure Policy's built-in "Require a tag on resources". The templates set the tags, and the policy catches anything created by hand.
- **The deploy pipeline should sign in with OIDC** (no stored secret), using an identity that can only deploy to the tool's own resource group.
