# memhouse.io — the product site

Static, no build step, no framework. Hand-rolled CSS; the only external request is the
Google Fonts stylesheet. Edit the files and redeploy — that is the whole workflow.

| File | What |
|---|---|
| `index.html` | the whole landing page (chips + copy buttons are ~40 lines of inline JS) |
|  `style-4.css` | all styling; the palette lives in `:root` at the top |
| `mark.png` / `mark-dark.png` | the nav mark, extracted from the artwork; the `-dark` copy lifts only the grey ink |
| `lockup.png` / `lockup-dark.png` | mark + wordmark, used in the footer |
| `icon-512.png` | favicon and apple-touch-icon |
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

The CSS and the logo carry a **version suffix in the filename** (`style-4.css`,
`logo-3.svg`). That is deliberate. Pages caches assets for an hour by default, so a
redeploy can serve a visitor fresh HTML against their cached stylesheet — which renders
as an unstyled page, and it happened once already. `_headers` now sets
`max-age=0, must-revalidate` on the markup and those two files, but that only helps
browsers that fetch them again.

**Bump the suffix on any change a visitor must see immediately** (`style-5.css`, and the
matching `_headers` rule). Do not reach for `?v=3`: `_headers` rules match on **path
only**, so a query-string URL misses its rule and silently falls back to the hour-long
default — the exact failure the version was meant to prevent.

## The brand

`memhouse.png` in the repo root is the source artwork: a grey **M** and an orange **H**
forming a roofline, over the *MemHouse* wordmark. The site assets are derived from it, not
redrawn — `_brand.js`-free, generated once by matteing the white background off (the art is
two flat colours composited over white, so coverage solves exactly:
`a = (255 - pixel) / (255 - ink)`), then cropping the mark and the full lockup.

Brand colours, sampled from the file: **`#fe7601`** orange, **`#585858`** grey.

Orange leads. It sits close to the scarlet in the accent set, so rather than letting two
reds compete for the same job they are ranked: orange takes the primary role (buttons,
section numbers, links, list marks) and scarlet is its pressed/hover step. Yellow, sage and
tan carry the quieter structure.

A dark-theme copy of each asset lifts **only the grey ink** to `#d8d4c8` — at `#585858` the
M and the wordmark all but vanish on the dark ground. The orange is left exactly as the
brand specifies it, since it reads on both.

## Copy rules

The site speaks the **town vocabulary** where a reader might be a newcomer (house, room,
member) and drops to machine vocabulary only where it earns it (ClickHouse, `GRANT`,
`ReplacingMergeTree`) — see `../TERMINOLOGY.md`. Version and editor counts are stated in
three places (`<title>`/meta, the nav pill, the FAQ); grep for the number before bumping it.
