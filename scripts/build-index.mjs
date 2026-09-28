#!/usr/bin/env node
// Generates index.html — the gallery of client previews.
// Runs at server start (see package.json) and can be run locally:
//   node scripts/build-index.mjs
//
// One card per PROJECT: each top-level .html file, and each top-level folder
// that contains HTML (linked to that folder's primary page). Variant/working
// files inside a folder (print or source versions, alternate .dc.html cuts,
// uploads/assets) are not listed separately.

import { readdir, stat, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep, basename } from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const OUTPUT = "index.html";
// Directories that never hold a listable preview on their own.
const IGNORE_DIRS = new Set([
  ".git",
  ".github",
  "node_modules",
  "scripts",
  "uploads",
  "assets",
  "screenshots",
  "pdf-pages",
]);

// Per-project display overrides. Key = the project's path (a root-level .html
// file, or a top-level folder name). Example:
//   "highbury-vintners": { title: "Highbury Vintners", description: "..." }
const META_OVERRIDES = {};

// ---- naming --------------------------------------------------------------

const KNOWN_ACRONYMS = new Set([
  "PDP", "PLP", "CTA", "FAQ", "SEO", "UI", "UX", "P2S", "BLK", "BOX",
]);
const SMALL_WORDS = new Set([
  "a", "an", "and", "at", "by", "for", "in", "of", "on", "the", "to", "vs", "with",
]);
// Trailing tokens that are export/version noise, dropped from the end.
const NOISE_WORDS = new Set([
  "standalone", "source", "bundled", "bundle", "export", "copy",
]);

function cleanBase(name) {
  return name.replace(/\.html$/i, "").replace(/\.dc$/i, "");
}

