# <REPO> × gentar (own arena)

This repo carries its own [gentar](https://github.com/agent-realm/gentar)
arena: scenarios live here, run here, and every run writes a report you
can hand to an agent to fix what failed.

## What this directory declares

| Declaration | Where | This repo's value |
|---|---|---|
| subject name | `subject = "…"` in every scenario TOML — `run.sh` reads it from there and refuses scenarios that disagree | `<REPO>` |
| suites | `scenarios/*.toml` — decisions + reality assertions | see below |
| credentials | `credentials = [names]` per suite — entries are ALTERNATIVES, a list entry is an all-of group (`["KEY", ["TOKEN","BASE_URL"]]` = the key alone, or the token and its endpoint together). None present refuses (exit 2) before a bench exists | per suite |
| trigger | `.github/workflows/gentar-arena.yml` (and/or a dispatch job into a central arena) | the kit's, unedited |
| run policy | `policy.toml` — which suites run when (see "Run policy") | see file |
| dry-run hooks | `hooks.py` — `prepare()`, `HIDE_FROM_PATH`, `SKIP_STEP_SUBSTR` | see file |
| engine pin | `GENTAR_REF` in `run.sh` — a release tag, re-fetched every run | `v0.9.2` |

## Quickstart (local)

Prereqs: Docker, and network reach to a **bench-host** you provide: any
Linux machine with [`sbx`](https://docs.docker.com/ai/sandboxes/)
installed and logged in once, reachable over SSH.

```bash
gentar/run.sh --stage-engine   # clone the pinned engine; no Docker, no bench
gentar/dryrun.py               # replay every suite locally (~1s)
gentar/run.sh first-suite      # the real thing
ls gentar/reports/             # report-<run_id>.md per run
```

`--stage-engine` also seeds `gentar/.arena/.env` from the engine's
`.env.example`, whose values are **placeholders**. Set
`GENTAR_BENCH_HOST` and `GENTAR_BENCH_USER` there to your own machine,
and `GENTAR_BENCH_KEY_FILE` (there or in the shell) to the key that
reaches it. gentar ships no bench-host: left unset the coordinator
refuses with exit 2 before any bench exists, and left as the shipped
placeholder the run fails at ssh with `Could not resolve hostname
bench.example.internal`.

Exit code is the verdict: `0` pass · `1` fail · `2` usage/config
refusal.

Two arenas on one Docker host collide on the published ClickHouse and
OTLP ports. Move yours without editing anything — the engine's compose
file reads both as env knobs:

```bash
GENTAR_CLICKHOUSE_HOST_PORT=8124 GENTAR_OTLP_HOST_PORT=14320 \
  gentar/run.sh first-suite
```

A run leaves no containers or volumes behind, guaranteed twice over.
(Plain `docker compose run --rm` would not: `--rm` removes only the
coordinator, while `clickhouse` and `otelcol` come up via `depends_on` as
ordinary `up` containers and `clickhouse` owns a named volume.)

- **Every container is `--rm`.** The compose spec has no per-service
  auto-remove key and `compose up` has no `--rm`, so the runner starts
  each arena service as a one-off `compose run -d --rm` — the only way to
  get daemon-level `AutoRemove`. A stopped container is then removed by
  the Docker daemon itself, whatever stopped it: ctrl-c, `SIGKILL`, OOM,
  or the runner dying before its trap can fire.
- **A trap tears the project down anyway** — pass, fail, refusal and
  ctrl-c alike — covering the network and anything else left over.

Check residue by this project's own label, never global counts (another
arena may share the host):

```bash
docker ps -a --filter label=com.docker.compose.project=arena-<REPO>
```

To keep a stack up and inspect ClickHouse, set `GENTAR_KEEP_ARENA=1`; you
then own the teardown: `gentar/run.sh --down`. (Not a bare `docker compose
down`, which refuses the network with "Resource is still in use", because
it does not stop one-off containers.)

### Watching a run

**Every run leaves a dashboard.** Before the arena is torn down, `run.sh`
renders `gentar/reports/dashboard.html` from that run's own ClickHouse: a
verdict per suite, and every step with its duration, status and output. It
is one self-contained file — download the `arena-reports` artifact from the
Actions run and open it, no server. A render that fails is said and
skipped; it never changes the verdict or the reports.

It is built to be safe as a PUBLIC repository's artifact (anyone logged in
to GitHub can download those, and GitHub masks secrets in logs, not in
artifacts): the values of the bench-host settings and of every credential
your suites declare are replaced by `«redacted:NAME»` in the dashboard and
the reports, and an agent's screen transcript appears on the dashboard only
as its length (it stays in the run report, for the fix loop). A dashboard
that cannot be redacted is not published.

