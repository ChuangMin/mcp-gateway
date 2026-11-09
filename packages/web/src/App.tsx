import { useEffect, useState } from "react";
import type { MeResponse, SignInError } from "@mcp-gateway/server/api";

type SessionState = { status: "loading" } | { status: "signed-out" } | { status: "signed-in"; me: MeResponse };

const SIGN_IN_ERRORS: Record<SignInError, string> = {
  other_tenant: "That account belongs to a different organization. Sign in with your organization's Microsoft account.",
  failed: "Sign-in didn't complete. Please try again.",
};

/** Reads and clears `?sign_in_error=` left by a failed sign-in, so a reload doesn't show it again. */
function takeSignInError(): string | undefined {
  const params = new URLSearchParams(window.location.search);
  const error = params.get("sign_in_error");
  if (error === null) return undefined;
  params.delete("sign_in_error");
  const query = params.toString();
  window.history.replaceState(null, "", window.location.pathname + (query ? `?${query}` : ""));
  return SIGN_IN_ERRORS[error as SignInError] ?? SIGN_IN_ERRORS.failed;
}

export function App() {
  const [session, setSession] = useState<SessionState>({ status: "loading" });
  const [signInError] = useState(takeSignInError);

  useEffect(() => {
    fetch("/api/me")
      .then(async (response) => {
        if (response.status === 401) return setSession({ status: "signed-out" });
        if (!response.ok) throw new Error(`GET /api/me answered ${response.status}`);
        setSession({ status: "signed-in", me: (await response.json()) as MeResponse });
      })
      .catch(() => setSession({ status: "signed-out" }));
  }, []);

  const signOut = async () => {
    await fetch("/auth/sign-out", { method: "POST" });
    setSession({ status: "signed-out" });
  };

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem", maxWidth: "40rem" }}>
      <h1>mcp-gateway</h1>
      {session.status === "loading" && <p>Loading…</p>}

      {session.status === "signed-out" && (
        <>
          {signInError && (
            <p role="alert" style={{ color: "#b00020" }}>
              {signInError}
            </p>
          )}
          <p>
            <a href="/auth/sign-in">Sign in with Microsoft</a>
          </p>
        </>
      )}

      {session.status === "signed-in" && (
        <>
          <p>
            Signed in as <strong>{session.me.user.name}</strong> ({session.me.user.email})
            {session.me.user.isPlatformAdmin && <> · Platform Admin</>}{" "}
            <button type="button" onClick={signOut}>
              Sign out
            </button>
          </p>
          <h2>Your Workspaces</h2>
          {session.me.workspaces.length === 0 ? (
            <p>You don't belong to any Workspace yet. Ask a Workspace Admin or a Platform Admin to add you.</p>
          ) : (
            <ul>
              {session.me.workspaces.map((workspace) => (
                <li key={workspace.id}>{workspace.name}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </main>
  );
}
