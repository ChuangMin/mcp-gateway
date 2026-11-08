# The Gateway is its own OAuth authorization server, delegating sign-in to Entra

MCP clients authenticate to the Gateway through the MCP OAuth flow with the Gateway itself as the authorization server; when a User needs to sign in, the Gateway sends them to the Entra Tenant, then issues its own tokens. Clients do not use Entra-issued tokens directly. Entra does not support the client registration mechanisms MCP clients rely on (Dynamic Client Registration, Client ID Metadata Documents), and cannot bind tokens to each Profile's URL as the MCP authorization spec requires. Because any program can register as a client, the Gateway shows a consent screen the first time each client asks for access to a Profile, to stop a malicious client from riding an existing Entra session. Being an authorization server makes the Gateway responsible for token lifetimes, refresh-token rotation, and revocation; on each refresh it re-checks with Entra that the User is still enabled.

## Considered Options

- **Clients use Entra tokens directly**: rejected; MCP clients cannot register with Entra automatically, and Entra tokens cannot be bound to individual Profiles.
- **API tokens only**: rejected as the main path, because Users would have to create and paste tokens by hand. API tokens are still offered alongside OAuth for clients that cannot run a browser sign-in.
