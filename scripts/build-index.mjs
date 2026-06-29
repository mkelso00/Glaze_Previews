#!/usr/bin/env node
// Generates index.html — a gallery of all HTML previews in the repo.
// Runs in CI (see .github/workflows/pages.yml) and can be run locally:
//   node scripts/build-index.mjs
//
// It scans the repo for .html files (excluding index.html and anything
// under ignored dirs), then writes a styled gallery linking to each one.

import { readdir, stat, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const IGNORE_DIRS = new Set([".git", ".github", "node_modules", "scripts"]);
const OUTPUT = "index.html";

// Optional metadata overrides. Add an entry keyed by the file path
// (relative to repo root) to control how a preview appears in the gallery:
//   "Backyard-movie-nights.html": { title: "Backyard Movie Nights", description: "..." }
const META_OVERRIDES = {};

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.isDirectory()) continue;
    if (IGNORE_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".html")) {
      if (relative(ROOT, full) === OUTPUT) continue;
      out.push(full);
    }
  }
  return out;
}

function prettifyName(relPath) {
  const base = relPath.split(sep).pop().replace(/\.html$/i, "");
  const words = base.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return words.replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

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

async function describe(file) {
  const relPath = relative(ROOT, file).split(sep).join("/");
  const override = META_OVERRIDES[relPath] || {};
  const st = await stat(file);
  const date = gitDate(relPath) || st.mtime;

  let description = override.description || "";
  if (!description) {
    // Cheaply read just the head of the file to look for a meta description.
    const fh = await readFile(file, { encoding: "utf8", flag: "r" }).catch(
      () => ""
    );
    const head = fh.slice(0, 4000);
    const m = head.match(
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
    );
    if (m) description = m[1];
  }

  return {
    href: relPath,
    title: override.title || prettifyName(relPath),
    description,
    size: humanSize(st.size),
    date,
    dateLabel: formatDate(date),
  };
}

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
          <span class="dot"></span>
          <span>${escapeHtml(p.size)}</span>
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
        <p class="empty-sub">Add an <code>.html</code> file to the repo and push — it will appear here automatically.</p>
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
    .wrap { max-width: 920px; margin: 0 auto; padding: 56px 24px 80px; }
    header { margin-bottom: 40px; }
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
    .grid { display: grid; gap: 14px; margin-top: 8px; }
    .card {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 16px;
      text-decoration: none;
      color: inherit;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 22px;
      transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
    }
    .card:hover {
      background: var(--panel-hover);
      border-color: #34506e;
      transform: translateY(-1px);
    }
    .card-title { font-size: 18px; margin: 0; font-weight: 600; }
    .card-desc { margin: 6px 0 0; color: var(--muted); font-size: 14px; }
    .card-meta {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--muted);
    }
    .dot { width: 3px; height: 3px; border-radius: 50%; background: var(--muted); }
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
    a.footlink { color: var(--accent); text-decoration: none; }
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
  const files = await walk(ROOT);
  const previews = (await Promise.all(files.map(describe))).sort(
    (a, b) => b.date - a.date
  );
  await writeFile(join(ROOT, OUTPUT), renderPage(previews), "utf8");
  console.log(
    `Generated ${OUTPUT} with ${previews.length} preview(s):` +
      (previews.length
        ? "\n  - " + previews.map((p) => p.href).join("\n  - ")
        : " (none)")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
