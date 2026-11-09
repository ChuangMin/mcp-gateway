import type { Context } from "hono";
import type { Standing } from "../api/schemas.js";
import type { Directory } from "../directory/directory.js";
import type { SessionEnv } from "./auth.js";
import { ApiError } from "./errors.js";

export const forbidden = (message: string) => new ApiError(403, "forbidden", message);
/** A Workspace the User doesn't belong to looks the same as one that doesn't exist. */
export const workspaceNotFound = () => new ApiError(404, "workspace_not_found", "No such Workspace");

export function requirePlatformAdmin(c: Context<SessionEnv>): void {
  if (!c.var.user.isPlatformAdmin) throw forbidden("Only a Platform Admin can do this");
}

/**
 * Returns a check that the signed-in User belongs to a Workspace with at least the `needed` standing, resolving
 * their standing. Non-members get 404, members lacking standing get 403.
 */
export function standingGuard(directory: Directory) {
  return async (c: Context<SessionEnv>, workspaceId: string, needed: Standing): Promise<Standing> => {
    const standing = await directory.standingOf(workspaceId, c.var.user.id);
    if (standing === undefined) throw workspaceNotFound();
    if (needed === "admin" && standing !== "admin") throw forbidden("Only a Workspace Admin can do this");
    return standing;
  };
}
