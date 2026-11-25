// Lets one tool's build identity push images to that tool's own repository in the shared
// registry. Deployed into the registry's resource group by tool.bicep.
//
// With per-repository permissions (ABAC) the push is limited to the one repository. A registry
// using the older registry-wide mode can't limit it, so AcrPush covers every repository there.

@description('Name of the container registry.')
param registryName string

@description('Principal ID of the tool\'s build identity.')
param principalId string

@description('The one repository it may push to.')
param repository string

var roles = {
  acrPush: '8311e382-0749-4cb8-b61a-304f252e45ec'
  repositoryWriter: '2a1e307c-b015-4ebd-883e-5b7698a07328'
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
}

var content = 'Microsoft.ContainerRegistry/registries/repositories'
var onlyThisRepository = '((!(ActionMatches{\'${content}/content/read\'}) AND !(ActionMatches{\'${content}/metadata/read\'}) AND !(ActionMatches{\'${content}/content/write\'}) AND !(ActionMatches{\'${content}/metadata/write\'})) OR (@Request[${content}:name] StringEqualsIgnoreCase \'${repository}\'))'

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}

var perRepository = registry.properties.roleAssignmentMode == 'AbacRepositoryPermissions'

resource push 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, principalId, repository, 'push')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId(
      'Microsoft.Authorization/roleDefinitions',
      perRepository ? roles.repositoryWriter : roles.acrPush
    )
    principalId: principalId
    principalType: 'ServicePrincipal'
    condition: perRepository ? onlyThisRepository : null
    conditionVersion: perRepository ? '2.0' : null
  }
}

// `az acr login` looks the registry up first. Reader shows its settings and none of its images.
resource find 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, principalId, 'find')
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.reader)
    principalId: principalId
    principalType: 'ServicePrincipal'
  }
}
