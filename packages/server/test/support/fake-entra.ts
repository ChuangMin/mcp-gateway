import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair, type JWK } from "jose";
import type { Clock } from "../../src/clock.js";
import { PLATFORM_ADMIN_APP_ROLE } from "../../src/identity/identity.js";

/** Someone with an account in an Entra tenant. Tests change fields to simulate changes made in Entra. */
export interface EntraPerson {
  objectId: string;
  tenantId: string;
  name: string;
  email: string;
  /** Holds the Gateway's Platform Admin app role. */
  platformAdmin: boolean;
}

export interface FakeEntraOptions {
  /** The tenant the Gateway is configured for. People are created in it unless told otherwise. */
  tenantId: string;
  clientId: string;
  clientSecret: string;
  clock: Clock;
}

interface IssuedCode {
  person: EntraPerson;
  clientId: string;
  redirectUri: string;
  nonce: string | undefined;
  codeChallenge: string;
}

/**
 * An in-test stand-in for Microsoft Entra ID's v2.0 OIDC endpoints. It has no login page: whoever drives the
 * browser names the person to sign in with the fake-only `fake_person` query parameter on the authorize URL.
 */
export class FakeEntra {
  readonly #options: FakeEntraOptions;
  readonly #people = new Map<string, EntraPerson>();
  readonly #codes = new Map<string, IssuedCode>();
  readonly #graphTokens = new Set<string>();
  /** When true, Microsoft Graph answers every request with 503. */
  graphDown = false;
  #server: ReturnType<typeof serve> | undefined;
  #url = "";
  #privateKey!: CryptoKey;
  #publicJwk!: JWK;

  private constructor(options: FakeEntraOptions) {
    this.#options = options;
  }

  static async start(options: FakeEntraOptions): Promise<FakeEntra> {
    const entra = new FakeEntra(options);
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    entra.#privateKey = privateKey;
    entra.#publicJwk = { ...(await exportJWK(publicKey)), kid: "fake-key-1", use: "sig", alg: "RS256" };
    await new Promise<void>((resolve) => {
      entra.#server = serve({ fetch: entra.#app().fetch, port: 0, hostname: "127.0.0.1" }, () => resolve());
    });
    entra.#url = `http://127.0.0.1:${(entra.#server!.address() as AddressInfo).port}`;
    return entra;
  }

  /** The authority URL to configure the Gateway with (ENTRA_AUTHORITY_URL). */
  get url(): string {
    return this.#url;
  }

  /** The Microsoft Graph base URL to configure the Gateway with (GRAPH_BASE_URL). */
  get graphUrl(): string {
    return `${this.#url}/graph`;
  }

  /** Creates an account. Defaults to the configured tenant and no Platform Admin role. */
  person(overrides: Partial<EntraPerson> = {}): EntraPerson {
    const n = this.#people.size + 1;
    const person: EntraPerson = {
      objectId: randomUUID(),
      tenantId: this.#options.tenantId,
      name: `Person ${n}`,
      email: `person${n}@example.test`,
      platformAdmin: false,
      ...overrides,
    };
    this.#people.set(person.objectId, person);
    return person;
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => this.#server?.close((err) => (err ? reject(err) : resolve())));
  }

  #app() {
    const app = new Hono();
    const options = this.#options;

    app.get("/:tenant/v2.0/.well-known/openid-configuration", (c) => {
      const base = `${this.#url}/${c.req.param("tenant")}`;
      return c.json({
        issuer: `${base}/v2.0`,
        authorization_endpoint: `${base}/oauth2/v2.0/authorize`,
        token_endpoint: `${base}/oauth2/v2.0/token`,
        jwks_uri: `${base}/discovery/v2.0/keys`,
        response_types_supported: ["code"],
        id_token_signing_alg_values_supported: ["RS256"],
        code_challenge_methods_supported: ["S256"],
      });
    });

