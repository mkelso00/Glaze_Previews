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
import { createHash, timingSafeEqual } from "node:crypto";

const ROOT = fileURLToPath(new URL(".", import.meta.url)).replace(/\/+$/, "");
const PORT = process.env.PORT || 3000;

// Password gate for the gallery index. Set PREVIEW_PASSWORD on Railway to keep
// the password out of this (public) repo; falls back to a default so it works
// without configuration.
const PASSWORD = process.env.PREVIEW_PASSWORD || "glaze26";
const COOKIE_NAME = "gp_auth";
// Deterministic session token derived from the password — the cookie never
// contains the password itself, and a new password invalidates old cookies.
const AUTH_TOKEN = createHash("sha256")
  .update(PASSWORD + "::glaze-previews-v1")
  .digest("hex");
// Only the gallery is gated; individual preview files stay reachable by their
// (intentionally shared) direct links.
const GATED_PATHS = new Set(["/index.html"]);

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (!token || token.length !== AUTH_TOKEN.length) return false;
  try {
    return timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN));
  } catch {
    return false;
  }
}

function readBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", () => resolve(""));
  });
}

function loginPage(error) {
  const msg = error
    ? `<p class="err">Incorrect password. Try again.</p>`
    : "";
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Glaze Digital — Client Previews</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0f1115;color:#e7eaf0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .card{width:100%;max-width:340px;padding:36px 30px;background:#171a21;border:1px solid #262b36;border-radius:14px;text-align:center}
  .brand{font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#6ea8fe;font-weight:600;margin:0 0 6px}
  h1{font-size:20px;margin:0 0 22px;font-weight:600}
  input{width:100%;padding:11px 13px;font-size:15px;color:#e7eaf0;background:#0f1115;
    border:1px solid #262b36;border-radius:9px;margin-bottom:12px;outline:none}
  input:focus{border-color:#6ea8fe}
  button{width:100%;padding:11px;font-size:15px;font-weight:600;color:#0f1115;background:#6ea8fe;
    border:none;border-radius:9px;cursor:pointer}
  button:hover{background:#8bbcff}
  .err{color:#ff8a80;font-size:13px;margin:0 0 12px}
</style></head>
<body>
  <form class="card" method="POST" action="/__auth">
    <p class="brand">Glaze Digital</p>
    <h1>Client Previews</h1>
    ${msg}
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password" required>
    <button type="submit">View previews</button>
  </form>
</body></html>`;
}

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

    // Login form submission for the gallery gate.
    if (req.method === "POST" && pathname === "/__auth") {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      const ok =
        (params.get("password") || "") === PASSWORD && PASSWORD.length > 0;
      if (ok) {
        const secure =
          (req.headers["x-forwarded-proto"] || "").split(",")[0].trim() ===
          "https";
        return send(res, 303, null, {
          Location: "/",
          "Set-Cookie": `${COOKIE_NAME}=${AUTH_TOKEN}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure ? "; Secure" : ""}`,
        });
      }
      return send(res, 401, loginPage(true), {
        "Content-Type": "text/html; charset=utf-8",
      });
    }

    if (pathname === "/" || pathname === "") pathname = "/index.html";

    // Gate the gallery: serve the login form unless the visitor is authed.
    if (GATED_PATHS.has(pathname) && !isAuthed(req)) {
      if (req.method === "HEAD") {
        return send(res, 401, null, { "Content-Type": "text/html; charset=utf-8" });
      }
      return send(res, 401, loginPage(false), {
        "Content-Type": "text/html; charset=utf-8",
      });
    }

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
