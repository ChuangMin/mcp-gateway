import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Workspace, WorkspaceList } from "@mcp-gateway/server/api";
import { api, errorMessage } from "./api.ts";
import { cell, errorText, row, table } from "./styles.ts";

/** Workspace lifecycle, shown only to Platform Admins. */
export function PlatformAdminPanel({ onChanged }: { onChanged: () => void }) {
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string>();

  const load = useCallback(() => {
    api<WorkspaceList>("GET", "/api/workspaces")
      .then((list) => setWorkspaces(list.workspaces))
      .catch((e) => setError(errorMessage(e)));
  }, []);
  useEffect(load, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
      load();
      onChanged();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  return (
    <section>
      <h2>All Workspaces (Platform Admin)</h2>
      {error && (
        <p role="alert" style={errorText}>
          {error}
        </p>
      )}
      <CreateWorkspaceForm onCreate={(name, admins) => run(() => api("POST", "/api/workspaces", { name, admins }))} />
      {workspaces === null ? (
        <p>Loading…</p>
      ) : workspaces.length === 0 ? (
        <p>No Workspaces yet.</p>
      ) : (
        <table style={table}>
          <tbody>
            {workspaces.map((workspace) => (
              <WorkspaceRow
                key={workspace.id}
                workspace={workspace}
                onRename={(name) => run(() => api("PATCH", `/api/workspaces/${workspace.id}`, { name }))}
                onDelete={() => run(() => api("DELETE", `/api/workspaces/${workspace.id}`))}
              />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function CreateWorkspaceForm({ onCreate }: { onCreate: (name: string, admins: string[]) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [admins, setAdmins] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const list = admins.split(/[\s,;]+/).filter(Boolean);
    if (await onCreate(name, list)) {
      setName("");
      setAdmins("");
    }
  };

  return (
    <form onSubmit={submit} style={{ ...row, marginBottom: "1rem" }}>
      <input required placeholder="Workspace name" value={name} onChange={(e) => setName(e.target.value)} />
      <input
        required
        placeholder="Initial Workspace Admins (emails, comma-separated)"
        value={admins}
        onChange={(e) => setAdmins(e.target.value)}
        style={{ minWidth: "20rem" }}
      />
      <button type="submit">Create Workspace</button>
    </form>
  );
}

function WorkspaceRow({
  workspace,
  onRename,
  onDelete,
}: {
  workspace: Workspace;
  onRename: (name: string) => Promise<boolean>;
  onDelete: () => Promise<boolean>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(workspace.name);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (await onRename(name)) setEditing(false);
  };

  return (
    <tr>
      <td style={cell}>
        {editing ? (
          <form onSubmit={save} style={row}>
            <input required value={name} onChange={(e) => setName(e.target.value)} />
            <button type="submit">Save</button>
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </form>
        ) : (
          workspace.name
        )}
      </td>
      <td style={{ ...cell, textAlign: "right" }}>
        {!editing && (
          <span style={{ ...row, justifyContent: "flex-end" }}>
            <button type="button" onClick={() => setEditing(true)}>
              Rename
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Delete the Workspace "${workspace.name}"? This cannot be undone.`)) void onDelete();
              }}
            >
              Delete
            </button>
          </span>
        )}
      </td>
    </tr>
  );
}
