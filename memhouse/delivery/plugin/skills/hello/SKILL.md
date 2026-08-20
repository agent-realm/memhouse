---
name: hello
description: Introduce memhouse — what it is, what it remembers, and how to use it from here. Use when the user asks "what is memhouse", "what can my memory do", "how do I use this", invokes /mem:hello, or seems new to the memory system. Also the right first answer when another /mem skill fails because nothing is configured yet.
user-invocable: true
argument-hint: ""
allowed-tools: Bash
---

# /mem:hello — welcome to your memory

**Invoking this skill IS the request. Give the introduction immediately — grounded in
this machine's actual state, not hypotheticals. Nothing to clarify first.**

## First: find out what state this machine is in

RUN this yourself with the Bash tool — do not print it for the user to run, and do not
show the env values it sources. Read its output, then write the introduction using the
ACTUAL numbers it returns (interpolate them; never emit the literal "N sessions").

```bash
MH_ENV="${MEMHOUSE_HOME:-$HOME/.memhouse}/env"
_u=${MEMHOUSE_URL-}; _s=${MEMHOUSE_USER-}; _p=${MEMHOUSE_PASSWORD-}; _d=${MEMHOUSE_DB-}
set -a; [ -f "$MH_ENV" ] && . "$MH_ENV"; set +a
[ -n "$_u" ] && MEMHOUSE_URL=$_u; [ -n "$_s" ] && MEMHOUSE_USER=$_s
[ -n "$_p" ] && MEMHOUSE_PASSWORD=$_p; [ -n "$_d" ] && MEMHOUSE_DB=$_d
if [ -n "${MEMHOUSE_URL:-}" ] && [ -n "${MEMHOUSE_USER:-}" ]; then
  curl -sS -m 5 --user "$MEMHOUSE_USER:${MEMHOUSE_PASSWORD:-}" \
    --data-binary "SELECT uniqExact(session_id), count(), formatDateTime(min(ts),'%Y-%m-%d') FROM messages" \
    "$MEMHOUSE_URL/?database=${MEMHOUSE_DB:-mem}&final=1&readonly=1" 2>&1
else
  echo "NOT_CONFIGURED"
fi
```

(Do not print the env values, and do not narrate that you are withholding them — just use them.)

## What memhouse is — the overview (give this in every state, before the tour)

One paragraph, grounded not sold: **memhouse is your personal, permanent archive of every
AI coding session.** A background shipper reads the session files your editors write —
Claude Code, Codex, Cursor, VS Code, Zed, OpenCode, Gemini CLI and 10 more, 17 in all —
and ships them into a ClickHouse database you own, called a **house**. YOU choose that
ClickHouse: a local one on your laptop, one on your own VM, or any ClickHouse server you
control — managed or remote. memhouse itself is not a hosted service and phones nothing
home; your sessions go only to the house you point it at, and it runs no LLM in its write
or read path — it stores rows, the agent reading them (this chat) does the thinking. It
outlives the transcripts on disk: editors compact and delete their local session files
after weeks, so for anything older than ~30 days the house is the only place it still
exists. One archive spans every editor, every project, every machine you ship from.

What it gives you, in one breath: **ask** your own history a question and get a cited
answer, **search** for the session you half-remember, **query** the raw data for numbers,
browse a **dashboard**, and **invite** other people onto your ClickHouse so memories can be
**shared** read-only. The tour below names each.

## Then introduce it — three states, three openings

**Configured and answering** — open with the numbers: "Your memory holds N sessions
(M messages) going back to <date> — every conversation you've had with coding agents
(Claude Code, Codex, Cursor, Gemini CLI and 13 more), across all your machines. It
outlives the transcripts on disk: editors delete their session files after weeks; this
doesn't." Then the tour below.

**Not configured** — say what memhouse IS (one paragraph: a personal, permanent archive
of every AI coding session, stored in a ClickHouse "house" you own), then how to start:
`memhouse onboard` (wizard) or `memhouse install --env <file>` if someone invited them
(the file came from `/mem:invite` on the inviter's side).

**Configured but unreachable** — say which URL refused, point at `memhouse doctor`,
stop. Never guess another endpoint.

## The tour (keep it to one screen)

What you can DO from this chat:

- `/mem:ask <question>` — answer from your past work, with citations ("how did I fix X
  last time?")
- `/mem:search <terms>` — find the session ("that conversation about Y")
- `/mem:sessions` — browse and filter what's stored
- `/mem:sql <question or SQL>` — ad-hoc analytics (tokens, costs, rankings)
- `/mem:status` — is it healthy, how much is stored, which machines ship into it

The first three overlap — same words work in each — so give the reader the rule that
separates them: **want a session → search. Want an answer → ask. Want a number → sql.**
`ask` runs a `search` first, then reads the turns it finds and writes you a cited answer;
`search` stops at the ranked list of sessions; `sql` counts and aggregates the columns
rather than hunting text.

And around other people — **inviting comes before sharing**:

- `/mem:invite <name>` — mint a friend's account + their own house on your ClickHouse,
  hand them one env file; they install with it and have their own memory
- `/mem:share <name>` — once they exist, open a read-only window into YOUR memory
  (`/mem:share revoke <name>` closes it); `/mem:users` shows who's around
- **Read a friend's shared memory** — once they've shared theirs with you, name their
  house right in the question: `/mem:ask <question> in <their-house>`, or
  `/mem:search <terms> in <their-house>` / `/mem:sql … on <their-house>`. It reads THEIR
  house read-only, with your own credentials; `/mem:users` lists the houses shared with
  you. (A house is a whole ClickHouse database — sharing grants read on it, not on single
  sessions.)

Also worth naming: `memhouse start` serves a dashboard at http://localhost:4640 for
browsing and analytics outside the chat, and everything here is read-only for agents —
only the shipper writes.

End by offering one concrete action: a search for something they mentioned recently, or
`/mem:status` if they seem unsure it's working. One offer, not a menu.
