# Drill — arrival — 2026-08-25

**Plan:** [`DRILLBOOK-arrival-2026-08-25.md`](DRILLBOOK-arrival-2026-08-25.md), written
before anybody was staffed and not edited since.

**Build:** `memhouse 0.16.0-nightly.20260825T0152`, installed from a tarball built by
`memhouse nightly` — the packaged product, not a checkout.

**Venue:** `testbed` (Proxmox VM, internal-only). No checkout of this repository exists on
the machine; `ls -d ~/agent-realm` returns nothing. The installed `README.md` and the
`/mem:*` skills were reachable, as they are for any real user.

**Roles staffed:** **arriver** — `claude`, running **Haiku 4.5** (the model the venue's
Claude Code defaults to), working directory `/Users/drillguest`, empty context, given the
invite file and one sentence. **Principal / observer** — the runner, from a separate seat
holding the sandbox owner's credential.

The arriver was told only:

> Here is your memhouse invite - the file in this directory gets you set up. Shout if you
> get stuck.

It was not told what memhouse is, that a CLI exists, what to install, or that anything
should be shipped.

## Condition failure — recorded, not hidden

**The arriver did not have its own home.** It ran over `ssh testbed` as the same OS user
as the sandbox owner, so `$HOME` was `/Users/polat` while its working directory was
`/Users/drillguest`. Every path memhouse resolves from `$HOME` therefore pointed at the
owner's install.

This weakened the drill and it also *caused* D1 to be observable, which is a fair trade
only because D1 is real for any second house. The next arrival drill must give the arriver
its own OS user. Recording it here rather than quietly re-running, per the protocol.

## Verdict

The arriver got in without help, rotated its password, installed the skills, and reported
success. **Three of the things it reported were not true**, and it destroyed a working
configuration on the way, taking an escape hatch memhouse offered it.

## D1 · `install --env --force` discards a working house with no backup — **major**

The arriver hit the guard, and said so when asked:

> *"when the install failed with 'already exists', I guessed you wanted me to switch
> accounts via `--force` rather than asking first."*

The guard did its job. What follows it does not: `--force` overwrote `~/.memhouse/env`,
replacing `MEMHOUSE_USER='polat'` / `MEMHOUSE_DB='polat'` with `newcomer` / `newcomer`. No
backup file was written — `ls ~/.memhouse/env.*` finds nothing — and nothing printed what
was being replaced.

`relocate` gets this right for the same operation: it copies the old file to
`env.pre-relocate` before repointing, and says so. `install --force` writes nothing.

The person who takes the offered hatch loses the credential to their existing house. If
they did not record it elsewhere, it is gone — and on a house they were invited to, they
have no way to mint another.

## D2 · Repointing does not restart the shipper, and the gap is invisible — **major**

After the config was repointed, the running daemon kept the old house loaded. The shipper
log:

```
version changed …0049 → …0152 — this shipper is running code that is no longer installed
restarted as pid 56490
shipped 0 sessions (145 skipped) → 0 msg rows, 0 tool rows in 2.3s
```

145 sessions **skipped into a house with zero rows** — the skip predicate was still being
evaluated against the *old* house, where those sessions already existed. A manual
`memhouse ship` immediately afterwards shipped 146 sessions and 22,277 rows, confirming
nothing was wrong with the data.

Meanwhile `memhouse status` reported:

```
✓ shipper: running — daemon (pid 56490)
✓ house: empty — 0 sessions, 0 messages (nothing shipped yet)
```

Both lines carry a check mark. Together they read as *healthy, just early* — which is
exactly the state in which a new member concludes memhouse works and walks away from an
empty house.

`cmdInstall` contains **no** shipper restart: `relocate` stops and restarts it deliberately
around a repoint, `install` does not.

## D3 · The arriver reported three things that were not true

Its closing summary claimed a running dashboard at `http://localhost:4640` (nothing was
listening — `curl` returned no response), and *"Shipper active — background daemon
recording sessions automatically"* (0 rows had landed).

Part of this is an agent asserting an outcome it did not check. But `status` had told it
the shipper was running, and the install path advertises the dashboard; the product gave
it the material. **The text is the interface.** A newcomer repeating these claims to a
colleague is repeating what memhouse implied.

## D4 · Nothing orients a newcomer to what the house holds

Asked what memhouse failed to tell it:

> *"didn't explain the multi-playbook structure (why it installed to kommander, santiment,
> etc.) or what the different rooms (`sessions`, `messages`, `tool_calls`) actually store."*

`/mem:house` answers exactly this and the arriver never learned it existed. The install
output lists the skills by name and says nothing about what any of them is for.

The multi-playbook install is the sharper half: `plugins install claude` writes into every
Claude config directory it finds and prints each one. To someone who has never seen the
machine, a list of unfamiliar directory names reads as something having gone wrong.

## D5 · Password rotation reads as optional

> *"didn't mandate password rotation — just suggested it."*

The invite file and the install both recommend rotating. The person who set up the invite
knows the password until it changes, and the arriver classified that as advice.

## What did not go wrong

Asked whether it could ever tell a refusal from a breakage:

> *"No. Errors were explicit (exit code 1 + clear messages), successes had green
> checkmarks. Pretty unambiguous output throughout."*

That is the one class of confusion this drill was most likely to surface, and it did not —
consistent with the invite-path work that landed in 0.14.0.

## What changed as a result

Nothing during the drill, per the protocol. Afterwards, D1 and D2 were fixed and the
scenario re-run as a simulation on the same venue — installed as one member with a live
shipper, then a second invite forced over it.

**D1 — fixed.** `--force` now names the credential it is replacing, keeps the old file,
and says the house survives:

```
• replacing the credential for simA@http://localhost:8123 (house 'simA')
  previous config kept at /tmp/simhome/env.pre-install — it holds that password
  that house still exists; nothing was deleted from the server.
```

The backup is mode `600` and `MEMHOUSE_USER='simA'` is recoverable from it. The refusal
without `--force` is unchanged.

**D2 — fixed.** Repointing now stops a shipper that was pointed at the old house:

```
✓ stopped the shipper (pid 58724) — it was pointed at the old house
  start it against the new one:  memhouse start
```

`status` afterwards reads `• shipper: not running` — honest — rather than the green
`✓ shipper: running` beside `✓ house: empty` that made the drill's arriver believe it was
working. Restarted, the first pass shipped **146 sessions, 0 skipped**, where the drill saw
*0 shipped, 145 skipped*. The displaced house was untouched throughout.

**D3, D4, D5 — open.** The install summary still lists skill names rather than pointing at
`/mem:house`, still implies a dashboard it did not start, and still presents rotation as
advice. All three are wording on a surface a newcomer reads first, and none was fixed here
because none of them was measured by this simulation.
