// Local ClickHouse delivery — the missing first mile.
//
// Every install path assumes a reachable ClickHouse. This stands one up.
//
// Deliberately does NOT depend on compose. memhouse needs exactly one container, and a
// compose provider is not a given: the testbed VM has podman 4.9.3 with no compose
// provider at all (`podman compose` → "looking up compose provider failed"), and
// podman-compose/docker-compose are absent. Everything compose bought us here — a named
// volume, a loopback port binding, env, a restart policy — is one `run` flag each.
// deploy/compose.yml stays for people who prefer it; nothing in the CLI needs it.
//
// The stock upstream server image is used as-is. Nothing bakes the memhouse checkout
// into an image; memhouse stays on the host and connects over HTTP.

const { spawnSync } = require('child_process');

const CONTAINER = 'memhouse-clickhouse';
const VOLUME = 'memhouse-data';
const DEFAULT_TAG = '25.11';
// Fully qualified on purpose. docker resolves a short name against Docker Hub; podman
// refuses unless unqualified-search registries are configured, which they are not on a
// stock Debian/Ubuntu install:
//   short-name "clickhouse/clickhouse-server:25.11" did not resolve to an alias and no
//   unqualified-search registries are defined in "/etc/containers/registries.conf"
const IMAGE_REPO = 'docker.io/clickhouse/clickhouse-server';

// Ownership label. `memhouse-clickhouse` and `memhouse-data` are fixed names, so without
// a marker a name collision with somebody else's container would let `deploy --local`
// (which replaces) or `deploy --down` (which removes) destroy an unrelated workload and
// its data. Anything we did not create is refused, never removed.
const OWNER_LABEL = 'com.memhouse.managed';

/** Every container engine on PATH, in preference order. */
function availableEngines() {
  return ['docker', 'podman'].filter((e) => spawnSync(e, ['--version'], { encoding: 'utf-8' }).status === 0);
}

/**
 * The engine that OWNS the managed resources, not merely the first one installed.
 *
 * Picking by executable order is wrong the moment a machine has both: a house created
 * with podman becomes invisible when docker is installed later, so the ownership checks
 * report the fixed names absent, and the next deploy adopts or creates a different house
 * and overwrites the only persisted credential for a volume that is still initialised.
 *
 * Returns { engine, ambiguous, engines }. `ambiguous` means both engines hold something
 * under our names, which no caller may guess its way through.
 */
function owningEngine() {
  // An explicit pin wins over all of this. It is the escape hatch for the indeterminate
  // case below, which is otherwise unresolvable from here.
  const pinned = process.env.MEMHOUSE_ENGINE;
  if (pinned) {
    return { engine: pinned, ambiguous: false, engines: [pinned], pinned: true };
  }
  const engines = availableEngines();
  if (!engines.length) return { engine: null, ambiguous: false, engines };

  const owners = [];
  const indeterminate = [];
  for (const e of engines) {
    const states = [ownership(e, 'container', CONTAINER), ownership(e, 'volume', VOLUME)];
    if (states.includes('ours')) owners.push(e);
    // `unknown` means this engine could not tell us — an unreachable daemon, most
    // likely. Discarding it would let ANOTHER engine's 'ours' look unambiguous while
    // the silent one owns the house we are about to replace or remove. It is not
    // evidence of absence, so it cannot be dropped from the count.
    else if (states.includes('unknown')) indeterminate.push(e);
  }
  if (owners.length > 1) return { engine: null, ambiguous: true, engines, owners };
  if (indeterminate.length) return { engine: null, indeterminate, engines, owners };
  return { engine: owners[0] || engines[0], ambiguous: false, engines };
}

/** The engine to act through, or null if there is none. Ambiguity resolves to null. */
function engine() {
  const o = owningEngine();
  return o.ambiguous ? null : o.engine;
}

// The engine says "no such object" when a name is free, and says other things when it
// cannot answer at all — an unreachable daemon being the obvious one. Both are non-zero
// exits, and collapsing them made an unreachable daemon look like a clean slate: `--down`
// would then report success with nothing removed, over a container that is still running.
//
// The pattern must name the KIND of object that is missing. A bare `/no such/` was too
// broad in exactly the direction that matters, because an unreachable engine says
// `Cannot connect ... stat /run/user/1000/podman/podman.sock: no such file or directory`.
// docker says `No such object: NAME` / `No such container: NAME`, podman says
// `no such container NAME`; no socket error names a container, volume or image.
const NOT_FOUND = /no such (object|container|volume|image)\b/i;

