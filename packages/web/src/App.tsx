import { useEffect, useState } from "react";
import type { HealthResponse } from "@mcp-gateway/server/api";

/** Empty shell: later tickets add sign-in and Workspace screens. */
export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    fetch("/health")
      .then((response) => response.json() as Promise<HealthResponse>)
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  return (
    <main style={{ fontFamily: "system-ui, sans-serif", padding: "2rem" }}>
      <h1>mcp-gateway</h1>
      <p>Gateway: {health ? `${health.status} (database ${health.database})` : "checking…"}</p>
    </main>
  );
}
