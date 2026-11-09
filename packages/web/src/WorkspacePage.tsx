import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Member, MemberList, Standing, WorkspaceSummary } from "@mcp-gateway/server/api";
import { ApiError, api, errorMessage } from "./api.ts";
import { link } from "./router.ts";
import { cell, errorText, muted, row, table } from "./styles.ts";
import { UpstreamServersSection } from "./UpstreamServersSection.tsx";

export const STANDING_LABEL: Record<Standing, string> = { admin: "Workspace Admin", member: "Member" };

/** One Workspace: its members, and for Workspace Admins the controls to manage them. */
export function WorkspacePage({ workspaceId, currentUserId }: { workspaceId: string; currentUserId: string }) {
  const [workspace, setWorkspace] = useState<WorkspaceSummary | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string>();
  const membersPath = `/api/workspaces/${workspaceId}/members`;

  const load = useCallback(async () => {
    try {
      const [w, m] = await Promise.all([
        api<WorkspaceSummary>("GET", `/api/workspaces/${workspaceId}`),
        api<MemberList>("GET", membersPath),
      ]);
      setWorkspace(w);
      setMembers(m.members);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) setNotFound(true);
      else setError(errorMessage(e));
    }
  }, [workspaceId, membersPath]);
  useEffect(() => void load(), [load]);

  const run = async (action: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await action();
      await load();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  const back = <a {...link("/")}>← Your Workspaces</a>;
  if (notFound) {
    return (
      <>
        {back}
        <p>This Workspace doesn't exist, or you don't belong to it.</p>
      </>
    );
  }
  if (!workspace) {
    return (
      <>
        {back}
        <p>Loading…</p>
      </>
    );
  }

  const isAdmin = workspace.standing === "admin";

  return (
    <>
      {back}
      <h2>{workspace.name}</h2>
      <p style={muted}>You are a {STANDING_LABEL[workspace.standing]} here.</p>
      {error && (
        <p role="alert" style={errorText}>
          {error}
        </p>
      )}

      <UpstreamServersSection workspaceId={workspaceId} isAdmin={isAdmin} />

      <h3>Members</h3>
      {isAdmin && (
        <AddMemberForm onAdd={(person, standing) => run(() => api("POST", membersPath, { person, standing }))} />
      )}
      <table style={table}>
        <tbody>
          {members.map(({ user, standing }) => (
            <tr key={user.id}>
              <td style={cell}>
                {user.name}
                {user.id === currentUserId && " (you)"}
                <div style={muted}>{user.email}</div>
              </td>
              <td style={cell}>{STANDING_LABEL[standing]}</td>
              {isAdmin && (
                <td style={{ ...cell, textAlign: "right" }}>
                  <span style={{ ...row, justifyContent: "flex-end" }}>
                    <button
                      type="button"
                      onClick={() =>
                        run(() =>
                          api("PATCH", `${membersPath}/${user.id}`, {
                            standing: standing === "admin" ? "member" : "admin",
                          }),
                        )
                      }
                    >
                      {standing === "admin" ? "Make member" : "Make Workspace Admin"}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (window.confirm(`Remove ${user.name} from ${workspace.name}?`)) {
                          void run(() => api("DELETE", `${membersPath}/${user.id}`));
                        }
                      }}
                    >
                      Remove
                    </button>
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function AddMemberForm({ onAdd }: { onAdd: (person: string, standing: Standing) => Promise<boolean> }) {
  const [person, setPerson] = useState("");
  const [standing, setStanding] = useState<Standing>("member");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (await onAdd(person, standing)) setPerson("");
  };

  return (
    <form onSubmit={submit} style={{ ...row, marginBottom: "1rem" }}>
      <input
        required
        placeholder="Email or Entra object ID"
        value={person}
        onChange={(e) => setPerson(e.target.value)}
        style={{ minWidth: "16rem" }}
      />
      <select value={standing} onChange={(e) => setStanding(e.target.value as Standing)}>
        <option value="member">Member</option>
        <option value="admin">Workspace Admin</option>
      </select>
      <button type="submit">Add</button>
    </form>
  );
}
