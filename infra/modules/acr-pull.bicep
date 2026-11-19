// Lets an identity pull images from the shared container registry, so apps never need
// the registry's admin password. Deployed into the registry's resource group by tool.bicep.
//
// Registries come in two permission modes, and each needs a different role:
// - registry-wide permissions (the older default): AcrPull
// - per-repository permissions (ABAC, the newer default in the portal):
//   Container Registry Repository Reader. AcrPull does nothing in this mode.

@description('Name of the container registry.')
param registryName string

@description('Principal ID of the identity that pulls images.')
param principalId string

var roles = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
  repositoryReader: 'b93aa761-3e63-49ed-ac28-beffa264f7ac'
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}

resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, principalId, 'pull')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      registry.properties.roleAssignmentMode == 'AbacRepositoryPermissions' ? roles.repositoryReader : roles.acrPull
    )
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