    app.get("/:tenant/discovery/v2.0/keys", (c) => c.json({ keys: [this.#publicJwk] }));

    app.get("/:tenant/oauth2/v2.0/authorize", (c) => {
      const q = c.req.query();
      const person = this.#people.get(q.fake_person ?? "");
      if (q.client_id !== options.clientId) return c.text("unknown client_id", 400);
      if (!q.redirect_uri) return c.text("redirect_uri is required", 400);
      if (q.response_type !== "code") return c.text("response_type must be code", 400);
      if (!q.code_challenge || q.code_challenge_method !== "S256") return c.text("PKCE with S256 is required", 400);
      if (!person) return c.text("fake_person names no known person", 400);

      const code = randomBytes(16).toString("base64url");
      this.#codes.set(code, {
        person: { ...person },
        clientId: q.client_id,
        redirectUri: q.redirect_uri,
        nonce: q.nonce,
        codeChallenge: q.code_challenge,
      });
      const redirect = new URL(q.redirect_uri);
      redirect.searchParams.set("code", code);
      if (q.state !== undefined) redirect.searchParams.set("state", q.state);
      return c.redirect(redirect.toString(), 302);
    });

    app.post("/:tenant/oauth2/v2.0/token", async (c) => {
      const form = await c.req.parseBody();
      const field = (name: string) => (typeof form[name] === "string" ? (form[name] as string) : undefined);
      const issued = this.#codes.get(field("code") ?? "");
      this.#codes.delete(field("code") ?? "");
      const invalidGrant = (description: string) =>
        c.json({ error: "invalid_grant", error_description: description }, 400);

      if (field("client_id") !== options.clientId || field("client_secret") !== options.clientSecret) {
        return c.json({ error: "invalid_client" }, 401);
      }
      if (field("grant_type") === "client_credentials") {
        if (field("scope") !== `${this.graphUrl}/.default`) return c.json({ error: "invalid_scope" }, 400);
        const accessToken = randomBytes(16).toString("base64url");
        this.#graphTokens.add(accessToken);
        return c.json({ token_type: "Bearer", access_token: accessToken, expires_in: 3600 });
      }
      if (field("grant_type") !== "authorization_code") return c.json({ error: "unsupported_grant_type" }, 400);
      if (!issued) return invalidGrant("unknown or used code");
      if (field("redirect_uri") !== issued.redirectUri) return invalidGrant("redirect_uri mismatch");
      const verifier = field("code_verifier") ?? "";
      if (createHash("sha256").update(verifier).digest("base64url") !== issued.codeChallenge) {
        return invalidGrant("PKCE verification failed");
      }

      const { person } = issued;
      const now = Math.floor(options.clock.now().getTime() / 1000);
      const idToken = await new SignJWT({
        oid: person.objectId,
        tid: person.tenantId,
        name: person.name,
        preferred_username: person.email,
        ...(person.platformAdmin ? { roles: [PLATFORM_ADMIN_APP_ROLE] } : {}),
        ...(issued.nonce !== undefined ? { nonce: issued.nonce } : {}),
      })
        .setProtectedHeader({ alg: "RS256", kid: this.#publicJwk.kid! })
        .setIssuer(`${this.#url}/${person.tenantId}/v2.0`)
        .setAudience(issued.clientId)
        .setSubject(randomUUID())
        .setIssuedAt(now)
        .setNotBefore(now)
        .setExpirationTime(now + 3600)
        .sign(this.#privateKey);

      return c.json({ token_type: "Bearer", id_token: idToken, access_token: "fake", expires_in: 3600 });
    });

    // Microsoft Graph: only people in the configured tenant are in its directory.
    app.get("/graph/v1.0/users/:idOrUpn", (c) => {
      if (this.graphDown) return c.json({ error: { code: "ServiceUnavailable" } }, 503);
      const bearer = c.req.header("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!this.#graphTokens.has(bearer)) return c.json({ error: { code: "InvalidAuthenticationToken" } }, 401);
      const key = c.req.param("idOrUpn").toLowerCase();
      const person = [...this.#people.values()].find(
        (p) => p.tenantId === options.tenantId && (p.objectId === key || p.email.toLowerCase() === key),
      );
      if (!person) return c.json({ error: { code: "Request_ResourceNotFound" } }, 404);
      return c.json({ id: person.objectId, displayName: person.name, mail: person.email, userPrincipalName: person.email });
    });

    return app;
  }
}
