# Glaze Previews

Hosting for HTML previews shared with clients — including exports from Claude Code.

Every `.html` file in this repo is published to a public URL via GitHub Pages, and a
gallery index linking to all of them is generated automatically on each push.

## Live site

- **Gallery:** https://mkelso00.github.io/Glaze_Previews/
- **A specific preview:** https://mkelso00.github.io/Glaze_Previews/<file-name>.html

  e.g. https://mkelso00.github.io/Glaze_Previews/Backyard-movie-nights.html

> The Pages site is **public** — anyone with the link can view a preview. Don't put
> anything confidential here. (The links aren't listed publicly, but they aren't secret either.)

## Adding a new preview

1. Drop the `.html` file anywhere in the repo (root is fine).
2. Commit and push to `main`.
3. GitHub Actions rebuilds the gallery and redeploys (~1 minute). Share the link.

The gallery shows each preview with a name derived from its filename, its size, and the
date it was last updated. Use clear, hyphenated filenames — `spring-campaign-landing.html`
becomes "Spring Campaign Landing".

### Customizing how a preview appears (optional)

Filenames drive the display name by default. To override the title or add a description,
edit `META_OVERRIDES` in [`scripts/build-index.mjs`](scripts/build-index.mjs):

```js
const META_OVERRIDES = {
  "Backyard-movie-nights.html": {
    title: "Backyard Movie Nights — Landing Page",
    description: "Concept landing page for the summer campaign.",
  },
};
```

A `<meta name="description">` tag in the HTML is also picked up automatically.

## One-time setup (enable GitHub Pages)

The deploy workflow is committed, but Pages must be turned on once in the repo settings:

1. Go to **Settings → Pages**.
2. Under **Build and deployment → Source**, select **GitHub Actions**.
3. Merge this branch into `main` (or push to `main`). The
   **Deploy previews to GitHub Pages** workflow runs and publishes the site.

You can also trigger a deploy manually from the **Actions** tab
(**Deploy previews to GitHub Pages → Run workflow**).

## How it works

- [`scripts/build-index.mjs`](scripts/build-index.mjs) scans the repo for `.html` files
  (ignoring `index.html` and tooling dirs) and regenerates `index.html`.
- [`.github/workflows/pages.yml`](.github/workflows/pages.yml) runs that script on every
  push to `main`, then deploys the whole repo to GitHub Pages.

To preview the gallery locally: `node scripts/build-index.mjs` then open `index.html`.
