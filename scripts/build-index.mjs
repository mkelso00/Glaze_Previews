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
const META_OVERRIDES = {
  "warren-evans-blk-friday-v3": { title: "Warren Evans — Black Friday V3" },
  "we-black-friday-v2": { title: "Warren Evans — Black Friday V2" },
  "we-blk-friday-homepage": { title: "Warren Evans — Black Friday Homepage" },
  "Warren-Evans-Black-Friday-Examples": { title: "Warren Evans — Black Friday Examples" },
  "warren-evans-upsell-idea": { title: "Warren Evans — Upsell Idea" },
  "bed-builder-v2": { title: "Bed Builder V2" },
  "Current vs proposed – one board for preview-html": { title: "Current vs Proposed — One Board" },
  "improvments-to-pdp": { title: "PDP Improvements" },
  "Kombucha-brand-landing-pages": { title: "Kombucha — Brand Landing Pages" },
  "kombucha-keyword-rich-lp": { title: "Kombucha — Keyword-Rich LP" },
  "drink-landing-page": { title: "Kombucha — Landing Page" },
  "roadstone-shopify-order-builder": { title: "Roadstone — Order Builder" },
  "l&l-xmaspage": { title: "L&L — Christmas Page" },
  "ieknnit-pdp-design": { title: "Ieknnit — PDP Design" },
  "Charitie-marketplace": { title: "Charitie — Marketplace" },
  "dougies-goodies-packing-slip": { title: "Dougies Goodies — Packing Slip" },
  "p2s-design": { title: "Power to Switch — Design" },
  "blk-box-gym-designer": { title: "BLK BOX — Gym Designer" },
  "blk-box-product-rail": { title: "BLK BOX — Product Rail" },
  "blk-box-updates": { title: "BLK BOX — Updates" },
  "blog-product-integration": { title: "BLK BOX — Blog Product Blocks" },
  "Drinkallabout - Long Description Options": { title: "Drinkallabout — Long Description Options" },
  "Dumbell-selection": { title: "Dumbbell Selector" },
  "Skingredients-Christmas-Landing-Page": { title: "Skingredients — Christmas Landing Page" },
  "chamber13-pdp": { title: "Chamber 13 — PDP" },
  "equi-landing-page": { title: "Equi — Landing Page" },
  "highbury-vintners": { title: "Highbury Vintners" },
  "house-of-joppa-audit": { title: "House of Joppa — Audit" },
  "irelands-eye-passport": { title: "Ireland's Eye — Passport" },
  "skin-nerd-calendar": { title: "Skin Nerd — Advent Calendar" },
};

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

// The distinct, client-facing pages in a folder: top-level .html files, minus
// print/source variants, minus the .dc.html twin when a rendered .html exists.
async function meaningfulPages(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  let names = entries
    .filter(
      (e) =>
        e.isFile() &&
        !e.name.startsWith(".") &&
        e.name.toLowerCase().endsWith(".html")
    )
    .map((e) => e.name)
    .filter(
      (n) => !/print/i.test(n) && !/standalone source|-source-/i.test(n)
    );

  // Prefer a rendered X.html over its X.dc.html twin.
  const byBase = new Map();
  for (const n of names) {
    const base = cleanBase(n).toLowerCase();
    const isDc = /\.dc\.html$/i.test(n);
    const cur = byBase.get(base);
    if (!cur || (/\.dc\.html$/i.test(cur) && !isDc)) byBase.set(base, n);
  }
  let pages = [...byBase.values()]
    .sort((a, b) => a.localeCompare(b))
    .map((n) => join(dir, n));

  // Nothing at the top level — fall back to the single best page anywhere.
  if (!pages.length) {
    const rec = await htmlFilesIn(dir);
    if (rec.length) pages = [rec[0].full];
  }
  return pages;
}

