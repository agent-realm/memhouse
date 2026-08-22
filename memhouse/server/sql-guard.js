// sql-guard.js — one construct-aware reader for SQL text, shared by every surface that
// hands a credential to something that might be talked into misusing it.
//
// It was written inline in the dashboard's `/api/query` route and lived there alone,
// because of a finding recorded in `memhouse/mcp/GRANTS.md`: a memhouse member holds
// `GRANT ALL ON <db>.*` and nothing global, so ClickHouse itself refused `url()`,
// `file()` and `remote()` — an application-side parser only re-derived a refusal the
// server already issued, with a worse error message. "ClickHouse enforces; memhouse
// declares" was the ruling, and the extraction planned for the MCP `sql` tool was cut.
//
// That premise was revoked from outside: `memhouse relocate` pulls the source house over
// `remoteSecure()`, so every member is now granted `REMOTE ON *.*` at invite and install
// time. Re-probed on a throwaway 25.11 with `readonly=2` pinned — exactly what the MCP
// `sql` tool sends — `remote('127.0.0.1:9000', 'system', 'one', …)` returns the row, an
// unreachable host times out rather than being denied, and the password argument folds a
// subquery, so a data-dependent value can leave in the handshake. `url()` and `file()`
// are still refused by the server; `remote()` no longer is.
//
// So the guard is no longer a duplicate of the server's boundary — it IS the boundary
// for dial-out, and it belongs on every surface where a model writes the SQL. Hence one
// module, tested directly, rather than a second parser written beside the first: a
// second parser is a second set of bypasses, and this one already paid for four of them
// (a quote inside a comment, a comment marker inside a string, a `$tag$` heredoc, and a
// `#` line comment — see `normalize`).
//
// The module is policy-free. It reports what the SQL text *is*; each caller decides what
// to refuse, because their answers differ: the dashboard also confines reads to the
// house's own database, while the MCP `sql` tool must not — reading a housemate's shared
// database by name is a feature there.

// Table functions a read surface may legitimately use. An allowlist, not a denylist:
// ClickHouse ships dozens of dial-out functions (`url`, `s3`, `mysql`, `postgresql`,
// `mongodb`, `hdfs`, `azureBlobStorage`, `remote`, `remoteSecure`, `cluster`,
// `clusterAllReplicas`, `jdbc`, `odbc`, `executable`, …) and adds more every release, so
// naming the safe five is the only list that stays correct.
//
// `view` and `merge` are deliberately absent. Both take a table expression or a database
// name as an ARGUMENT, so allowing them re-opens everything the list is for:
// `view(SELECT count() FROM system.tables)` returned 190, and
// `merge('other_db','^messages_')` returned 5,000 rows from a database the house does not
// own. A house's own team rooms are Merge TABLES, not calls to `merge()`.
const ALLOWED_TABLE_FNS = new Set(['numbers', 'values', 'null', 'generateseries', 'format']);

// Statement shapes that only read. Writes are refused by ClickHouse itself (the callers
// pin `readonly`), so this is a shape check, not the write gate.
const READ_STATEMENTS = ['SELECT', 'WITH', 'EXPLAIN', 'DESCRIBE', 'DESC', 'SHOW'];

// Strip every construct that can HIDE another construct's opening marker, in ONE pass,
// leaving text whose quotes, comments and heredocs cannot desync a scanner:
//
//   SELECT * FROM /* ' */ url('http://…')       a quote inside a comment
//   SELECT '--', url('http://…')                a comment marker inside a string
//   SELECT $d$'$d$ AS x, * FROM url('http://…') a quote inside a heredoc literal
//   SELECT * FROM # '⏎ url('http://…') --'      a quote inside a # comment
//
// Each one desyncs a scanner that does not model the construct it appears in; the first
// two were live bypasses of an earlier version of this code. ClickHouse supports
// `$tag$…$tag$` heredocs and treats `#` and `#!` as line comments as well as `--`.
//
// Single quotes are string LITERALS and collapse to `''`. Double quotes and backticks are
// IDENTIFIERS and their text must SURVIVE, or `FROM "url"(…)` hides the function name.
function normalize(sql) {
  let bare = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    const heredoc = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      let inner = '';
      while (i < sql.length) {
        if (sql[i] === '\\') { inner += sql.slice(i, i + 2); i += 2; continue; }
        if (sql[i] === quote) {
          if (quote === "'" && sql[i + 1] === "'") { inner += "''"; i += 2; continue; }
          i++; break;
        }
        inner += sql[i];
        i++;
      }
      bare += quote === "'" ? "''" : inner;
    } else if (heredoc) {
      const tag = heredoc[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      bare += "''";
    } else if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      bare += ' ';
    } else if (two === '--' || c === '#') {
      const nl = sql.indexOf('\n', i);
      i = nl === -1 ? sql.length : nl;
      bare += ' ';
    } else {
      bare += c;
      i++;
    }
  }
  return bare;
}

// The leading keyword of normalised text, upper-cased ('' for empty input).
function firstKeyword(bare) {
  return (bare.trim().split(/\s+/)[0] || '').toUpperCase();
}