// Turn a folder or file name into a clean, consistent display title.
function prettify(rawName) {
  const tokens = cleanBase(rawName).split(/[-_\s]+/).filter(Boolean);
  while (
    tokens.length > 1 &&
    NOISE_WORDS.has(tokens[tokens.length - 1].toLowerCase())
  ) {
    tokens.pop();
  }
  return tokens
    .map((t, i) => {
      const upper = t.toUpperCase();
      if (KNOWN_ACRONYMS.has(upper)) return upper; // pdp -> PDP, blk -> BLK
      if (/^[A-Z0-9]{2,}$/.test(t)) return t; // already an acronym / brand
      if (/^v?\d+$/i.test(t)) return t.toLowerCase(); // v2, 2024
      if (/[a-z]/.test(t) && /[A-Z]/.test(t.slice(1))) return t; // camelCase
      const lower = t.toLowerCase();
      if (i > 0 && SMALL_WORDS.has(lower)) return lower; // keep small words lower
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

// ---- project discovery ---------------------------------------------------

// Rank candidate pages within a folder; the primary page is the highest score.
function scoreCandidate(absPath, isTopLevel) {
  const b = basename(absPath).toLowerCase();
  let score = isTopLevel ? 10 : 0;
  if (b === "index.html") score += 100;
  else if (b.endsWith(".dc.html")) score += 30;
  else if (b.endsWith(".html")) score += 50;
  // Working / variant files are poor choices to show a client.
  if (/print/.test(b)) score -= 60;
  if (/standalone source|-source-|\bsource\b/.test(b)) score -= 40;
  if (/archive/.test(b)) score -= 30;
  if (/\boptions\b/.test(b)) score -= 10;
  return score;
}

async function htmlFilesIn(dir) {
  const out = [];
  async function rec(d, depth) {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (IGNORE_DIRS.has(e.name)) continue;
      const full = join(d, e.name);
      if (e.isDirectory()) await rec(full, depth + 1);
      else if (e.isFile() && e.name.toLowerCase().endsWith(".html"))
        out.push({ full, depth });
    }
  }
  await rec(dir, 0);
  return out;
}

async function pickPrimary(dir) {
  const files = await htmlFilesIn(dir);
  if (!files.length) return null;
  files.sort(
    (a, b) =>
      scoreCandidate(a.full, a.depth === 0) -
      scoreCandidate(b.full, b.depth === 0)
  );
  return files[files.length - 1].full;
}

async function collectProjects() {
  const projects = [];
  for (const e of await readdir(ROOT, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = join(ROOT, e.name);
    if (e.isFile()) {
      if (!e.name.toLowerCase().endsWith(".html")) continue;
      if (e.name === OUTPUT) continue;
      projects.push({ key: e.name, primary: full });
    } else if (e.isDirectory()) {
      const primary = await pickPrimary(full);
      if (primary) projects.push({ key: e.name, primary });
    }
  }
  return projects;
}

// ---- metadata ------------------------------------------------------------

function gitDate(relPath) {
  try {
    const ts = execSync(`git log -1 --format=%cI -- "${relPath}"`, {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (ts) return new Date(ts);
  } catch {
    /* not a git repo or file untracked — fall back to mtime */
  }
  return null;
}

function formatDate(d) {
  return d.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Encode each path segment so spaces/specials in folder names make a valid URL.
function hrefFor(absPath) {
  return relative(ROOT, absPath).split(sep).map(encodeURIComponent).join("/");
}

async function describe(project) {
  const override = META_OVERRIDES[project.key] || {};
  const relPrimary = relative(ROOT, project.primary).split(sep).join("/");
  const st = await stat(project.primary);
  const date = gitDate(relPrimary) || st.mtime;

  let description = override.description || "";
  if (!description) {
    const fh = await readFile(project.primary, { encoding: "utf8", flag: "r" }).catch(
      () => ""
    );
    const m = fh
      .slice(0, 4000)
      .match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    if (m) description = m[1];
  }

  return {
    href: hrefFor(project.primary),
    title: override.title || prettify(project.key),
    description,
    date,
    dateLabel: formatDate(date),
  };
}

// ---- render --------------------------------------------------------------

function renderCard(p) {
  const desc = p.description
    ? `<p class="card-desc">${escapeHtml(p.description)}</p>`
    : "";
  return `      <a class="card" href="${escapeHtml(p.href)}">
        <div class="card-body">
          <h2 class="card-title">${escapeHtml(p.title)}</h2>
          ${desc}
        </div>
        <div class="card-meta">
          <span>${escapeHtml(p.dateLabel)}</span>
          <span class="view">View &rarr;</span>
        </div>
      </a>`;
}

function renderPage(previews) {
  const cards = previews.map(renderCard).join("\n");
  const count = previews.length;
  const countLabel = count === 1 ? "1 preview" : `${count} previews`;
  const empty = `      <div class="empty">
        <p>No previews yet.</p>
        <p class="empty-sub">Add an <code>.html</code> file or a folder of previews and push — it will appear here automatically.</p>
      </div>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Glaze Digital — Client Previews</title>
  <meta name="description" content="Live previews shared by Glaze Digital." />
  <style>
    :root {
      --bg: #0f1115;
      --panel: #171a21;
      --panel-hover: #1d212b;
      --border: #262b36;
      --text: #e7eaf0;
      --muted: #9aa3b2;
      --accent: #6ea8fe;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    .wrap { max-width: 1120px; margin: 0 auto; padding: 56px 24px 80px; }
    header { margin-bottom: 36px; }
    .brand {
      font-size: 13px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--accent);
      font-weight: 600;
      margin: 0 0 10px;
    }
    h1 { font-size: 30px; margin: 0 0 8px; font-weight: 650; }
    .sub { color: var(--muted); margin: 0; font-size: 15px; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(230px, 1fr));
      gap: 16px;
      margin-top: 8px;
    }
    .card {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 14px;
      min-height: 118px;
      text-decoration: none;
      color: inherit;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px 20px;
      transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
    }
    .card:hover {
      background: var(--panel-hover);
      border-color: #34506e;
      transform: translateY(-1px);
    }
    .card-title {
      font-size: 16px;
      margin: 0;
      font-weight: 600;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .card-desc {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 13.5px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .card-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--muted);
    }
    .view { margin-left: auto; color: var(--accent); font-weight: 600; }
    .empty {
      text-align: center;
      padding: 60px 20px;
      border: 1px dashed var(--border);
      border-radius: 12px;
      color: var(--muted);
    }
    .empty-sub { font-size: 14px; }
    code { background: #20242e; padding: 2px 6px; border-radius: 5px; font-size: 13px; }
    footer { margin-top: 48px; color: var(--muted); font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <p class="brand">Glaze Digital</p>
      <h1>Client Previews</h1>
      <p class="sub">${countLabel}</p>
    </header>
    <main class="grid">
${count ? cards : empty}
    </main>
    <footer>
      Updated automatically on each push.
    </footer>
  </div>
</body>
</html>
`;
}

async function main() {
  const projects = await collectProjects();
  const previews = (await Promise.all(projects.map(describe))).sort(
    (a, b) => b.date - a.date
  );
  await writeFile(join(ROOT, OUTPUT), renderPage(previews), "utf8");
  console.log(
    `Generated ${OUTPUT} with ${previews.length} preview(s):` +
      (previews.length
        ? "\n  - " + previews.map((p) => `${p.title}  ->  ${p.href}`).join("\n  - ")
        : " (none)")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
