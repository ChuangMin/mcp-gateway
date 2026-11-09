import { useState } from "react";
import type { ToolApproval, ToolDecisionRequest, ToolList, UpstreamTool } from "@mcp-gateway/server/api";
import { api } from "./api.ts";
import { errorText, muted, row } from "./styles.ts";

type Decision = ToolDecisionRequest["decision"];
type Run = (action: () => Promise<unknown>, done?: (result: unknown) => void) => Promise<boolean>;

const STATE: Record<ToolApproval, { label: string; color: string }> = {
  pending: { label: "Pending approval", color: "#8a5a00" },
  approved: { label: "Approved", color: "#1b7f3b" },
  rejected: { label: "Rejected", color: "#666" },
  changed: { label: "Changed since approval — suspended", color: "#b00020" },
};

const needsReview = (tool: UpstreamTool) => tool.approval === "pending" || tool.approval === "changed";

const schemaText = (schema: unknown) => JSON.stringify(schema, null, 2);
const pre = { fontSize: "0.8rem", overflowX: "auto", margin: "0.25rem 0" } as const;

/**
 * An Upstream Server's tools, and for Workspace Admins the Tool Approval controls (ADR 0003). Approving sends the
 * fingerprint of the version shown, so a tool that changed meanwhile is not approved unseen.
 */
export function ToolReview({
  tools,
  path,
  isAdmin,
  run,
  onDecided,
}: {
  tools: UpstreamTool[];
  path: string;
  isAdmin: boolean;
  run: Run;
  onDecided: () => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const decide = (decision: Decision, chosen: UpstreamTool[]) =>
    run(
      () =>
        api<ToolList>("POST", `${path}/tools/approval`, {
          decision,
          tools: chosen.map(({ name, fingerprint }) => ({ name, fingerprint })),
        } satisfies ToolDecisionRequest),
      () => {
        setSelected(new Set());
        onDecided();
      },
    );

  if (tools.length === 0) return <p style={muted}>No tools discovered.</p>;

  const chosen = tools.filter((t) => selected.has(t.name));
  const toggle = (name: string) => {
    const next = new Set(selected);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    setSelected(next);
  };
  const awaiting = tools.filter(needsReview);

  return (
    <>
      {isAdmin && (
        <div style={{ ...row, marginBottom: "0.5rem" }}>
          <button type="button" onClick={() => setSelected(new Set(awaiting.map((t) => t.name)))} disabled={awaiting.length === 0}>
            Select all awaiting review ({awaiting.length})
          </button>
          <button type="button" onClick={() => void decide("approved", chosen)} disabled={chosen.length === 0}>
            Approve selected ({chosen.length})
          </button>
          <button type="button" onClick={() => void decide("rejected", chosen)} disabled={chosen.length === 0}>
            Reject selected
          </button>
          <button type="button" onClick={() => void decide("pending", chosen)} disabled={chosen.length === 0}>
            Revoke selected
          </button>
        </div>
      )}
      <ul style={{ listStyle: "none", paddingLeft: 0 }}>
        {tools.map((tool) => (
          <li key={tool.name} style={{ marginBottom: "0.75rem" }}>
            <span style={row}>
              {isAdmin && (
                <input
                  type="checkbox"
                  aria-label={`Select ${tool.name}`}
                  checked={selected.has(tool.name)}
                  onChange={() => toggle(tool.name)}
                />
              )}
              <code>{tool.namespacedName}</code>
              <strong style={{ color: STATE[tool.approval].color }}>{STATE[tool.approval].label}</strong>
              {isAdmin && (
                <>
                  {tool.approval !== "approved" && (
                    <button type="button" onClick={() => void decide("approved", [tool])}>
                      {tool.approval === "changed" ? "Approve new version" : "Approve"}
                    </button>
                  )}
                  {tool.approval !== "rejected" && (
                    <button type="button" onClick={() => void decide("rejected", [tool])}>
                      Reject
                    </button>
                  )}
                  {tool.approval !== "pending" && (
                    <button type="button" onClick={() => void decide("pending", [tool])}>
                      Revoke
                    </button>
                  )}
                </>
              )}
            </span>
            {tool.description && <div>{tool.description}</div>}
            {tool.previouslyApproved ? (
              <ChangedVersion tool={tool} previous={tool.previouslyApproved} />
            ) : (
              <details>
                <summary style={muted}>Input schema</summary>
                <pre style={pre}>{schemaText(tool.inputSchema)}</pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

/** What changed since a tool was approved: the approved version beside the current one. */
function ChangedVersion({
  tool,
  previous,
}: {
  tool: UpstreamTool;
  previous: NonNullable<UpstreamTool["previouslyApproved"]>;
}) {
  const descriptionChanged = (previous.description ?? "") !== (tool.description ?? "");
  const schemaChanged = schemaText(previous.inputSchema) !== schemaText(tool.inputSchema);
  return (
    <details open>
      <summary style={errorText}>
        Changed since approval: {[descriptionChanged && "description", schemaChanged && "input schema"].filter(Boolean).join(" and ") || "details"}
      </summary>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.5rem" }}>
        <div>
          <strong>Approved version</strong>
          <div>{previous.description ?? <span style={muted}>(no description)</span>}</div>
          <pre style={pre}>{schemaText(previous.inputSchema)}</pre>
        </div>
        <div>
          <strong>Current version</strong>
          <div>{tool.description ?? <span style={muted}>(no description)</span>}</div>
          <pre style={pre}>{schemaText(tool.inputSchema)}</pre>
        </div>
      </div>
    </details>
  );
}
