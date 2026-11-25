// One internal tool on Azure Container Apps, set up the standard way:
// - Entra sign-in: only people in your organisation's tenant can open it
// - its own managed identity, which pulls the image and reads secrets with no passwords
// - its own Key Vault, with secrets passed to the app as environment variables
// - scale to zero when nobody is using it
// - logs in the shared Log Analytics workspace, and a 5xx alert to the platform team
// - owner, cost-centre and data-classification tags on every resource
//
// Deploy into the tool's own resource group (preview first with `what-if`):
//   az deployment group what-if  -g rg-<tool> -f infra/tool.bicep -p infra/tools/<tool>.bicepparam
//   az deployment group create   -g rg-<tool> -f infra/tool.bicep -p infra/tools/<tool>.bicepparam

targetScope = 'resourceGroup'

// ── About the tool ──────────────────────────────────────────────────────────────

@description('Tool name: lowercase letters, numbers and hyphens. It becomes the app name and part of its web address.')
@minLength(2)
@maxLength(32)
param name string

@description('Email of the person accountable for the tool.')
param owner string

@description('Cost centre the tool is charged to.')
param costCentre string

@description('The most sensitive data the tool handles.')
@allowed([
  'Public'
  'Internal'
  'Confidential'
  'Restricted'
])
param dataClassification string

param location string = resourceGroup().location

// ── The shared platform (outputs of platform.bicep) ─────────────────────────────

@description('Resource ID of the shared Container Apps environment.')
param environmentId string

@description('Workload profile in the environment. Consumption bills only while the app runs.')
param workloadProfileName string = 'Consumption'

@description('Resource ID of the platform team action group, which receives this tool\'s alerts.')
param actionGroupId string

// ── The container ───────────────────────────────────────────────────────────────

@description('Container image. The quickstart image works for a first deploy; the deploy pipeline passes the real image tagged with the commit.')
param image string = 'mcr.microsoft.com/k8se/quickstart:latest'

@description('Port the app listens on inside the container.')
param targetPort int = 80

@description('Name of the shared container registry the image comes from. Leave empty for a public image.')
param registryName string = ''

@description('Resource group of the shared container registry.')
param registryResourceGroup string = resourceGroup().name

@description('CPU cores for each copy of the app. Start small and raise it if the metrics show a need.')
@allowed([
  '0.25'
  '0.5'
  '0.75'
  '1'
  '1.5'
  '2'
])
param cpu string = '0.25'

@description('Memory for each copy. Container Apps pairs it with CPU: 0.25 cores with 0.5Gi, 0.5 with 1Gi, and so on.')
param memory string = '0.5Gi'

@description('Fewest copies running. 0 lets the tool scale to zero, at the cost of a slower first request after a quiet spell.')
@minValue(0)
param minReplicas int = 0

@description('Most copies running at busy times.')
@minValue(1)
param maxReplicas int = 3

@description('Health check path, such as /healthz. Leave empty to use the platform\'s default check.')
param healthPath string = ''

@description('Command that updates the database. The deploy pipeline runs it once per release, after approval and before traffic moves. Leave empty if the tool has no database.')
param migrateCommand string = ''

// ── Sign-in and secrets ─────────────────────────────────────────────────────────

@description('Client ID of the tool\'s Entra app registration. Sign-in is required, and only accounts in this tenant can sign in.')
param signInClientId string

@description('A Key Vault secret the app reads, and the environment variable it appears as.')
type secretRef = {
  @description('Secret name in the tool\'s Key Vault: lowercase letters, numbers and hyphens.')
  name: string
  @description('Environment variable the app reads it from.')
  env: string
}

@description('Secrets to pass to the app. Add each secret to the vault first, then list it here and deploy again.')
param secrets secretRef[] = []

@description('Object IDs of the people or groups who manage this tool\'s secrets (Key Vault Secrets Officer).')
param secretsOfficerIds string[] = []

@description('Purge protection keeps a deleted vault recoverable for 90 days and cannot be turned off later. Turn it off only in a sandbox.')
param keyVaultPurgeProtection bool = true

@description('Server errors (5xx) in 5 minutes before the platform team is alerted.')
param alert5xxThreshold int = 5

// ── Resources ───────────────────────────────────────────────────────────────────

var tags = {
  owner: owner
  'cost-centre': costCentre
  'data-classification': dataClassification
  tool: name
  'managed-by': 'bicep'
}

// Key Vault names are global, 3 to 24 characters, and can't contain "--".
var vaultName = 'kv${take(replace(name, '-', ''), 14)}${take(uniqueString(resourceGroup().id, name), 6)}'

var roles = {
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
}

// A user-assigned identity exists before the app does, so it can be given access to the
// vault and registry first. A system-assigned one would not exist until the app is created.
resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'id-${name}'
  location: location
  tags: tags
}

