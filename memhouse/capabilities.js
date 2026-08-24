// What a ClickHouse credential may actually DO, read from its own grants.
//
// This exists because asking the wrong question here is expensive and quiet. `invite`
// used to probe with `SELECT 1 FROM system.users`: since 0.12.6 every member holds
// SHOW USERS, so every member passed, was told it could manage users, and then died at
// CREATE DATABASE with a raw ACCESS_DENIED. The replacement must be exact, and it must
// live in one place — invite and /mem:admin disagreeing about who is an administrator is
// the same class of bug wearing a different hat.
//
// SCOPE IS THE WHOLE POINT. A grant is `GRANT <privileges> ON <scope> TO <user>`, and a
// privilege only means what its scope allows: an ordinary member holds CREATE DATABASE
// inside `ON polat.*`, which lets them do nothing whatsoever about creating a NEW
// database. Matching the privilege name anywhere in the text — which an earlier draft of
// this did — reads that member as a server administrator. So parse the line, keep the
// scope, and only count a privilege that is granted server-wide.

/** `GRANT a, b, c ON scope TO user [WITH GRANT OPTION]` -> {privs:[…], scope} | null */
function parseGrantLine(line) {
  const m = /^\s*GRANT\s+(.+?)\s+ON\s+(\S+)\s+TO\s+/i.exec(String(line || ''));
  if (!m) return null;
  const privs = m[1].split(',').map((p) => p.trim().toUpperCase()).filter(Boolean);
  return { privs, scope: m[2] };
}

/** Server-wide scope: `*.*` (tables everywhere) or `*` (the access/user namespace). */
function isServerWide(scope) {
  return scope === '*.*' || scope === '*';
}

function hasPriv(privs, name) {
  return privs.includes(name);
}

/**
 * Derive capabilities from the lines `SHOW GRANTS FOR <user>` returned.
 *
 * @param {string[]|string} grants  one string per grant line, or the whole blob
 * @returns {{canMintUsers:boolean, canMintHouses:boolean, canProvision:boolean,
 *            canReadEveryHouse:boolean, canSeeUsers:boolean, isSuperuser:boolean}}
 */
function capabilitiesFrom(grants) {
  const lines = Array.isArray(grants) ? grants : String(grants || '').split('\n');
  let canMintUsers = false;
  let canMintHouses = false;
  let canReadEveryHouse = false;
  let canSeeUsers = false;

  for (const raw of lines) {
    const g = parseGrantLine(raw);
    if (!g) continue;
    const wide = isServerWide(g.scope);
    // SHOW USERS is the one every member has — never evidence of anything.
    if (hasPriv(g.privs, 'SHOW USERS')) canSeeUsers = true;
    if (!wide) continue;
    // Minting accounts. ACCESS MANAGEMENT is the umbrella; CREATE USER the specific.
    if (hasPriv(g.privs, 'ACCESS MANAGEMENT') || hasPriv(g.privs, 'CREATE USER')) canMintUsers = true;
    // Minting houses. `CREATE DATABASE` is the specific; bare `CREATE` is the umbrella
    // ClickHouse hands a superuser (what `deploy --local` grants), and `ALL` covers both.
    if (hasPriv(g.privs, 'CREATE DATABASE') || hasPriv(g.privs, 'CREATE') || hasPriv(g.privs, 'ALL')) canMintHouses = true;
    // Reading anyone's rooms — what separates an administrator's view from a member's.
    if (hasPriv(g.privs, 'SELECT') || hasPriv(g.privs, 'ALL')) canReadEveryHouse = true;
  }

  const canProvision = canMintUsers && canMintHouses;
  return {
    canMintUsers,
    canMintHouses,
    canProvision,
    canReadEveryHouse,
    canSeeUsers,
    isSuperuser: canProvision && canReadEveryHouse,
  };
}

module.exports = { capabilitiesFrom, parseGrantLine, isServerWide };
