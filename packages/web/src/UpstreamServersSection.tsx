import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  CredentialHeader,
  UpstreamServer,
  UpstreamServerDetail,
  UpstreamServerList,
} from "@mcp-gateway/server/api";
import { api, errorMessage } from "./api.ts";
import { cell, errorText, muted, row, table } from "./styles.ts";

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");
const fieldList = (text: string) => text.split(/[\s,;]+/).filter(Boolean);

/** A Workspace's Upstream Servers. Workspace Admins can register, rotate credentials and unregister. */
export function UpstreamServersSection({ workspaceId, isAdmin }: { workspaceId: string; isAdmin: boolean }) {
  const base = `/api/workspaces/${workspaceId}/servers`;
  const [servers, setServers] = useState<UpstreamServer[] | null>(null);
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();

  const load = useCallback(() => {
    api<UpstreamServerList>("GET", base)
      .then((list) => setServers(list.servers))
      .catch((e) => setError(errorMessage(e)));
  }, [base]);
  useEffect(load, [load]);

  const run = async (action: () => Promise<unknown>, done?: (result: unknown) => void) => {
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await action();
      done?.(result);
      load();
      return true;
    } catch (e) {
      setError(errorMessage(e));
      return false;
    }
  };

  /** Says how the connection attempt that came with a registration or credential change went. */
  const reportConnection = (result: unknown) => {
    const server = result as UpstreamServerDetail;
    setNotice(
      server.status === "online"
        ? `Connected to ${server.prefix}: found ${server.tools.length} tool(s), all pending approval.`
        : `Saved ${server.prefix}, but could not connect: ${server.lastError}`,
    );
    setOpen(server.id);
  };

  return (
    <section>
      <h3>Upstream Servers</h3>
      {error && (
        <p role="alert" style={errorText}>
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {isAdmin && (
        <RegisterServerForm
          onRegister={(body) => run(() => api<UpstreamServerDetail>("POST", base, body), reportConnection)}
        />
      )}
      {servers === null ? (
        <p>Loading…</p>
      ) : servers.length === 0 ? (
        <p>No Upstream Servers registered yet.</p>
      ) : (
        <table style={table}>
          <tbody>
            {servers.map((server) => (
              <tr key={server.id}>
                <td style={cell}>
                  <strong>{server.prefix}</strong> <span style={muted}>{server.url}</span>
                  <div>
                    <span style={{ color: server.status === "online" ? "#1b7f3b" : "#b00020" }}>● {server.status}</span>
                    <span style={muted}> · last contact {time(server.lastContactAt)}</span>
                  </div>
                  {server.lastError && <div style={errorText}>Last error: {server.lastError}</div>}
                  <button type="button" onClick={() => setOpen(open === server.id ? undefined : server.id)}>
                    {open === server.id ? "Hide details" : "Details"}
                  </button>
                  {open === server.id && (
                    <ServerDetails
                      path={`${base}/${server.id}`}
                      isAdmin={isAdmin}
                      run={run}
                      onCredentialReplaced={reportConnection}
                      onUnregistered={() => setOpen(undefined)}
                    />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

type Run = (action: () => Promise<unknown>, done?: (result: unknown) => void) => Promise<boolean>;

function ServerDetails({
  path,
  isAdmin,
  run,
  onCredentialReplaced,
  onUnregistered,
}: {
  path: string;
  isAdmin: boolean;
  run: Run;
  onCredentialReplaced: (result: unknown) => void;
  onUnregistered: () => void;
}) {
  const [server, setServer] = useState<UpstreamServerDetail | null>(null);
  const [sensitive, setSensitive] = useState("");
  const reload = useCallback(() => {
    api<UpstreamServerDetail>("GET", path).then((s) => {
      setServer(s);
      setSensitive(s.sensitiveFields.join(", "));
    });
  }, [path]);
  useEffect(reload, [reload]);

  if (!server) return <p>Loading…</p>;

  return (
    <div style={{ margin: "0.5rem 0 0.5rem 1rem" }}>
      <p style={muted}>
        Credential ({server.credential.mode}):{" "}
        {server.credential.headerNames.length === 0
          ? "no headers"
          : server.credential.headerNames.map((name) => `${name}: ••••••`).join(", ")}
      </p>

      <h4>Tools</h4>
      {server.tools.length === 0 ? (
        <p style={muted}>No tools discovered.</p>
      ) : (
        <ul>
          {server.tools.map((tool) => (
            <li key={tool.name}>
              <code>{tool.namespacedName}</code> <span style={muted}>({tool.approval})</span>
              {tool.description && <div>{tool.description}</div>}
              <details>
                <summary style={muted}>Input schema</summary>
                <pre style={{ fontSize: "0.8rem", overflowX: "auto" }}>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}

      {isAdmin && (
        <>
          <h4>Replace Shared Credential</h4>
          <HeadersForm
            submitLabel="Replace and reconnect"
            onSubmit={(headers) =>
              run(
                () => api("PUT", `${path}/credential`, { headers }),
                (result) => {
                  onCredentialReplaced(result);
                  reload();
                },
              )
            }
          />

          <h4>Sensitive argument fields</h4>
          <form
            style={row}
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => api("PATCH", path, { sensitiveFields: fieldList(sensitive) }), reload);
            }}
          >
            <input value={sensitive} onChange={(e) => setSensitive(e.target.value)} placeholder="e.g. iban, pin" />
            <button type="submit">Save</button>
          </form>

          <p>
            <button
              type="button"
              onClick={() => {
                if (window.confirm(`Unregister ${server.prefix}? Its tools disappear for everyone.`)) {
                  void run(() => api("DELETE", path), onUnregistered);
                }
              }}
            >
              Unregister
            </button>
          </p>
        </>
      )}
    </div>
  );
}

function RegisterServerForm({
  onRegister,
}: {
  onRegister: (body: { prefix: string; url: string; headers: CredentialHeader[]; sensitiveFields: string[] }) => Promise<boolean>;
}) {
  const [prefix, setPrefix] = useState("");
  const [url, setUrl] = useState("");
  const [sensitive, setSensitive] = useState("");

  return (
    <details style={{ marginBottom: "1rem" }}>
      <summary>Register an Upstream Server</summary>
      <div style={{ display: "grid", gap: "0.5rem", marginTop: "0.5rem" }}>
        <label>
          Server Prefix{" "}
          <input value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="github" pattern="[a-z0-9]+(_[a-z0-9]+)*" />
          <span style={muted}> lowercase letters, digits, single underscores; can't be changed later</span>
        </label>
        <label>
          Streamable HTTP URL{" "}
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/mcp" style={{ minWidth: "20rem" }} />
        </label>
        <label>
          Sensitive argument fields{" "}
          <input value={sensitive} onChange={(e) => setSensitive(e.target.value)} placeholder="optional, e.g. iban, pin" />
        </label>
        <HeadersForm
          submitLabel="Register and connect"
          onSubmit={async (headers) => {
            const ok = await onRegister({ prefix, url, headers, sensitiveFields: fieldList(sensitive) });
            if (ok) {
              setPrefix("");
              setUrl("");
              setSensitive("");
            }
            return ok;
          }}
        />
      </div>
    </details>
  );
}

/** Edits a list of credential headers. Values are typed in and never shown back. */
function HeadersForm({
  submitLabel,
  onSubmit,
}: {
  submitLabel: string;
  onSubmit: (headers: CredentialHeader[]) => Promise<boolean>;
}) {
  const [headers, setHeaders] = useState<CredentialHeader[]>([{ name: "Authorization", value: "" }]);
  const update = (i: number, change: Partial<CredentialHeader>) =>
    setHeaders(headers.map((h, j) => (j === i ? { ...h, ...change } : h)));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const filled = headers.filter((h) => h.name.trim() !== "" && h.value !== "");
    if (await onSubmit(filled)) setHeaders([{ name: "Authorization", value: "" }]);
  };

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: "0.4rem" }}>
      <span style={muted}>Shared Credential headers (sent on every request; values are write-only)</span>
      {headers.map((header, i) => (
        <span key={i} style={row}>
          <input value={header.name} onChange={(e) => update(i, { name: e.target.value })} placeholder="Header name" />
          <input
            type="password"
            autoComplete="off"
            value={header.value}
            onChange={(e) => update(i, { value: e.target.value })}
            placeholder="Value"
          />
          <button type="button" onClick={() => setHeaders(headers.filter((_, j) => j !== i))}>
            Remove
          </button>
        </span>
      ))}
      <span style={row}>
        <button type="button" onClick={() => setHeaders([...headers, { name: "", value: "" }])}>
          Add header
        </button>
        <button type="submit">{submitLabel}</button>
      </span>
    </form>
  );
}
