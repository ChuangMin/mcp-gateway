import type { Context, ErrorHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ErrorResponse } from "../api/schemas.js";
import { DirectoryError, type DirectoryErrorCode } from "../directory/directory.js";
import { EntraUnavailableError } from "../identity/entra-directory.js";
import { UpstreamError, type UpstreamErrorCode } from "../upstream/registry.js";

/** A REST API refusal with a status and an `ErrorResponse` body. Throw it from a handler. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const DIRECTORY_STATUS: Record<DirectoryErrorCode, ContentfulStatusCode> = {
  workspace_not_found: 404,
  member_not_found: 404,
  person_not_found: 422,
  already_member: 409,
  name_taken: 409,
  last_workspace_admin: 409,
};

const UPSTREAM_STATUS: Record<UpstreamErrorCode, ContentfulStatusCode> = {
  server_not_found: 404,
  prefix_taken: 409,
  tool_not_found: 404,
  tool_changed: 409,
};

/** Turns refusals from handlers and domain modules into `ErrorResponse`s. Anything else is a 500. */
export const apiErrorHandler: ErrorHandler = (err, c) => {
  const reply = (status: ContentfulStatusCode, error: string, message: string) =>
    c.json({ error, message } satisfies ErrorResponse, status);
  if (err instanceof ApiError) return reply(err.status, err.code, err.message);
  if (err instanceof DirectoryError) return reply(DIRECTORY_STATUS[err.code], err.code, err.message);
  if (err instanceof UpstreamError) return reply(UPSTREAM_STATUS[err.code], err.code, err.message);
  if (err instanceof EntraUnavailableError) {
    console.error(err.message);
    return reply(502, "entra_unavailable", "Entra could not be reached; try again shortly");
  }
  console.error(err);
  return reply(500, "internal_error", "Something went wrong");
};

/** zod-openapi hook: answers invalid requests with a 400 `ErrorResponse` naming each problem. */
export const validationHook = (
  result: { success: true } | { success: false; error: { issues: Array<{ path: PropertyKey[]; message: string }> } },
  c: Context,
) => {
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message))
      .join("; ");
    return c.json({ error: "invalid_request", message } satisfies ErrorResponse, 400);
  }
};
