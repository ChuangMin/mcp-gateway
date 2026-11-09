import type { ErrorResponse } from "@mcp-gateway/server/api";

/** A REST API refusal, carrying the server's message for display. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the Gateway's REST API. Resolves the JSON body (undefined for 204); rejects with ApiError. */
export async function api<T = void>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => undefined)) as ErrorResponse | undefined;
    throw new ApiError(response.status, error?.error ?? "unknown", error?.message ?? `Request failed (${response.status})`);
  }
  return (response.status === 204 ? undefined : await response.json()) as T;
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
