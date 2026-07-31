# memhouse

**memhouse** — agent conversation memory as a product. Every coding-agent session
on your machines — across the **17 editors** the agentlytics adapters support —
parsed locally, shipped to one typed ClickHouse store, shareable with a team,
installable on the ultimagent kernel as an **agency**, and visible through the
agentlytics dashboard unchanged.

An **agency** in the constellation sense (`TERMINOLOGY.md`): a **house** — the
`memhouse` database — plus a **resident** working in it, the shipper. The test is
what writes. The shipper fires on its own loop and puts rows in the house that
outlive any query; everything else here is only ever read. The house alone would
hold; the shipper is what makes it act.

An alternative agency **competing with memory-house**; if it wins, it becomes
memory-house v4. Start with `mem-house/DESIGN.md` for the four bets
(parse-on-client, typed common schema, kernel-agency, borrowed UI).

## Layout

| Path | What |
|---|---|
| `mem-house/` | the product: `DESIGN.md`, `schema.sql`, `rls.sql`, `shipper/`, `server/`, `delivery/` |
| `editors/` | the 17 editor adapters (inherited from agentlytics; the crown jewels) |
| `pricing.js` + `pricing.json` | the cost engine |
| `ui/` | the dashboard SPA (built to `public/`, served unchanged by the memhouse server) |
| `agency/` | the earlier agentlytics-agency wrap (raw canonical shape) — kept as prior art |
| `TERMINOLOGY.md` | the constellation terminology canon + how it applies here |
| everything else at root | upstream agentlytics (see `AGENTLYTICS-README.md`), still runnable |

## Quickstart — the `memhouse` CLI

```bash
npm install -g memhouse --allow-scripts=better-sqlite3
memhouse onboard          # wizard: discover → configure → ship → start
```

**Do not drop `--allow-scripts=better-sqlite3`.** Five adapters — cursor, goose,
opencode, zed, and antigravity — read sessions out of SQLite files, and
`better-sqlite3` builds its native binding from an install script. npm 12 blocks
install scripts by default, so without the flag those five read nothing and you
silently ship a partial history. `memhouse discover` and `memhouse doctor` both
say so when the binding is missing.

To try it without installing, npx takes the same flag — it has to come before the
package name:

```bash
npx --allow-scripts=better-sqlite3 -y memhouse discover
```

Working from a checkout instead: `npm install` (the repo's `allowScripts` field
covers the binding), then `node bin/memhouse.js …`.

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