resource vault 'Microsoft.KeyVault/vaults@2024-11-01' = {
  name: vaultName
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    // Purge protection can only be switched on, never set to false.
    enablePurgeProtection: keyVaultPurgeProtection ? true : null
  }
}

// The app can read secrets, and nothing else.
resource appReadsSecrets 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, roles.keyVaultSecretsUser)
  scope: vault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource secretsOfficers 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for principalId in secretsOfficerIds: {
    name: guid(vault.id, principalId, roles.keyVaultSecretsOfficer)
    scope: vault
    properties: {
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer)
      principalId: principalId
    }
  }
]

// Pull images with the identity instead of the registry's admin password.
module registryPull 'modules/acr-pull.bicep' = if (!empty(registryName)) {
  name: '${name}-acr-pull'
  scope: resourceGroup(registryResourceGroup)
  params: {
    registryName: registryName
    principalId: identity.properties.principalId
  }
}

// The app and its database job pull the same image and see the same settings.
var registries = empty(registryName)
  ? []
  : [
      {
        server: '${registryName}${environment().suffixes.acrLoginServer}'
        identity: identity.id
      }
    ]

var secretEnv = [
  for secret in secrets: {
    name: secret.env
    secretRef: secret.name
  }
]

resource app 'Microsoft.App/containerApps@2025-01-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: workloadProfileName
    configuration: {
      // Multiple, so a new release can be tested with no traffic before it goes live.
      activeRevisionsMode: 'Multiple'
      ingress: {
        external: true
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
      }
      registries: registries
      secrets: [
        for secret in secrets: {
          name: secret.name
          keyVaultUrl: '${vault.properties.vaultUri}secrets/${secret.name}'
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: name
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: secretEnv
          probes: empty(healthPath)
            ? []
            : [
                {
                  type: 'Startup'
                  httpGet: {
                    path: healthPath
                    port: targetPort
                  }
                  periodSeconds: 2
                  timeoutSeconds: 3
                  failureThreshold: 30
                }
                {
                  type: 'Liveness'
                  httpGet: {
                    path: healthPath
                    port: targetPort
                  }
                  periodSeconds: 30
                  timeoutSeconds: 5
                  failureThreshold: 3
                }
              ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
  dependsOn: [
    appReadsSecrets
    registryPull
  ]
}

// Updates the database once per release. A staging revision shares the production database, so
// this runs only after approval, from the image being released, and before traffic moves.
resource migrationJob 'Microsoft.App/jobs@2025-01-01' = if (!empty(migrateCommand)) {
  name: replace('${take(name, 24)}-migrate', '--migrate', '-migrate')
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identity.id}': {}
    }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: workloadProfileName
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 600
      replicaRetryLimit: 0
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      registries: registries
      secrets: [
        for secret in secrets: {
          name: secret.name
          keyVaultUrl: '${vault.properties.vaultUri}secrets/${secret.name}'
          identity: identity.id
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: image
          command: [
            'sh'
            '-c'
            migrateCommand
          ]
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: secretEnv
        }
      ]
    }
  }
  dependsOn: [
    appReadsSecrets
    registryPull
  ]
}

// Entra sign-in in front of the app ("Easy Auth"): no sign-in code in the app itself.
// The app receives the signed-in person in the X-MS-CLIENT-PRINCIPAL-NAME header.
resource signIn 'Microsoft.App/containerApps/authConfigs@2025-01-01' = {
  parent: app
  name: 'current'
  properties: {
    platform: {
      enabled: true
    }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    httpSettings: {
      requireHttps: true
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: true
        registration: {
          clientId: signInClientId
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
        }
      }
    }
  }
}

resource serverErrors 'Microsoft.Insights/metricAlerts@2018-03-01' = {
  name: '${name}-5xx'
  location: 'global'
  tags: tags
  properties: {
    description: '${name}: more than ${alert5xxThreshold} server errors (5xx) in 5 minutes.'
    severity: 2
    enabled: true
    scopes: [
      app.id
    ]
    evaluationFrequency: 'PT1M'
    windowSize: 'PT5M'
    autoMitigate: true
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'server-errors'
          metricNamespace: 'Microsoft.App/containerApps'
          metricName: 'Requests'
          dimensions: [
            {
              name: 'StatusCodeCategory'
              operator: 'Include'
              values: [
                '5xx'
              ]
            }
          ]
          operator: 'GreaterThan'
          threshold: alert5xxThreshold
          timeAggregation: 'Total'
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroupId
      }
    ]
  }
}

@description('The tool\'s web address.')
output url string = 'https://${app.properties.configuration.ingress.fqdn}'

@description('Add this as a Web redirect URI on the Entra app registration.')
output signInRedirectUri string = 'https://${app.properties.configuration.ingress.fqdn}/.auth/login/aad/callback'

@description('The tool\'s Key Vault, where its secrets go.')
output keyVaultName string = vault.name

@description('The tool\'s identity, for granting it access to anything else it needs.')
output identityPrincipalId string = identity.properties.principalId
