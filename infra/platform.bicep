// The shared platform every tool runs on. The platform team deploys it once per
// environment (for example production and staging) into its own resource group:
//   az deployment group what-if -g rg-platform -f infra/platform.bicep -p infra/platform.bicepparam
//   az deployment group create  -g rg-platform -f infra/platform.bicep -p infra/platform.bicepparam
//
// It creates:
// - a Log Analytics workspace that holds every tool's logs
// - a Container Apps environment (Consumption: billed only while apps run)
// - a container registry with its admin password switched off (tools pull with their identity)
// - an action group that emails the platform team when a tool's alert fires
// Its outputs are the inputs tool.bicep needs.

targetScope = 'resourceGroup'

@description('Short name for this platform, such as tools or tools-staging. Used in resource names.')
@minLength(2)
@maxLength(20)
param name string

@description('Email address (ideally a shared mailbox) that receives tool alerts.')
param platformTeamEmail string

@description('Email of the person accountable for the platform.')
param owner string

@description('Cost centre the platform is charged to.')
param costCentre string

param location string = resourceGroup().location

@description('Days to keep logs. 30 is included in the Log Analytics price; longer costs more.')
@minValue(30)
@maxValue(730)
param logRetentionDays int = 30

var tags = {
  owner: owner
  'cost-centre': costCentre
  'data-classification': 'Internal'
  'managed-by': 'bicep'
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: 'log-${name}'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: logRetentionDays
  }
}

resource appEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: 'cae-${name}'
  location: location
  tags: tags
  properties: {
    // Logs flow through Azure Monitor, then to the workspace by the setting below,
    // which gives the readable ContainerAppConsoleLogs and ContainerAppSystemLogs tables.
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

resource environmentLogs 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'to-log-analytics'
  scope: appEnvironment
  properties: {
    workspaceId: workspace.id
    logs: [
      {
        category: 'ContainerAppConsoleLogs'
        enabled: true
      }
      {
        category: 'ContainerAppSystemLogs'
        enabled: true
      }
    ]
  }
}

// Registry names are global, 5 to 50 letters and numbers.
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: take('acr${replace(name, '-', '')}${uniqueString(resourceGroup().id)}', 50)
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
  }
}

resource platformTeam 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: 'ag-${name}-platform'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'platform'
    enabled: true
    emailReceivers: [
      {
        name: 'platform-team'
        emailAddress: platformTeamEmail
        useCommonAlertSchema: true
      }
    ]
  }
}

@description('Pass to tool.bicep as environmentId.')
output environmentId string = appEnvironment.id

@description('Pass to tool.bicep as actionGroupId.')
output actionGroupId string = platformTeam.id

@description('Pass to tool.bicep as registryName.')
output registryName string = registry.name

@description('Every tool\'s address ends with this.')
output defaultDomain string = appEnvironment.properties.defaultDomain

output workspaceId string = workspace.id
