# ultimagent-memhouse

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

## Quickstart

```bash
npm install
# configure ~/.memhouse/env (MEMHOUSE_URL/USER/PASSWORD/DB), then:
node mem-house/shipper/ship.js --ensure-schema
node mem-house/shipper/ship.js            # parse-on-client ship of all local sessions
node mem-house/shipper/ship.js --stats    # per-source counts
cd ui && npm install && npm run build && cd ..
node mem-house/server/server.js           # dashboard → http://localhost:4640
```

Full instructions: `mem-house/delivery/AGENT-INSTALL.md` (or
`mem-house/delivery/install.sh`). Kernel install (agency `memhouse`, members,
own-only RLS): `mem-house/delivery/kernel-install.md`. Claude Code skills + plugin:
`mem-house/delivery/skills/`, `mem-house/delivery/plugin/`.

## Heritage & license

Built on [agentlytics](https://github.com/f/agentlytics) by Fatih Kadir Akın (MIT)
— the adapters, dashboard, and cost engine come from there (this repo's history
carries the full lineage). The `agentlytics` remote tracks the private working
mirror for syncing adapter improvements both ways.
