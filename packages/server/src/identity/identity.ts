import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Clock } from "../clock.js";
import type { Config } from "../config.js";
import type { Database } from "../db/database.js";
import { signInRequests } from "../db/schema.js";

/** The value of the Platform Admin app role defined on the Gateway's Entra app registration. */
export const PLATFORM_ADMIN_APP_ROLE = "PlatformAdmin";

/** How long a person has to finish signing in at Entra. */
const SIGN_IN_REQUEST_LIFETIME_MS = 10 * 60 * 1000;
/** Allowance for clock skew between the Gateway and Entra when checking ID token times. */
const CLOCK_TOLERANCE_SECONDS = 5 * 60;

/** Who Entra says signed in. */
export interface EntraIdentity {
  objectId: string;
  name: string;
  email: string;
  isPlatformAdmin: boolean;
}

export type SignInOutcome =
  | { ok: true; identity: EntraIdentity }
  /** `other_tenant`: a genuine Entra account, but not from the configured Entra Tenant. */
  | { ok: false; reason: "other_tenant" | "failed"; detail: string };

export interface Identity {
  /** Starts an authorization code flow with PKCE. Returns where to send the browser and the `state` to bind to it. */
  beginSignIn(redirectUri: string): Promise<{ authorizationUrl: string; state: string }>;
  /**
   * Finishes a sign-in begun with `beginSignIn`. Each `state` can be completed once; an unknown, used or expired
   * one fails. Pass `code` undefined when Entra returned an error, to discard the request.
   */
  completeSignIn(state: string, code: string | undefined): Promise<SignInOutcome>;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

const base64url = (bytes: Buffer) => bytes.toString("base64url");

/** A URL under the configured Entra Tenant at the Entra authority, e.g. `v2.0/.well-known/openid-configuration`. */
export function entraTenantUrl(config: Config, path: string): URL {
  const { authorityUrl, tenantId } = config.entra;
  const authority = authorityUrl.href.endsWith("/") ? authorityUrl.href : `${authorityUrl.href}/`;
  return new URL(`${tenantId}/${path}`, authority);
}

/** Signs people in through the one configured Entra Tenant (ADR 0002) using OIDC. */
export function createIdentity({ config, clock, database }: { config: Config; clock: Clock; database: Database }) {
  const { tenantId, clientId, clientSecret } = config.entra;
  const discoveryUrl = entraTenantUrl(config, "v2.0/.well-known/openid-configuration");
  const db = database.db;

  let discovery: Promise<{ metadata: Discovery; keys: ReturnType<typeof createRemoteJWKSet> }> | undefined;
  const discover = () => {
    discovery ??= (async () => {
      const response = await fetch(discoveryUrl);
      if (!response.ok) throw new Error(`Entra OIDC discovery failed: ${response.status} from ${discoveryUrl}`);
      const metadata = (await response.json()) as Discovery;
      return { metadata, keys: createRemoteJWKSet(new URL(metadata.jwks_uri)) };
    })();
    // A failed lookup (Entra briefly unreachable) must not be cached forever.
    discovery.catch(() => (discovery = undefined));
    return discovery;
  };

  const failed = (detail: string): SignInOutcome => ({ ok: false, reason: "failed", detail });

  const identity: Identity = {
    async beginSignIn(redirectUri) {
      const { metadata } = await discover();
      const state = base64url(randomBytes(32));
      const nonce = base64url(randomBytes(32));
      const codeVerifier = base64url(randomBytes(32));
      const now = clock.now();

      await db.delete(signInRequests).where(lt(signInRequests.expiresAt, now));
      await db.insert(signInRequests).values({
        state,
        nonce,
        codeVerifier,
        redirectUri,
        expiresAt: new Date(now.getTime() + SIGN_IN_REQUEST_LIFETIME_MS),
      });

      const url = new URL(metadata.authorization_endpoint);
      url.search = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        response_mode: "query",
        redirect_uri: redirectUri,
        scope: "openid profile email",
        state,
        nonce,
        code_challenge: base64url(createHash("sha256").update(codeVerifier).digest()),
        code_challenge_method: "S256",
      }).toString();
      return { authorizationUrl: url.toString(), state };
    },

    async completeSignIn(state, code) {
      // Deleting claims the request, so each one completes at most once even with several Gateway instances.
      const [request] = await db
        .delete(signInRequests)
        .where(and(eq(signInRequests.state, state), gt(signInRequests.expiresAt, clock.now())))
        .returning();
      if (!request) return failed("unknown, used or expired sign-in request");
      if (code === undefined) return failed("Entra returned an error");

      const { metadata, keys } = await discover();
      const tokenResponse = await fetch(metadata.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: request.redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: request.codeVerifier,
        }),
      });
      if (!tokenResponse.ok) {
        return failed(`token endpoint answered ${tokenResponse.status}: ${await tokenResponse.text()}`);
      }
      const { id_token: idToken } = (await tokenResponse.json()) as { id_token?: unknown };
      if (typeof idToken !== "string") return failed("token response had no id_token");

      let claims: JWTPayload & Record<string, unknown>;
      try {
        ({ payload: claims } = await jwtVerify(idToken, keys, {
          audience: clientId,
          algorithms: ["RS256"],
          currentDate: clock.now(),
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ["iss", "exp", "iat"],
        }));
      } catch (error) {
        return failed(`ID token rejected: ${(error as Error).message}`);
      }

      if (claims.tid !== tenantId) {
        return { ok: false, reason: "other_tenant", detail: `account is from tenant ${String(claims.tid)}` };
      }
      if (claims.iss !== metadata.issuer) return failed(`unexpected issuer ${claims.iss}`);
      if (claims.nonce !== request.nonce) return failed("nonce mismatch");
      if (typeof claims.oid !== "string" || claims.oid === "") return failed("ID token has no oid");

      const email =
        (typeof claims.email === "string" && claims.email) ||
        (typeof claims.preferred_username === "string" && claims.preferred_username) ||
        "";
      const roles = Array.isArray(claims.roles) ? claims.roles : [];
      return {
        ok: true,
        identity: {
          objectId: claims.oid,
          name: typeof claims.name === "string" && claims.name !== "" ? claims.name : email,
          email,
          isPlatformAdmin: roles.includes(PLATFORM_ADMIN_APP_ROLE),
        },
      };
    },
  };
  return identity;
}