**Sending telemetry to a collector.** To have every run land in your
organisation's ClickStack (or any OTLP/HTTP collector), set two repository
**secrets** — whoever operates the collector gives you both:
`GENTAR_OTLP_EXPORT` (its base URL, e.g. `http://collector.example.internal:4318`) and
`GENTAR_OTLP_KEY` (its ingestion key). Each run is then one trace, rooted at
the scenario, with every step and the agent's session → turns → tool calls
as child spans, and the run's CI identity on the resource. It is scrubbed
exactly as the dashboard is — nothing a report would hide leaves — and a
collector that is down never changes a verdict. Locally, lend the key for
one run instead of writing it anywhere:

```bash
GENTAR_OTLP_EXPORT=http://collector.example.internal:4318 \
  with-secret GENTAR_OTLP_KEY=<key-reference> -- gentar/run.sh first-suite
```

Both or neither: one without the other is refused (exit 2) before any
bench exists.

To watch a run live instead, keep the stack up with `GENTAR_KEEP_ARENA=1` and,
from a second shell (use your own port if you moved it):

```bash
GENTAR_CLICKHOUSE_HOST_PORT=8123 python3 gentar/.arena/dashboard/generate.py \
  --watch --out gentar/reports/dashboard.html          # regenerates every 5s
```

Until the first suite creates its tables it says it is waiting — not an
error. The ClickHouse goes with the arena, so after `--down` only the
rendered file is left.

## Semantic suites (optional)

A judged `expect` asks TypeSafe a yes/no question about the screen instead
of matching a regex. See the engine README, *Semantic turns*. Three rules
the kit enforces:

- the scenario declares `[scenario] data = "synthetic"`, and the engine
  refuses the run otherwise;
- each judged turn has 3+ yes and 3+ no screens under
  `gentar/judge-fixtures/<scenario>/<turn>/{yes,no}/`.
  `with-secret TYPESAFE_API_KEY=<ref> -- python3 gentar/.arena/bin/judge-eval gentar/scenarios gentar/judge-fixtures`
  measures them (python 3.11+);
- judged suites run in phase 2 only, and `plan.py` drops them from any
  phase-1 pick.

The key is the repository secret `TYPESAFE_API_KEY`. Without it, `--sweep`
skips judged suites by name.

## The docs standard (`[check] docs`)

