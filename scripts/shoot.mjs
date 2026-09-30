#!/usr/bin/env node
// Regenerates the gallery thumbnails in thumbnails/<slug>.jpg by screenshotting
// each preview. This is a DEV/BUILD tool — it is NOT run on Railway (which has
// no browser). Run it after adding or changing previews, then commit the images.
//
// Prerequisites:
//   1. npm i -D playwright-core   (and a Chromium at $CHROMIUM or the default path)
//   2. A cdn/ dir with the libraries bundled previews load at runtime:
//        mkdir -p cdn
//        curl -sS https://unpkg.com/react@18.3.1/umd/react.production.min.js -o cdn/react.js
//        curl -sS https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js -o cdn/react-dom.js
//        curl -sS https://unpkg.com/@babel/standalone@7.26.4/babel.min.js -o cdn/babel.js
//   3. The server running:  PORT=3000 node server.js &   (build previews.json first)
//
// Usage:  node scripts/shoot.mjs [slug]        # all, or just one slug
//   env:  BASE (default http://127.0.0.1:3000), CDN_DIR (default ./cdn),
//         CHROMIUM (browser executablePath)

import { chromium } from "playwright-core";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const REPO = process.cwd();
const CDN = process.env.CDN_DIR || join(REPO, "cdn");
const BASE = process.env.BASE || "http://127.0.0.1:3000";
const EXE =
  process.env.CHROMIUM || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
const ONLY = process.argv[2];

const previews = JSON.parse(readFileSync(join(REPO, "previews.json"), "utf8"));
mkdirSync(join(REPO, "thumbnails"), { recursive: true });

const browser = await chromium.launch({ executablePath: EXE, args: ["--no-sandbox"] });

async function shoot(p) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  // Feed the CDN libs locally (the sandbox can't reach unpkg); drop other
  // external requests so a missing font never blocks the render.
  await ctx.route("**/*", (route) => {
    const u = route.request().url();
    if (u.startsWith(new URL(BASE).origin)) return route.continue();
    if (/unpkg\.com\/react-dom/.test(u))
      return route.fulfill({ path: join(CDN, "react-dom.js"), contentType: "text/javascript" });
    if (/unpkg\.com\/react/.test(u))
      return route.fulfill({ path: join(CDN, "react.js"), contentType: "text/javascript" });
    if (/babel/.test(u))
      return route.fulfill({ path: join(CDN, "babel.js"), contentType: "text/javascript" });
    return route.abort();
  });
  const page = await ctx.newPage();
  const raw = "/" + p.primary.split("/").map(encodeURIComponent).join("/");
  try {
    await page.goto(`${BASE}${raw}`, { waitUntil: "load", timeout: 45000 });
    await page.waitForTimeout(4500);
    await page.screenshot({
      path: join(REPO, "thumbnails", `${p.slug}.jpg`),
      type: "jpeg",
      quality: 72,
      clip: { x: 0, y: 0, width: 1280, height: 800 },
    });
    console.log(`  ok  ${p.slug}`);
  } catch (e) {
    console.log(`  !   ${p.slug}: ${String(e).slice(0, 80)}`);
  }
  await ctx.close();
}

for (const p of previews) {
  if (!ONLY || p.slug === ONLY) await shoot(p);
}
await browser.close();
console.log("done");
