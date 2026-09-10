// What the shipper's log says about its LAST pass.
//
// A daemon whose every pass fails is "running" by pid. A drill member's shipper failed
// auth for twelve minutes while `status` said "shipper: running" and `doctor` was green,
// and she — and her agent — read an empty house as "still catching up". The log beside
// it had the answer on every pass. This reads it. Pure; the CLI reads the file.
//
// Lines have no timestamps, so "last" is textual order: the later of the last success
// line and the last failure line wins.

const OK = /\[memhouse\] shipped (\d+) sessions[^\n]*?→ (\d+) msg rows/;
const FAIL = /\[memhouse\] pass failed: ([^\n]*)/;

/** @returns {{outcome:'ok'|'failed'|null, sessions?:number, rows?:number, why?:string, auth?:boolean}} */
function lastPass(logText) {
  const text = String(logText || '');
  let lastOk = -1; let lastFail = -1; let okM = null; let failM = null;
  for (const m of text.matchAll(new RegExp(OK.source, 'g'))) { lastOk = m.index; okM = m; }
  for (const m of text.matchAll(new RegExp(FAIL.source, 'g'))) { lastFail = m.index; failM = m; }
  if (lastOk < 0 && lastFail < 0) return { outcome: null };
  if (lastFail > lastOk) {
    const why = failM[1].trim();
    return { outcome: 'failed', why, auth: /Authentication failed|ACCESS_DENIED|Not enough privileges/i.test(why) };
  }
  return { outcome: 'ok', sessions: Number(okM[1]), rows: Number(okM[2]) };
}

/** One line for a person: null when there is nothing to say (no passes yet, or the last one was fine). */
function describeFailure(lp) {
  if (!lp || lp.outcome !== 'failed') return null;
  const why = lp.why.length > 90 ? `${lp.why.slice(0, 87)}…` : lp.why;
  return lp.auth
    ? `the last pass FAILED — ${why} — restart it: memhouse stop && memhouse start`
    : `the last pass FAILED — ${why} — see: memhouse doctor`;
}

module.exports = { lastPass, describeFailure };