The template's `policy.toml` turns on a docs check that `run.sh --check`
(so every PR's phase 1) enforces. It checks the **mechanical** half of a
simple standard for this repo, not its quality:

1. `README.md`, short (at most 150 lines): what it is, why it exists, how
   it is used;
2. `docs/tutorials/` and `docs/guides/`, not empty;
3. `examples/`, each subdirectory with its own `README.md`;
4. `AGENTS.md`, the entry for agents installing or deploying it;

and every relative link in those files resolving. Whether the content is
good is for review. If this repo doesn't follow the standard, set
`docs = false` under `[check]`, and say so in the adoption.

## When this repo's code changes

The suites here assert what is true of this repo, so the two move
together.

- **Code changed, behaviour did not** — nothing to do. Phase 1 checks
  the PR before it lands (the run policy below); the pass is the
  evidence.
- **Behaviour changed** — the scenarios change in the **same pull
  request**. A scenario asserts reality; stale reality fails honestly,
  and that failure is the suite working. New behaviour is usually a new
  suite: dry-run it, run it once for real, ship it with the feature.
  Splitting the code change and the scenario change across two PRs
  leaves main red in between, and a red main teaches people to ignore
  the arena.
- **The engine changed** — nothing happens until someone bumps
  `GENTAR_REF` in `run.sh`. That is a deliberate change: bump, run every
  suite, commit the bump on its own with the outcome in the message.
- **The repo grew behaviour nothing asserts** — the case with no
  failure. Existing suites still pass, the board stays green, and
  coverage decays quietly. Nothing catches this by running; someone has
  to look.

```bash
gentar/run.sh --review     # no engine, no Docker, no bench
```

It lists what the repo ships that no suite mentions, and the diff since
the scenarios last changed. It **reports and stops** — never fails,
never writes. A gap is a question, not a defect: some of those should
have a suite and some never will, and deciding which needs someone who
has read the repo. Worth running when a feature lands, or periodically.

Its blind spot, stated so you do not trust it too far: it compares
shipped executables and scripts against names the suites mention, so a
**behaviour change inside a file a suite already names** does not show
up. The diff is there for that.

## Run policy — which suites run when

Decided once, in `gentar/policy.toml`, and carried out by the workflow
without further thought. `gentar/plan.py` is its only reader; the
workflow's first job asks it what this event should run.

| Event | Runs |
|---|---|
| pull request | **phase 1**: bench-free checks on GitHub-hosted runners — `ubuntu-latest`, plus `macos-latest` if `[phase1] os` lists it — or on the self-hosted runner `GENTAR_CI_RUNNER` names (below) (`gentar/run.sh --check`: dry-run of every suite, adaptation lint, kit drift). With `[phase1] bench = "declared"`, a same-repo PR also runs the floor plus the suites its body names, on the bench |
| push to the default branch | **phase 1**: the checks, plus `[phase1] floor` on the bench |
| dispatch (no suites; on any ref, a release tag included: a drift run), the `arena` tag, a `v*-rc*` tag | **phase 2**: the full regression — every suite this environment can run — as the job `arena / phase2` (each trigger opts in via `[phase2] on`) |
| `arena-<suite>` tag, or a dispatch naming suites | exactly those suites (`arena / targeted`; never counts as phase 2) |
| `v*` tag pushed | nothing — a release is **gated** on a green phase 2 of its commit (below), not tested after it |

A fork's pull request never reaches the self-hosted runner, whatever the
policy says: the bench job checks that from GitHub's own context. Try any
event locally:

```bash
GITHUB_EVENT_NAME=push GITHUB_REF=refs/tags/v1.2.0-rc1 gentar/run.sh --plan
```

**Narrowing a PR** (`bench = "declared"` only): one line in the PR body,

```
gentar: auth-flow config-migration
```

Those suites run, plus the floor. Declared, not inferred — a rule that
reads the diff fails by silently *excluding* the suite that mattered. A
suite name is letters, digits, dot, dash, underscore; anything else is
refused with exit 2 before a bench is spent, since a PR body is text a
stranger can write. Set the **floor** to the cheap deterministic suites:
they run whatever a PR declares, so a narrow pick never costs the guard
rails.

**Suites that need their bench template's tools.** A dry-run runs on the
host, so a suite whose `template` bakes in a tool the host lacks (a CLI from
a private repo, say) cannot pass it. Declare the template in `hooks.py`'s
`TEMPLATES` with a stager that installs the REAL tool when it can: staged,
the suite runs; not staged, it reports `UNVERIFIED (template …)` — named,
never green by stub, never red by harness; a stager that raises is a
failure. Undeclared templates run as before.

**Gating a release.** Make the first job of your release workflow

```yaml
  arena-gate:
    # the same runner as the arena's plan/checks (GENTAR_CI_RUNNER, if set)
    runs-on: ${{ vars.GENTAR_CI_RUNNER && fromJSON(vars.GENTAR_CI_RUNNER) || 'ubuntu-latest' }}
    permissions: { actions: read, contents: read }
    steps:
      - uses: actions/checkout@v4
      - run: gentar/release-gate.sh "$GITHUB_SHA"
        env: { GH_TOKEN: "${{ github.token }}" }
```

and every publishing job `needs: arena-gate`. It passes only if that exact
commit has a green `arena / phase2`, however it was triggered — so run
phase 2 first (push `arena`, or a `v*-rc*` tag, at the commit), then tag
the release. A refusal names what it found instead: a failed phase 2, a
cancelled one, or a run GitHub cancelled before it started.
`[phase2] max_age_days` also refuses a pass older than that.

**One arena at a time per host.** Runs of this repo on one Docker host
share a compose project and ports, so `run.sh` takes a host lock and a
later run **waits**, printing who holds it. (A GitHub concurrency group
cannot do this: it cancels a pending run when a newer one queues.)

## The fix loop

Every terminal outcome writes `gentar/reports/report-<run_id>.md`
stating what ran (every step, with output), what was asserted and what
it actually saw, and a reproduce command (`gentar/run.sh <suite>` — the
runner rewrites the engine's central-arena default on copy). On a
failure, that file is a work order:

```
Read gentar/reports/report-<id>.md, fix the repo, rerun
`gentar/run.sh <suite>`, iterate until it passes.
```

The subject is the **working tree** (uncommitted changes included) — fix
and rerun, no commit needed to test.

Exit `1` is a verdict: an assertion saw something other than the claim.
Exit `2` is a refusal before any bench existed — a missing credential,
an unknown scenario name, a budget cap below the suite's declared spend.
A refusal is a usage error in the invocation, never a red test.

The engine is pinned by `GENTAR_REF`, re-fetched and re-checked-out on
every run, **and the coordinator image is rebuilt from it**. That last
part is not optional: the compose service is `build: ./coordinator`, so
without a build step `docker compose run` reuses a cached image, and on a
long-lived runner that image drifts months behind the source while
`GENTAR_REF` looks perfectly honoured. A fresh checkout is not a fresh
engine.

## Suites

| Suite | Proves |
|---|---|
| `first-suite` | the template suite — arena plumbing only; replace with your first real suite |

## Before you push a suite

```bash
gentar/dryrun.py                                   # every suite
gentar/dryrun.py gentar/scenarios/first-suite.toml
```

Needs **python 3.11+, or 3.9/3.10 with `tomli`** (`pip install tomli`) —
it parses TOML on your machine, and `tomllib` only became stdlib in 3.11
while stock macOS still ships 3.9. It re-execs under a newer interpreter
if one is on PATH, so on most machines this is invisible. The arena is
unaffected: the coordinator runs python 3.12 in a container.

Runs a suite's steps, driver turns and assertions in a scratch home in about
a second — no bench, no sandbox, no network. A scenario is shell inside TOML,
three levels of quoting deep, and the arena was the only thing that ever ran
it: one missing quote cost a bench VM and several minutes to find. This finds
it before the push.

It needs a checkout of the engine for its scenario parser — the one
`gentar/run.sh --stage-engine` makes, so a suite is validated by the
same engine version that will run it. `GENTAR_ENGINE=/path/to/gentar/coordinator`
points it at an existing checkout instead.

The layout mirrors a bench: your checkout is staged into `WORKSPACE_DIR`,
which sits *under* `HOME` rather than being it, and steps run with the
workspace as cwd. So a `~/…` assertion asks about the pilot's home, never
about a file that shipped in your repo.

It is not a substitute for the arena. There is no sandbox, no template and no
network policy, so it proves the shell and the assertions while the arena
proves the isolation. Two kinds of suite it will not claim to have checked:
those declaring `credentials` are skipped (they need a real agent and a real
key), and those whose `[driver]` uses `pick` or `abort` turns, a judged
`expect`, or a `goal` come back `UNVERIFIED` with a nonzero exit — those need
the real driver (or the judge), and a picker that never matched must not read
as a pass. A goal pilot's driver is not even started, and its assertions are
not run, since nothing was driven. `run.sh --check` accepts UNVERIFIED (it is
not a defect the dry run can see); the arena is where these suites are proven.

Add a suite = add a TOML here. The schema is the engine's
`coordinator/gentar/toml_scenario.py` — read the pinned copy under
`gentar/.arena/` after staging, since that is the parser your suite will
face. Decisions and reality assertions, never scripts.

## CI (`.github/workflows/`)

The arena workflow is the kit's, byte for byte — `--check` compares it —
and does what the run policy says (above). Its `plan` and `checks` jobs
run on GitHub-hosted runners; only the `bench` job needs a self-hosted
runner labeled `arena` with Docker + reach to the bench-host.

**No GitHub-hosted minutes, or CI kept in-house?** Set the repository or
organisation variable `GENTAR_CI_RUNNER` to a JSON runs-on value, e.g.
`["self-hosted", "linux-ci"]`, and `plan` and `checks` run there instead
(the plan output's `runner=` line says where). It needs `git`, `python3`
and `bash`, plus `gh` for the release gate below. Three things change with it set:

- a **fork's** pull request runs nothing at all, not even the checks: its
  code never reaches a self-hosted runner;
- `[phase1] os` may only list `ubuntu-latest` (macOS checks need a hosted
  runner; `plan.py` refuses rather than quietly running Linux);
- the value may not mention `arena` in any case, not even inside a longer
  label: the checks run pull request code and the bench runner must never
  get it. The workflow fails such a run before scheduling anything
  (`ci-runner-refused`), because runner labels match regardless of case.

The `bench` job is unaffected: it always runs on `arena`.
GitHub-hosted runners cannot reach an internal bench-host. One-time
setup, ~5 min on any always-on machine with Docker:

GitHub → this repo → Settings → Actions → Runners → New self-hosted
runner → follow the commands → when configuring, labels: `arena`.

Secrets/vars the workflow reads:

- `secrets.BENCH_SSH_KEY` — key the coordinator uses to reach the bench-host
- `secrets.GENTAR_BENCH_HOST`, `secrets.GENTAR_BENCH_USER` — the bench-host itself; the
  engine ships none, so without these no suite can run (secrets, because a public
  repo's logs are public)
- `secrets.GENTAR_CLONE_KEY` — read-only deploy key, only if the ENGINE repo is private
- `vars.GENTAR_REPO_URL` — only to clone the engine from a fork or mirror
- `vars.GENTAR_REF` — only to run an engine ref other than `run.sh`'s pin (a branch or release candidate being proven); delete it afterwards
- `secrets.ANTHROPIC_API_KEY` or `secrets.ANTHROPIC_AUTH_TOKEN` + `vars.ANTHROPIC_BASE_URL` — agent suites
- `vars.ANTHROPIC_DEFAULT_{SONNET,OPUS,HAIKU,FABLE}_MODEL` — all four, for a routed endpoint
- `vars.GENTAR_BUDGET_CAP` — ceiling the budget guard enforces (default 50000)
- `vars.GENTAR_CLICKHOUSE_HOST_PORT`, `vars.GENTAR_OTLP_HOST_PORT` — move the
  arena's host ports when another arena shares the runner's Docker host

The three bench values are required; the workflow refuses with a named error
before staging anything if one is missing or still the placeholder. Everything
else is optional. Phase 2 is `gentar/run.sh --sweep`: suites whose credentials
are absent are skipped and named, not run into a red refusal. It tears down
with `gentar/run.sh --down`, which also removes the bench sandboxes a cancelled
job left behind — and never touches an arena another live run holds.

**Git history in the bench.** The subject is staged without `.git`: on
CI it holds the job's auth header. A suite that needs history (one that
clones an older release tag to test an update) sets `[stage] git = true`
in `gentar/policy.toml`. The kit then gives the staged copy a fresh `.git`
from a local clone: every commit and tag, a new config, no remote. The
engine refuses a subject whose git config still holds a credential. The
checkout must be full (the kit workflow's bench job uses `fetch-depth: 0`);
a shallow one is refused.

**Credential grouping.** `credentials` lists *alternatives*. A provider that is
a pair must be a nested list — `[["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]]`.
Written flat, the two are either-or: the token wins alone and the URL is
dropped. The engine warns when a declared credential is set but not forwarded,
in the log and in the report.

**Benches carry placeholder keys.** An sbx sandbox holds `proxy-managed` in
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GOOGLE_API_KEY`
and a few more, and a token-shaped fake `GH_TOKEN` — its credential proxy's
stand-ins, whatever your suite declared. So a suite must pick a credential by
the variables of the group it declared, never by presence: `[ -n
"$ANTHROPIC_API_KEY" ]` is true on every bench and sends the placeholder to
the real API, which answers 401 (claude-playbooks). The engine refuses an sbx
bench-host that has stored secrets (`sbx secret ls`), since the proxy would
then resolve those placeholders to a real key for every suite; set
`GENTAR_SBX_SECRETS=allow` only if an arena uses sbx secrets on purpose.

The workflow stages the checkout exactly like `run.sh` does, so local
and CI run the same way.

## Layout

```
gentar/
  scenarios/*.toml   # suites (this repo's own)
  policy.toml        # run policy — which suites run when (this repo's own)
  hooks.py           # dry-run hooks: prepare(), HIDE_FROM_PATH (this repo's own)
  run.sh             # kit — stage, run, report; --check, --plan, --down
  dryrun.py          # kit — local, bench-less step/assertion replay
  plan.py            # kit — the run policy's only reader
  release-gate.sh    # kit — may this commit be released?
  reports/           # run reports land here (gitignored)
  .arena/            # gentar checkout (gitignored, auto-cloned)
```
