# memhouse.io — the product site

Static, no build step, no framework. Hand-rolled CSS; the only external request is the
Google Fonts stylesheet. Edit the files and redeploy — that is the whole workflow.

| File | What |
|---|---|
| `index.html` | the whole landing page (chips + copy buttons are ~40 lines of inline JS) |
| `style.css` | all styling; the palette lives in `:root` at the top |
| `logo.svg` | the mark — a house with three rooms stacked inside it; also the favicon |
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

## Copy rules

The site speaks the **town vocabulary** where a reader might be a newcomer (house, room,
member) and drops to machine vocabulary only where it earns it (ClickHouse, `GRANT`,
`ReplacingMergeTree`) — see `../TERMINOLOGY.md`. Version and editor counts are stated in
three places (`<title>`/meta, the nav pill, the FAQ); grep for the number before bumping it.
