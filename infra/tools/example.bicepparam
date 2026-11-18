// One file per tool. Copy this, rename it after the tool, and fill it in.
// The IDs below are placeholders: use the outputs of platform.bicep and the tool's
// Entra app registration.
using '../tool.bicep'

param name = 'leasing-assistant'
param owner = 'jane.citizen@example.com'
param costCentre = 'PM-OPS'
param dataClassification = 'Confidential'

param environmentId = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-platform/providers/Microsoft.App/managedEnvironments/cae-tools'
param actionGroupId = '/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-platform/providers/Microsoft.Insights/actionGroups/ag-tools-platform'
param registryName = 'acrtoolsexample'
param registryResourceGroup = 'rg-platform'

// The app built from this template listens on 8080 and answers /healthz.
param image = 'acrtoolsexample.azurecr.io/leasing-assistant:0123abc'
param targetPort = 8080
param healthPath = '/healthz'

param signInClientId = '00000000-0000-0000-0000-000000000000'

// The settings the app refuses to start without in production (see .env.example).
param secrets = [
  { name: 'app-jwt-secret', env: 'APP_JWT_SECRET' }
  { name: 'database-url', env: 'DATABASE_URL' }
]
