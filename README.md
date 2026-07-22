# memhouse

**mem-house** — agent conversation memory as a product. Every coding-agent session
on your machines — across the **17 editors** the agentlytics adapters support —
parsed locally, shipped to one typed ClickHouse store, shareable with a team,
installable on the ultimagent kernel as an **agency**, and visible through the
agentlytics dashboard unchanged.

An alternative agency **competing with memory-house**; if it wins, it becomes
memory-house v4. Start with `mem-house/DESIGN.md` for the four bets
(parse-on-client, typed common schema, kernel-agency, borrowed UI).

## Layout

| Path | What |
|---|---|
| `mem-house/` | the product: `DESIGN.md`, `schema.sql`, `rls.sql`, `shipper/`, `server/`, `delivery/` |
| `editors/` | the 17 editor adapters (inherited from agentlytics; the crown jewels) |
| `pricing.js` + `pricing.json` | the cost engine |
| `ui/` | the dashboard SPA (built to `public/`, served unchanged by the mem-house server) |
| `agency/` | the earlier agentlytics-agency wrap (raw canonical shape) — kept as prior art |
| everything else at root | upstream agentlytics (see `AGENTLYTICS-README.md`), still runnable |

## Quickstart — the `memhouse` CLI

```bash
npx memhouse onboard      # wizard: discover → configure → ship → start
```

While the package is private, run it from the repo (`npm install` once, then
`node bin/memhouse.js …` or `npm link` for a global `memhouse`), or
`npx github:ramazanpolat/memhouse …` with git auth. The public npm
name `memhouse` is reserved for release.

```text
memhouse onboard | install | setup | discover | uninstall | reset
memhouse ship [--full|--loop N] | stats | search <terms> | start | stop | status | doctor
memhouse plugins install claude | prompt
```

Every command is dual-mode: interactive for humans, `--yes`/flags/`--json` for
agents — so an agent can self-install its own memory (`memhouse install --yes …`,
`memhouse plugins install claude`). Config: flags > `MEMHOUSE_*` env >
`~/.memhouse/env` > defaults.

Deeper docs: `mem-house/delivery/AGENT-INSTALL.md`, kernel install (agency
`memhouse`, members, own-only RLS): `mem-house/delivery/kernel-install.md`,
skills/plugin payloads: `mem-house/delivery/`.

## Heritage & license

Built on [agentlytics](https://github.com/f/agentlytics) by Fatih Kadir Akın (MIT)
— the adapters, dashboard, and cost engine come from there (this repo's history
carries the full lineage). The `agentlytics` remote tracks the private working
mirror for syncing adapter improvements both ways.
