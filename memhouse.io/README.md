# memhouse.io — the product site

Static, no build step, no framework. Hand-rolled CSS; the only external request is the
Google Fonts stylesheet. Edit the files and redeploy — that is the whole workflow.

| File | What |
|---|---|
| `index.html` | the whole landing page (chips + copy buttons are ~40 lines of inline JS) |
|  `style-2.css` | all styling; the palette lives in `:root` at the top |
|  `logo-2.svg` | the mark — a house with three rooms stacked inside it; also the favicon |
| `dashboard.png` | product screenshot (the dashboard, downscaled from `docs/screenshot.png`) |
| `404.html` | Pages serves this for unknown paths |
| `_headers` | Cloudflare Pages response headers (security + cache) |
| `robots.txt`, `sitemap.xml` | crawl basics |

## Deploy

Hosted on **Cloudflare Pages**, project `memhouse-io`, account
`Ramazanpolat@gmail.com's Account` — direct upload, no git integration, so a deploy is
one command from this directory:

```bash
npx wrangler@latest pages deploy . --project-name=memhouse-io --branch=main --commit-dirty=true
```

Custom domains `memhouse.io` and `www.memhouse.io` are attached to the project; the zone's
apex/`www` records are Pages-managed CNAMEs, proxied. `wrangler pages deployment list
--project-name=memhouse-io` shows history, and every deploy also gets its own immutable
`<hash>.memhouse-io.pages.dev` preview URL.

## Caching — the one trap here

The CSS and the logo carry a **version suffix in the filename** (`style-2.css`,
`logo-2.svg`). That is deliberate. Pages caches assets for an hour by default, so a
redeploy can serve a visitor fresh HTML against their cached stylesheet — which renders
as an unstyled page, and it happened once already. `_headers` now sets
`max-age=0, must-revalidate` on the markup and those two files, but that only helps
browsers that fetch them again.

**Bump the suffix on any change a visitor must see immediately** (`style-3.css`, and the
matching `_headers` rule). Do not reach for `?v=3`: `_headers` rules match on **path
only**, so a query-string URL misses its rule and silently falls back to the hour-long
default — the exact failure the version was meant to prevent.

## Copy rules

The site speaks the **town vocabulary** where a reader might be a newcomer (house, room,
member) and drops to machine vocabulary only where it earns it (ClickHouse, `GRANT`,
`ReplacingMergeTree`) — see `../TERMINOLOGY.md`. Version and editor counts are stated in
three places (`<title>`/meta, the nav pill, the FAQ); grep for the number before bumping it.
