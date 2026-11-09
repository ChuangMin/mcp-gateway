/** Joins a Server Prefix and a tool's original name into its Namespaced Tool Name. */
export const SEPARATOR = "__";

/** Lowercase letters and digits in groups joined by single underscores: no `__`, no leading or trailing `_`. */
export const SERVER_PREFIX_PATTERN = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;
/** Leaves room for the separator and the tool name within the 64-character tool-name limit many MCP clients have. */
export const SERVER_PREFIX_MAX_LENGTH = 32;

export function namespacedToolName(prefix: string, toolName: string): string {
  return `${prefix}${SEPARATOR}${toolName}`;
}