// Every identifier-call that appears where a TABLE EXPRESSION goes — the only place a
// table function can be introduced.
//
// Checking every call inside a FROM clause refused ordinary read SQL: `count()` and
// `any()` in a derived table, `USING (…)`, `toString()` in an ON condition,
// `splitByChar()` in an ARRAY JOIN. That is the shape of memhouse's own session rollup,
// on the surfaces whose job is querying transcripts. A table expression follows FROM,
// JOIN or a comma DIRECTLY, at the same paren depth — anything nested inside parentheses
// is a subquery or an argument, not a table function introduced here.
//
// Both qualifiers are load-bearing. Without the depth rule, `FROM (SELECT session_id,
// count() AS c FROM …)` reads the comma in the SELECT list as a table separator and
// refuses `count()`. Without excluding ARRAY JOIN, `ARRAY JOIN splitByChar(',', text)`
// matches on JOIN and refuses `splitByChar()`.
//
// ON and USING do NOT end the FROM clause — they are part of a JOIN, and a comma join can
// follow them: `FROM a JOIN b ON 1=1, file('/etc/hostname')` is ordinary SQL and walked
// straight through when they were listed as clause enders. Neither does a quoted alias
// that merely SPELLS one of these words: `FROM numbers(1) AS "WHERE", file(…)` was the
// same bypass with two characters of disguise. Only a keyword in KEYWORD POSITION ends
// the clause — one that was not just introduced by AS.
function tableFunctions(bare) {
  const CLAUSE_END = /^(WHERE|PREWHERE|GROUP|ORDER|LIMIT|HAVING|SETTINGS|UNION|INTO|FORMAT|WINDOW|QUALIFY)$/i;
  const found = [];
  const inFrom = [];
  let depth = 0;
  // Three tokens of history: at the '(' we need the identifier (prev), what introduced it
  // (prevPrev), and what preceded THAT (prev3) — because distinguishing `JOIN f(` from
  // `ARRAY JOIN f(` needs the token before the JOIN.
  let prev = '';        // previous significant token, upper-cased
  let prevPrev = '';
  let prev3 = '';
  const tok = /[A-Za-z_][A-Za-z0-9_]*|[(),]|[^\s(),]+/g;
  let m;
  while ((m = tok.exec(bare)) !== null) {
    const raw = m[0];
    const up = raw.toUpperCase();
    if (raw === '(') {
      // An identifier immediately before '(' is a call; decide it here, where we still
      // know what preceded the identifier.
      const isCall = /^[A-Za-z_][A-Za-z0-9_]*$/.test(prev === '' ? '' : bare.slice(0, m.index).match(/[A-Za-z_][A-Za-z0-9_]*\s*$/)?.[0]?.trim() || '');
      if (isCall) {
        const name = bare.slice(0, m.index).match(/([A-Za-z_][A-Za-z0-9_]*)\s*$/)[1];
        const introducer = prevPrev;
        const tablePos = (introducer === 'FROM')
          || (introducer === 'JOIN' && prev3 !== 'ARRAY')
          || (introducer === ',' && inFrom[depth]);
        if (tablePos) found.push(name);
      }
      depth++;
      prev3 = prevPrev; prevPrev = prev; prev = raw;
      continue;
    }
    if (raw === ')') { depth = Math.max(0, depth - 1); prev3 = prevPrev; prevPrev = prev; prev = raw; continue; }
    // `prev === 'AS'` means this token is an ALIAS, whatever it spells. A quoted alias
    // arrives here as its bare text (normalize keeps identifier content so that
    // `FROM "url"(…)` is still visible), so `AS "WHERE"` would otherwise close the clause.
    const isAlias = prev === 'AS';
    if (up === 'FROM' && !isAlias) inFrom[depth] = true;
    else if (CLAUSE_END.test(up) && !isAlias) inFrom[depth] = false;
    prev3 = prevPrev; prevPrev = prev; prev = (raw === ',') ? ',' : up;
  }

  // DESCRIBE takes a table expression too, with no FROM at all, and schema inference on
  // `DESCRIBE url('http://…')` dials out.
  if (['DESCRIBE', 'DESC'].includes(firstKeyword(bare))) {
    const after = bare.trim().replace(/^\w+\s+/, '').replace(/^TABLE\s+/i, '');
    const d = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(after);
    if (d) found.push(d[1]);
  }
  return found;
}

// The whole check for a surface that only needs to stop the query from leaving this
// server: returns the name of the first disallowed table function, or null.
//
// Deliberately NOT a statement-shape or cross-database check — those are the dashboard's
// policy, and the MCP `sql` tool must keep reading a housemate's shared database by name.
function disallowedTableFunction(sql) {
  for (const name of tableFunctions(normalize(sql))) {
    if (!ALLOWED_TABLE_FNS.has(name.toLowerCase())) return name;
  }
  return null;
}

module.exports = { ALLOWED_TABLE_FNS, READ_STATEMENTS, normalize, firstKeyword, tableFunctions, disallowedTableFunction };
