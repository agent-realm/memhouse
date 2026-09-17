// Which npm channel this install follows, and what `memhouse update` may move it to.
//
// `update` used to install `memhouse@latest`, full stop. That is right for a house that
// tracks the published release and wrong for every other kind of install: a build
// published under another dist-tag (`memhouse@team`, so a team on a newer layout does not
// drag every other house along) would be DOWNGRADED to latest on its next update, and a
// tarball install has no tag at all and would be replaced by whatever latest is.
//
// So the channel is resolved, in this order:
//   1. pinned — MEMHOUSE_CHANNEL in the env file, or --channel on the command line
//   2. inferred — the dist-tag whose version equals the one installed (latest preferred)
//   3. a pre-release version matching no tag is a tarball: no automatic update at all
//   4. otherwise latest
// Pure, so the decision is unit-tested against every shape of registry answer.

function isPrerelease(version) { return /-/.test(String(version || '')); }

/**
 * @param {{version:string, pinned?:string|null, tags:Record<string,string>|null}} p
 * @returns {{channel:string|null, target:string|null, reason:string}}
 */
function pickChannel({ version, pinned = null, tags = null }) {
  const t = tags || {};
  if (pinned) {
    return t[pinned]
      ? { channel: pinned, target: t[pinned], reason: `pinned by MEMHOUSE_CHANNEL` }
      : { channel: pinned, target: null, reason: `pinned to '${pinned}', which is not a tag on the registry${tags ? '' : ' (or the registry did not answer)'}` };
  }
  const matching = Object.entries(t).filter(([, v]) => v === version).map(([k]) => k);
  if (matching.includes('latest')) return { channel: 'latest', target: t.latest, reason: 'installed version is latest' };
  if (matching.length) return { channel: matching[0], target: t[matching[0]], reason: `installed version is published as '${matching[0]}'` };
  if (isPrerelease(version)) {
    return { channel: null, target: null, reason: `${version} is on no registry tag — a tarball or checkout build; update it by installing a newer tarball, or pin a channel: memhouse update --channel <tag>` };
  }
  // A release that matches no tag any more (the tag moved on) stays on ITS LINE: the tag
  // whose target shares this version's major.minor. Falling back to `latest` moved a
  // 0.18.2 team member to 0.17.1 — a different house layout — on her first update.
  const line = lineOf(version);
  const sameLine = Object.entries(t).filter(([, v]) => lineOf(v) === line).map(([k]) => k);
  if (sameLine.length) {
    const k = sameLine.includes('latest') ? 'latest' : sameLine[0];
    return { channel: k, target: t[k], reason: `following '${k}' — the tag on the ${line}.x line this install is on` };
  }
  if (!tags) return { channel: null, target: null, reason: 'the registry did not answer — cannot tell which line to follow; retry, or: memhouse update --channel <tag>' };
  return { channel: null, target: null, reason: `${version} is on the ${line}.x line and no registry tag points at ${line}.x — crossing lines is a decision: memhouse update --channel <tag>` };
}

/** "0.18" of "0.18.2" — the line a version belongs to. */
function lineOf(v) { const m = /^(\d+)\.(\d+)/.exec(String(v || '')); return m ? `${m[1]}.${m[2]}` : ''; }

/** The registry's dist-tags, or null when it cannot be reached. Abbreviated document, small. */
async function fetchTags(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl('https://registry.npmjs.org/memhouse', {
      headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const j = await res.json();
    return j && j['dist-tags'] ? j['dist-tags'] : null;
  } catch { return null; }
}

module.exports = { pickChannel, fetchTags, isPrerelease, lineOf };