/** 'absent' | 'ours' | 'foreign' | 'unknown' — for a container or a volume. */
function ownership(eng, kind, name) {
  const args = kind === 'volume'
    ? ['volume', 'inspect', '-f', `{{index .Labels "${OWNER_LABEL}"}}`, name]
    : ['inspect', '-f', `{{index .Config.Labels "${OWNER_LABEL}"}}`, name];
  const r = spawnSync(eng, args, { encoding: 'utf-8' });
  if (r.error) return 'unknown';
  if (r.status !== 0) {
    return NOT_FOUND.test(`${r.stderr || ''}${r.stdout || ''}`) ? 'absent' : 'unknown';
  }
  // Go's template prints `<no value>` for a missing key, empty for a present-but-empty
  // one; both mean the object exists and is not ours.
  return (r.stdout || '').trim() === '1' ? 'ours' : 'foreign';
}

function unknownMsg(kind, name, eng) {
  return `cannot determine whether ${kind} '${name}' exists — ${eng} answered neither `
    + '"no such object" nor a label. Is the daemon reachable? Refusing to guess.';
}

function foreignMsg(kind, name) {
  return `refusing to touch ${kind} '${name}': it exists but was not created by memhouse `
    + `(no ${OWNER_LABEL} label). Remove or rename it yourself if it is disposable.`;
}

/**
 * Start the house container. Returns { ok, url, password, engine, msg }.
 * The password is required — an unauthenticated house on a laptop is how agent
 * transcripts leak to anything that can reach the port. The port binds to loopback
 * for the same reason.
 */
function up({ password, port = 8123, tag = DEFAULT_TAG, user = 'memhouse_root' }) {
  const o = owningEngine();
  if (o.ambiguous || o.indeterminate) return { ok: false, msg: ambiguousMsg(o) };
  const eng = o.engine;
  if (!eng) return { ok: false, msg: 'neither docker nor podman found on PATH' };
  if (!password) return { ok: false, msg: 'refusing to start an unauthenticated house — no password given' };

  const own = ownership(eng, 'container', CONTAINER);
  if (own === 'foreign') return { ok: false, engine: eng, msg: foreignMsg('container', CONTAINER) };
  if (own === 'unknown') return { ok: false, engine: eng, msg: unknownMsg('container', CONTAINER, eng) };
  const volOwn = ownership(eng, 'volume', VOLUME);
  if (volOwn === 'foreign') return { ok: false, engine: eng, msg: foreignMsg('volume', VOLUME) };
  if (volOwn === 'unknown') return { ok: false, engine: eng, msg: unknownMsg('volume', VOLUME, eng) };

  // Make sure the replacement image is actually available BEFORE removing the house it
  // replaces. `run` discovers a bad tag or an unreachable registry only after the old
  // container is gone, which takes a working house offline for a typo.
  const img = ensureImage(eng, tag);
  if (!img.ok) return { ok: false, engine: eng, msg: img.msg };
  const image = img.image;

  if (own === 'ours') spawnSync(eng, ['rm', '-f', CONTAINER], { encoding: 'utf-8' });

  // Create the volume explicitly so it carries the label. `run -v name:/path` would
  // create it unlabeled, and an unlabeled volume is one we then refuse to remove.
  let createdVolume = false;
  if (volOwn === 'absent') {
    const v = spawnSync(eng, ['volume', 'create', '--label', `${OWNER_LABEL}=1`, VOLUME], { encoding: 'utf-8' });
    if (v.status !== 0) return { ok: false, engine: eng, msg: (v.stderr || '').trim().split('\n').slice(-1)[0] };
    createdVolume = true;
  }

  const args = [
    'run', '-d',
    '--name', CONTAINER,
    '--label', `${OWNER_LABEL}=1`,
    '--restart', 'unless-stopped',
    '-e', `CLICKHOUSE_USER=${user}`,
    '-e', `CLICKHOUSE_PASSWORD=${password}`,
    // The house itself is created by `memhouse install`, not here: pre-creating it
    // would skip the step an install is supposed to prove.
    '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
    '-p', `127.0.0.1:${port}:8123`,
    '-v', `${VOLUME}:/var/lib/clickhouse`,
    '--ulimit', 'nofile=262144:262144',
    image,
  ];
  const r = spawnSync(eng, args, { encoding: 'utf-8' });
  if (r.status !== 0) {
    // The volume exists but the image never touched it — an unpullable tag, a port bind
    // that failed. Leaving it labelled would make the NEXT deploy read an empty volume as
    // an initialised house and refuse for a missing credential that was never set. Only
    // remove one this call created; an existing house's data is never at stake here.
    if (createdVolume) spawnSync(eng, ['volume', 'rm', '-f', VOLUME], { encoding: 'utf-8' });
    return { ok: false, engine: eng, msg: (r.stderr || '').trim().split('\n').slice(-2).join(' ') };
  }
  return { ok: true, engine: eng, url: `http://localhost:${port}`, password };
}