// One entry per client-facing page. A folder with several pages yields several
// entries (each carrying the project + page title); a single-page folder or a
// root-level file yields one.
async function collectPreviews() {
  const out = [];
  for (const e of await readdir(ROOT, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = join(ROOT, e.name);
    if (e.isFile()) {
      if (!e.name.toLowerCase().endsWith(".html")) continue;
      if (e.name === OUTPUT) continue;
      out.push({ base: "", primary: full, projectTitle: prettify(e.name), pageTitle: null });
    } else if (e.isDirectory()) {
      const pages = await meaningfulPages(full);
      const multi = pages.length > 1;
      for (const pg of pages) {
        // In a multi-page folder, index.html is the project's main page (no
        // "— Page" suffix); other pages carry their own name.
        const isIndex = basename(pg).toLowerCase() === "index.html";
        out.push({
          base: e.name,
          primary: pg,
          projectTitle: prettify(e.name),
          pageTitle: multi && !isIndex ? prettify(basename(pg)) : null,
        });
      }
    }
  }
  return out;
}

// ---- metadata ------------------------------------------------------------

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function readDescription(primary, override) {
  if (override.description) return override.description;
  const fh = await readFile(primary, { encoding: "utf8", flag: "r" }).catch(
    () => ""
  );
  const m = fh
    .slice(0, 4000)
    .match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return m ? m[1] : "";
}

// When a page was first committed — its upload time. Requires git history;
// empty when unavailable (e.g. the runtime container).
function gitAddedDate(relPath) {
  try {
    const out = execSync(
      `git log --diff-filter=A --format=%cI -- "${relPath}"`,
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
    const pages = Array.isArray(prev) ? prev : prev.pages || [];
    for (const p of pages) if (p.primary && p.added) map.set(p.primary, p.added);
  } catch {
    /* no previous manifest */
  }
  return map;
}

// ---- render --------------------------------------------------------------

function renderRow(f) {
  const href = f.count === 1 ? `/${f.items[0].slug}/` : `/f/${f.fslug}/`;
  const meta =
    f.count > 1 ? `<span class="badge">${f.count} designs</span>` : "";
  return `      <a class="row" href="${escapeHtml(href)}">
        <span class="row-name">${escapeHtml(f.ftitle)}</span>
        <span class="row-meta">${meta}<span class="chev">&rarr;</span></span>
      </a>`;
}

function renderPage(folders) {
  const rows = folders.map(renderRow).join("\n");
  const count = folders.length;
  const countLabel = count === 1 ? "1 project" : `${count} projects`;
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
    .wrap { max-width: 760px; margin: 0 auto; padding: 56px 24px 80px; }
    header { margin-bottom: 28px; }
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
    .list {
      margin-top: 18px;
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      background: var(--panel);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 14px;
      padding: 15px 18px;
      text-decoration: none;
      color: inherit;
      border-top: 1px solid var(--border);
      transition: background 0.12s ease;
    }
    .row:first-child { border-top: 0; }
    .row:hover { background: var(--panel-hover); }
    .row-name { font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
    .row-meta { margin-left: auto; display: flex; align-items: center; gap: 12px; }
    .badge {
      background: #1d222c; border: 1px solid #2a3140; color: var(--muted);
      font-size: 12px; font-weight: 600; padding: 3px 9px; border-radius: 999px; white-space: nowrap;
    }
    .chev { color: var(--muted); font-size: 16px; }
    .row:hover .chev { color: var(--accent); }
    .empty {
      text-align: center;
      padding: 60px 20px;
      border: 1px dashed var(--border);
      border-radius: 12px;
      color: var(--muted);
    }
    .empty-sub { font-size: 14px; }
    code { background: #20242e; padding: 2px 6px; border-radius: 5px; font-size: 13px; }
    footer { margin-top: 40px; color: var(--muted); font-size: 13px; }
  </style>
</head>
<body>
  <div class="wrap">
    <header>
      <p class="brand">Glaze Digital</p>
      <h1>Client Previews</h1>
      <p class="sub">${countLabel}</p>
    </header>
    <main>
      ${count ? `<div class="list">\n${rows}\n      </div>` : empty}
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
  const items = await collectPreviews();
  const prevDates = previousDates();

  const used = new Set();
  const previews = [];
  for (const it of items) {
    const primary = relative(ROOT, it.primary).split(sep).join("/");
    const folderOv = (it.base && META_OVERRIDES[it.base]) || {};
    const pageOv = META_OVERRIDES[primary] || {};

    // Raw names drive the slug (stable URLs); display titles can be overridden.
    const rawProject = it.projectTitle;
    const dispProject = folderOv.title || rawProject;
    const hasPage =
      it.pageTitle && slugify(it.pageTitle) !== slugify(rawProject);

    let slugBase = hasPage ? `${rawProject} ${it.pageTitle}` : rawProject;
    let slug = slugify(pageOv.slug || slugBase) || "preview";
    if (used.has(slug)) {
      let n = 2;
      while (used.has(`${slug}-${n}`)) n++;
      slug = `${slug}-${n}`;
    }
    used.add(slug);

    let title = hasPage ? `${dispProject} — ${it.pageTitle}` : dispProject;
    if (pageOv.title) title = pageOv.title;

    const added =
      gitAddedDate(primary) ||
      prevDates.get(primary) ||
      (await stat(it.primary)).mtime.toISOString();
    const thumbPath = `thumbnails/${slug}.jpg`;
    const thumb = existsSync(join(ROOT, thumbPath)) ? thumbPath : null;

    previews.push({
      slug,
      title,
      folderTitle: dispProject,
      folderSlugBase: rawProject,
      pageTitle: it.pageTitle,
      description: await readDescription(it.primary, pageOv),
      primary,
      base: it.base,
      added,
      thumb,
    });
  }

  // Latest uploaded first (pages).
  previews.sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0));

  // Group pages into folders. Root-level files are each their own folder.
  const groups = new Map();
  for (const p of previews) {
    const key = p.base ? `d:${p.base}` : `f:${p.slug}`;
    if (!groups.has(key)) {
      groups.set(key, {
        ftitle: p.folderTitle || p.title,
        fslugBase: p.folderSlugBase || p.title,
        items: [],
      });
    }
    groups.get(key).items.push(p);
  }

  const usedF = new Set();
  const folders = [];
  for (const g of groups.values()) {
    g.items.sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0));
    const added = g.items.reduce((m, p) => (p.added > m ? p.added : m), "");
    let fslug = slugify(g.fslugBase) || "folder";
    if (usedF.has(fslug)) {
      let n = 2;
      while (usedF.has(`${fslug}-${n}`)) n++;
      fslug = `${fslug}-${n}`;
    }
    usedF.add(fslug);
    folders.push({
      fslug,
      ftitle: g.ftitle,
      added,
      count: g.items.length,
      items: g.items.map((p) => ({
        slug: p.slug,
        title: p.pageTitle || p.title,
        thumb: p.thumb,
      })),
    });
  }
  // Latest-added folder first (not alphabetical).
  folders.sort((a, b) => (a.added < b.added ? 1 : a.added > b.added ? -1 : 0));

  await writeFile(join(ROOT, OUTPUT), renderPage(folders), "utf8");
  await writeFile(
    join(ROOT, MANIFEST),
    JSON.stringify(
      {
        pages: previews.map(({ slug, title, primary, base, added, thumb }) => ({
          slug,
          title,
          primary,
          base,
          added,
          thumb,
        })),
        folders,
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(
    `Generated ${OUTPUT} + ${MANIFEST}: ${folders.length} folder(s), ${previews.length} page(s):` +
      (folders.length
        ? "\n  - " +
          folders
            .map(
              (f) =>
                `${f.ftitle}  (${f.added.slice(0, 10)}, ${f.count} design${f.count > 1 ? "s" : ""})`
            )
            .join("\n  - ")
        : " (none)")
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
