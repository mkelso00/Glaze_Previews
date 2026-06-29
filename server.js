// Minimal zero-dependency static server for hosting HTML previews.
//
// Railway's default static serving injects a restrictive Content-Security-Policy
// that blocks the blob:/data: URLs and new Function() eval that Claude Code
// "bundled page" exports rely on, so previews render blank. This server serves
// the same files with a CSP that permits exactly what those bundles need, while
// still blocking plugins/framing of untrusted origins.

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/\/+$/, "");
const PORT = process.env.PORT || 3000;

// CSP validated against the bundled-page format: scripts need 'unsafe-eval'
// (the runtime uses new Function()) plus blob:/data:; fonts/images/media/styles
// are delivered as blob: URLs unpacked at runtime.
const CSP = [
  "default-src 'self'",
  "img-src 'self' data: blob: https: *",
  "style-src 'self' 'unsafe-inline' data: blob: https: *",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: *",
  "font-src 'self' data: blob: https: *",
  "connect-src 'self' data: blob: https: *",
  "media-src 'self' data: blob: https: *",
  "object-src 'none'",
  "frame-src 'self' https: *",
].join("; ");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ...headers,
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    // Decode and strip query/hash, default "/" to the gallery index.
    let pathname = decodeURIComponent((req.url || "/").split("?")[0].split("#")[0]);
    if (pathname === "/" || pathname === "") pathname = "/index.html";

    // Resolve within ROOT and reject any traversal outside it.
    const filePath = normalize(join(ROOT, pathname));
    if (filePath !== ROOT && !filePath.startsWith(ROOT + "/")) {
      return send(res, 403, "Forbidden", { "Content-Type": "text/plain" });
    }

    let info;
    try {
      info = await stat(filePath);
    } catch {
      return send(res, 404, "Not found", { "Content-Type": "text/plain" });
    }
    if (info.isDirectory()) {
      return send(res, 404, "Not found", { "Content-Type": "text/plain" });
    }

    const type = TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
    const headers = {
      "Content-Type": type,
      "Content-Length": info.size,
      "Last-Modified": info.mtime.toUTCString(),
      "Cache-Control": "public, max-age=300",
    };

    if (req.method === "HEAD") {
      res.writeHead(200, {
        "Content-Security-Policy": CSP,
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "strict-origin-when-cross-origin",
        ...headers,
      });
      return res.end();
    }

    res.writeHead(200, {
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      ...headers,
    });
    createReadStream(filePath).pipe(res);
  } catch (err) {
    console.error("Request error:", err);
    send(res, 500, "Internal server error", { "Content-Type": "text/plain" });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Glaze Previews server listening on :${PORT}`);
});