/**
 * Remove the container and its volume — but only the ones memhouse created. Needs no
 * password: nothing is contacted. Removing an unowned object is the destructive mistake
 * this guards, so a foreign name is an error, not a warning.
 */
function down() {
  const o = owningEngine();
  if (o.ambiguous || o.indeterminate) return { ok: false, msg: ambiguousMsg(o) };
  const eng = o.engine;
  if (!eng) return { ok: false, msg: 'neither docker nor podman found on PATH' };

  const cOwn = ownership(eng, 'container', CONTAINER);
  if (cOwn === 'foreign') return { ok: false, engine: eng, msg: foreignMsg('container', CONTAINER) };
  if (cOwn === 'unknown') return { ok: false, engine: eng, msg: unknownMsg('container', CONTAINER, eng) };
  const vOwn = ownership(eng, 'volume', VOLUME);
  if (vOwn === 'foreign') return { ok: false, engine: eng, msg: foreignMsg('volume', VOLUME) };
  if (vOwn === 'unknown') return { ok: false, engine: eng, msg: unknownMsg('volume', VOLUME, eng) };

  // Report what actually happened, not what was attempted. The engine can fail here —
  // the daemon going away between the ownership check and the removal is the obvious
  // way — and announcing "removed" over a container that is still running is how a user
  // ends up with a house they believe is gone. `containerRemoved` used to be true merely
  // because the container was OURS, which is a statement about ownership, not removal.
  const failures = [];
  let containerRemoved = false;
  if (cOwn === 'ours') {
    const r = spawnSync(eng, ['rm', '-f', CONTAINER], { encoding: 'utf-8' });
    containerRemoved = r.status === 0;
    if (!containerRemoved) failures.push(`container '${CONTAINER}': ${(r.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${r.status}`}`);
  }
  let volumeRemoved = false;
  if (vOwn === 'ours') {
    const v = spawnSync(eng, ['volume', 'rm', '-f', VOLUME], { encoding: 'utf-8' });
    volumeRemoved = v.status === 0;
    if (!volumeRemoved) failures.push(`volume '${VOLUME}': ${(v.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${v.status}`}`);
  }
  if (failures.length) return { ok: false, engine: eng, containerRemoved, volumeRemoved, msg: `removal failed — ${failures.join('; ')}` };
  return { ok: true, engine: eng, volumeRemoved, containerRemoved };
}

/** Poll /ping until the server answers. An install against a still-starting server
 *  fails in a way that looks like a bad credential, so never guess with a sleep. */
async function waitReady(url, { attempts = 60, delayMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${url}/ping`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* still starting */ }
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return false;
}

/** Does the managed data volume already exist and belong to us? */
function volumeExists() {
  const eng = engine();
  if (!eng) return false;
  return ownership(eng, 'volume', VOLUME) === 'ours';
}

function ambiguousMsg(o) {
  if (o.indeterminate) {
    return `${o.indeterminate.join(' and ')} could not say whether it holds '${CONTAINER}' or `
      + `'${VOLUME}' — an unreachable daemon looks the same as an empty one, and acting on the `
      + 'other engine could replace or remove the wrong house. Start it, or pin the engine '
      + `explicitly: MEMHOUSE_ENGINE=${(o.owners && o.owners[0]) || o.engines.find((e) => !o.indeterminate.includes(e)) || o.engines[0]}`;
  }
  return `both ${(o.owners || o.engines).join(' and ')} hold something named '${CONTAINER}' or `
    + `'${VOLUME}' with the ${OWNER_LABEL} label. Refusing to guess which house is yours — `
    + 'remove one of them, or run with only one engine on PATH.';
}

/**
 * Everything `up()` would refuse for, asked BEFORE the caller changes anything.
 * Returns { ok, msg, initialised }.
 *
 * `up()` checks ownership itself, but by the time it runs the CLI has already stopped
 * the shipper, the dashboard and the shim — so a refusal costs the user a working
 * pipeline in exchange for protecting them. The same questions, asked first.
 */
/**
 * `tag` OPT-IN. The solo tier calls this purely to ask whether a local house exists —
 * it runs embedded chdb and needs no container image at all, so validating one would
 * fail a perfectly good solo deploy whenever the registry is unreachable and the image
 * is not cached.
 */
function preflight({ tag = null } = {}) {
  const o = owningEngine();
  if (o.ambiguous || o.indeterminate) return { ok: false, reason: 'ambiguous', msg: ambiguousMsg(o) };
  const eng = o.engine;
  // `reason` matters to callers that are not deploying a local house. `no-engine` means
  // there cannot BE a local tier on this machine, which is a fine reason to go on and
  // deploy solo; `unknown` means the engine is there and could not answer, which is not
  // evidence of absence and must not be read as one.
  if (!eng) return { ok: false, reason: 'no-engine', msg: 'neither docker nor podman found on PATH' };
  // BOTH objects, before deciding anything. Returning on the first `foreign` hid the
  // state that actually matters to a caller asking "is there a house here": a foreign
  // container beside an initialised MANAGED volume. `deploy --solo` read that as "no
  // local house" and overwrote the credential for a volume nobody can reach afterwards.
  const states = {
    container: ownership(eng, 'container', CONTAINER),
    volume: ownership(eng, 'volume', VOLUME),
  };
  for (const [kind, name] of [['container', CONTAINER], ['volume', VOLUME]]) {
    if (states[kind] === 'unknown') return { ok: false, reason: 'unknown', engine: eng, states, msg: unknownMsg(kind, name, eng) };
  }
  for (const [kind, name] of [['container', CONTAINER], ['volume', VOLUME]]) {
    if (states[kind] === 'foreign') return { ok: false, reason: 'foreign', engine: eng, states, msg: foreignMsg(kind, name) };
  }
  // The image, too, when the caller is actually going to run one — `up()` checks it, but
  // by then the caller has stopped the shipper and the dashboard, so a bad tag costs a
  // working pipeline to discover.
  if (tag) {
    const img = ensureImage(eng, tag);
    if (!img.ok) return { ok: false, reason: 'image', engine: eng, msg: img.msg };
  }
  return { ok: true, engine: eng, states, initialised: states.volume === 'ours' };
}

/** Present locally, or pullable. Never removes anything. */
function ensureImage(eng, tag) {
  const image = `${IMAGE_REPO}:${tag}`;
  if (spawnSync(eng, ['image', 'inspect', image], { encoding: 'utf-8' }).status === 0) return { ok: true, image };
  const pull = spawnSync(eng, ['pull', image], { encoding: 'utf-8' });
  if (pull.status !== 0) {
    return {
      ok: false,
      image,
      msg: `cannot obtain ${image} — ${(pull.stderr || '').trim().split('\n').slice(-1)[0] || `exit ${pull.status}`}. `
        + 'The existing house was left running.',
    };
  }
  return { ok: true, image };
}

module.exports = {
  engine, owningEngine, availableEngines, ensureImage, up, down, waitReady, volumeExists, preflight,
  CONTAINER, VOLUME, DEFAULT_TAG,
  // exported for the unit gate: classifying an engine message wrong is silent
  _NOT_FOUND: NOT_FOUND,
};
