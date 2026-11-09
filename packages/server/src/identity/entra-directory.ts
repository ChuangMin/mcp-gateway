import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import { entraTenantUrl } from "./identity.js";

/** A person found in the Entra Tenant's directory. */
export interface EntraPersonRecord {
  objectId: string;
  name: string;
  email: string;
}

export class EntraUnavailableError extends Error {
  constructor(detail: string) {
    super(`Microsoft Graph is unavailable: ${detail}`);
    this.name = "EntraUnavailableError";
  }
}

export interface EntraDirectory {
  /**
   * Looks a person up in the Entra Tenant by object ID or user principal name (usually their email).
   * Resolves undefined when the tenant has no such person. Throws EntraUnavailableError when Graph can't answer.
   */
  findPerson(objectIdOrUpn: string): Promise<EntraPersonRecord | undefined>;
}

/** Renew the app-only Graph token this long before it expires. */
const TOKEN_RENEWAL_MARGIN_MS = 5 * 60 * 1000;

/** Reads the Entra Tenant's directory through Microsoft Graph, as the Gateway's app registration (client credentials). */
export function createEntraDirectory({ config, clock }: { config: Config; clock: Clock }): EntraDirectory {
  const graph = config.graphBaseUrl.href.endsWith("/") ? config.graphBaseUrl.href : `${config.graphBaseUrl.href}/`;
  let token: { value: string; expiresAt: number } | undefined;

  const appToken = async (): Promise<string> => {
    if (token && token.expiresAt - TOKEN_RENEWAL_MARGIN_MS > clock.now().getTime()) return token.value;
    let response: Response;
    try {
      response = await fetch(entraTenantUrl(config, "oauth2/v2.0/token"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: config.entra.clientId,
          client_secret: config.entra.clientSecret,
          scope: new URL(".default", graph).toString(),
        }),
      });
    } catch (error) {
      throw new EntraUnavailableError(`token request failed: ${(error as Error).message}`);
    }
    if (!response.ok) throw new EntraUnavailableError(`token endpoint answered ${response.status}`);
    const body = (await response.json()) as { access_token: string; expires_in: number };
    token = { value: body.access_token, expiresAt: clock.now().getTime() + body.expires_in * 1000 };
    return token.value;
  };

  return {
    async findPerson(objectIdOrUpn) {
      const url = new URL(`v1.0/users/${encodeURIComponent(objectIdOrUpn)}`, graph);
      url.searchParams.set("$select", "id,displayName,mail,userPrincipalName");
      let response: Response;
      try {
        response = await fetch(url, { headers: { authorization: `Bearer ${await appToken()}` } });
      } catch (error) {
        if (error instanceof EntraUnavailableError) throw error;
        throw new EntraUnavailableError(`user lookup failed: ${(error as Error).message}`);
      }
      if (response.status === 404 || response.status === 400) return undefined;
      if (!response.ok) throw new EntraUnavailableError(`user lookup answered ${response.status}`);
      const user = (await response.json()) as {
        id: string;
        displayName: string | null;
        mail: string | null;
        userPrincipalName: string;
      };
      const email = user.mail || user.userPrincipalName;
      return { objectId: user.id, name: user.displayName || email, email };
    },
  };
}
