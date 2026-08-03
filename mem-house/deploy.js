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

/** docker or podman, whichever is present. Returns null if neither is. */
function engine() {
  for (const e of ['docker', 'podman']) {
    const r = spawnSync(e, ['--version'], { encoding: 'utf-8' });
    if (r.status === 0) return e;
  }
  return null;
}

function running(eng) {
  const r = spawnSync(eng, ['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}'], { encoding: 'utf-8' });
  return (r.stdout || '').trim() === CONTAINER;
}

/**
 * Start the house container. Returns { ok, url, password, engine, msg }.
 * The password is required — an unauthenticated house on a laptop is how agent
 * transcripts leak to anything that can reach the port. The port binds to loopback
 * for the same reason.
 */
function up({ password, port = 8123, tag = DEFAULT_TAG, user = 'memhouse_root' }) {
  const eng = engine();
  if (!eng) return { ok: false, msg: 'neither docker nor podman found on PATH' };
  if (!password) return { ok: false, msg: 'refusing to start an unauthenticated house — no password given' };

  if (running(eng)) {
    spawnSync(eng, ['rm', '-f', CONTAINER], { encoding: 'utf-8' });
  }

  const args = [
    'run', '-d',
    '--name', CONTAINER,
    '--restart', 'unless-stopped',
    '-e', `CLICKHOUSE_USER=${user}`,
    '-e', `CLICKHOUSE_PASSWORD=${password}`,
    // The house itself is created by `memhouse install`, not here: pre-creating it
    // would skip the step an install is supposed to prove.
    '-e', 'CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT=1',
    '-p', `127.0.0.1:${port}:8123`,
    '-v', `${VOLUME}:/var/lib/clickhouse`,
    '--ulimit', 'nofile=262144:262144',
    `${IMAGE_REPO}:${tag}`,
  ];
  const r = spawnSync(eng, args, { encoding: 'utf-8' });
  if (r.status !== 0) return { ok: false, engine: eng, msg: (r.stderr || '').trim().split('\n').slice(-2).join(' ') };
  return { ok: true, engine: eng, url: `http://localhost:${port}`, password };
}

/** Remove the container and its volume. Needs no password — nothing is contacted. */
function down() {
  const eng = engine();
  if (!eng) return { ok: false, msg: 'neither docker nor podman found on PATH' };
  spawnSync(eng, ['rm', '-f', CONTAINER], { encoding: 'utf-8' });
  const v = spawnSync(eng, ['volume', 'rm', '-f', VOLUME], { encoding: 'utf-8' });
  return { ok: true, engine: eng, volumeRemoved: v.status === 0 };
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

module.exports = { engine, up, down, waitReady, CONTAINER, VOLUME, DEFAULT_TAG };
