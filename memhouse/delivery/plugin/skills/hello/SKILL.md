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

(Never print the env values themselves.)

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

And around other people — **inviting comes before sharing**:

- `/mem:invite <name>` — mint a friend's account + their own house on your ClickHouse,
  hand them one env file; they install with it and have their own memory
- `/mem:share <name>` — once they exist, open a read-only window into YOUR memory
  (`/mem:share revoke <name>` closes it); `/mem:users` shows who's around

Also worth naming: `memhouse start` serves a dashboard at http://localhost:4640 for
browsing and analytics outside the chat, and everything here is read-only for agents —
only the shipper writes.

End by offering one concrete action: a search for something they mentioned recently, or
`/mem:status` if they seem unsure it's working. One offer, not a menu.
