import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { Context } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves the web package's build output. Paths without a file extension are client-side routes and get index.html;
 * a missing file with an extension is a 404, so a broken asset link fails visibly instead of returning HTML.
 */
export function webUiHandler(distDir: string) {
  const root = resolve(distDir);
  const indexHtml = resolve(root, "index.html");

  return async (c: Context) => {
    let requested: string;
    try {
      requested = decodeURIComponent(new URL(c.req.url).pathname);
    } catch {
      return c.notFound();
    }
    const candidate = resolve(root, `.${requested}`);
    if (candidate !== root && !candidate.startsWith(root + sep)) {
      return c.notFound();
    }

    let file: string;
    if (await isFile(candidate)) {
      file = candidate;
    } else if (extname(candidate) === "" && (await isFile(indexHtml))) {
      file = indexHtml;
    } else {
      return c.notFound();
    }

    const body = await readFile(file);
    return c.body(body, 200, {
      "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
    });
  };
}
