# Service map

- **demo-tool**: the platform's example tool. A small API for items with optional due dates, signed in with Entra. It runs as the container app `demo-tool` in the shared Container Apps environment, with its own Postgres database (no other tool shares it) and its own Key Vault.
- **Shared platform**: one Container Apps environment, one Log Analytics workspace and one action group for platform on-call. A platform-wide problem shows on every tool at once. Errors on one tool alone point at that tool's own change.
- Every tool is deployed from its repository's main branch by the pipeline. Each deploy is one merged pull request.
