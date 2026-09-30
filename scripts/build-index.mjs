#!/usr/bin/env node
// Generates index.html (the gallery) and previews.json (the slug manifest the
// server uses for clean URLs). Runs at server start (see package.json) and can
// be run locally:  node scripts/build-index.mjs
//
// One card per PROJECT: each top-level .html file, and each top-level folder
// that contains HTML (linked to that folder's primary page). Each project gets
// a clean slug, served by server.js at /<slug>/ .

import { readdir, stat, readFile, writeFile } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, relative, sep, basename } from "node:path";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const OUTPUT = "index.html";
const MANIFEST = "previews.json";
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
// file, or a top-level folder name). Set an exact title and/or slug here:
//   "chamber13-pdp": { title: "Chamber 13 — PDP", slug: "chamber-13" }
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
  let tokens = cleanBase(rawName).split(/[-_\s]+/).filter(Boolean);
  while (
    tokens.length > 1 &&
    NOISE_WORDS.has(tokens[tokens.length - 1].toLowerCase())
  ) {
    tokens.pop();
  }
  // Split letter+digit runs so "chamber13" reads as "Chamber 13".
  tokens = tokens.flatMap((t) =>
    /^[A-Za-z]+\d+$/.test(t) ? t.match(/[A-Za-z]+|\d+/g) : [t]
  );
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

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
      projects.push({ key: e.name, primary: full, isFolder: false, base: "" });
    } else if (e.isDirectory()) {
      const primary = await pickPrimary(full);
      if (primary) projects.push({ key: e.name, primary, isFolder: true, base: e.name });
    }
  }
  return projects;
}

// ---- metadata ------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readDescription(project) {
  const override = META_OVERRIDES[project.key] || {};
  if (override.description) return override.description;
  const fh = await readFile(project.primary, { encoding: "utf8", flag: "r" }).catch(
    () => ""
  );
  const m = fh
    .slice(0, 4000)
    .match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return m ? m[1] : "";
}

// When the project (folder or root file) was first committed — its upload time.
// Requires git history; empty when unavailable (e.g. runtime container).
function gitAddedDate(project) {
  const target = project.isFolder ? project.base : project.key;
  try {
    const out = execSync(
      `git log --diff-filter=A --format=%cI -- "${target}"`,
      { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }
    )
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
    if (out.length) return out[out.length - 1]; // earliest add
  } catch {
    /* no git history available */
  }
  return "";
}

// Previous manifest, so committed upload dates survive runtime rebuilds where
// git history is absent (keyed by primary path, which is stable).
function previousDates() {
  const map = new Map();
  try {
    const prev = JSON.parse(readFileSync(join(ROOT, MANIFEST), "utf8"));
    for (const p of prev) if (p.primary && p.added) map.set(p.primary, p.added);
  } catch {
    /* no previous manifest */
  }
  return map;
}

// ---- render --------------------------------------------------------------

function renderCard(p) {
  const thumb = p.thumb
    ? `<img class="shot" src="${escapeHtml(p.thumb)}" alt="" loading="lazy" />`
    : `<iframe class="shot live" src="/${escapeHtml(p.slug)}/" loading="lazy" scrolling="no" tabindex="-1" aria-hidden="true"></iframe>`;
  return `      <a class="card" href="/${escapeHtml(p.slug)}/">
        <div class="thumb">${thumb}</div>
        <div class="card-body">
          <h2 class="card-title">${escapeHtml(p.title)}</h2>
        </div>
        <div class="card-meta">
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
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 18px;
      margin-top: 8px;
    }
    .card {
      display: flex;
      flex-direction: column;
      text-decoration: none;
      color: inherit;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
    }
    .card:hover {
      background: var(--panel-hover);
      border-color: #34506e;
      transform: translateY(-1px);
    }
    .thumb {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 10;
      overflow: hidden;
      background: #0b0d11;
      border-bottom: 1px solid var(--border);
    }
    .shot {
      position: absolute;
      top: 0;
      left: 0;
      border: 0;
      pointer-events: none;
    }
    img.shot { width: 100%; height: 100%; object-fit: cover; object-position: top; }
    iframe.shot.live {
      width: 1280px;
      height: 800px;
      transform-origin: top left;
      background: #fff;
    }
    .card-body { padding: 14px 16px 4px; }
    .card-title {
      font-size: 15px;
      margin: 0;
      font-weight: 600;
      line-height: 1.3;
      overflow-wrap: anywhere;
    }
    .card-meta {
      display: flex;
      align-items: center;
      padding: 6px 16px 14px;
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
  <script>
    // Scale each live-iframe thumbnail to its card width (1280px design width).
    function fitThumbs() {
      document.querySelectorAll("iframe.shot.live").forEach(function (f) {
        var w = f.parentElement.clientWidth;
        f.style.transform = "scale(" + w / 1280 + ")";
      });
    }
    window.addEventListener("resize", fitThumbs);
    window.addEventListener("load", fitThumbs);
    fitThumbs();
  </script>
</body>
</html>
`;
}

async function main() {
  const projects = await collectProjects();
  const prevDates = previousDates();

  const used = new Set();
  const previews = [];
  for (const project of projects) {
    const override = META_OVERRIDES[project.key] || {};
    const title = override.title || prettify(project.key);
    let slug = slugify(override.slug || title) || "preview";
    if (used.has(slug)) {
      let n = 2;
      while (used.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    used.add(slug);

    const primary = relative(ROOT, project.primary).split(sep).join("/");
    const added =
      gitAddedDate(project) ||
      prevDates.get(primary) ||
      (await stat(project.primary)).mtime.toISOString();
    const thumbPath = `thumbnails/${slug}.jpg`;
    const thumb = existsSync(join(ROOT, thumbPath)) ? thumbPath : null;

    previews.push({
      slug,
      title,
      description: await readDescription(project),
      primary,
      base: project.base,
      isFolder: project.isFolder,
      added,
      thumb,
    });
  }

  // Latest uploaded first.
  previews.sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0));

  await writeFile(join(ROOT, OUTPUT), renderPage(previews), "utf8");
  await writeFile(
    join(ROOT, MANIFEST),
    JSON.stringify(
      previews.map(({ slug, title, primary, base, isFolder, added, thumb }) => ({
        slug,
        title,
        primary,
        base,
        isFolder,
        added,
        thumb,
      })),
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(
    `Generated ${OUTPUT} + ${MANIFEST} with ${previews.length} preview(s):` +
      (previews.length
        ? "\n  - " +
          previews
            .map(
              (p) =>
                `/${p.slug}/  (${p.added.slice(0, 10)}, ${p.thumb ? "shot" : "live"})`
            )
            .join("\n  - ")
        : " (none)")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
