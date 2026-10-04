"""This repo's dry-run hooks — the only part of the dry-run that is yours.

gentar/dryrun.py is the kit's file and stays byte-identical to the pinned
engine's copy (`gentar/run.sh --check` compares), so everything a subject
needs to adapt lives here. Any name left out keeps dryrun.py's default.
REPO below is the checkout, for a prepare() that builds from it.
"""
import hashlib
import os
import platform
import tarfile
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent

# Steps whose substring appears here are skipped verbatim (prepare()
# already did the equivalent locally). Example: ("docker build",).
# Both suites start by installing Node 24 into /usr/local with sudo, as a
# bench needs. Never on the host that runs the dry-run: prepare() stages it
# in the scratch home instead.
SKIP_STEP_SUBSTR = ("nodejs.org/dist",)

# Executables that must NEVER be found on your real PATH while a suite
# runs. Two reasons to list one:
#   - your suites CREATE it (a launcher, an alias binary), so finding
#     the installed copy would let a broken install pass;
#   - your code CALLS it and a bench does not have it, so finding it here
#     would let a suite pass that fails on the bench. (claude-playbooks'
#     CLI runs `pilot` on every create; benches have no `pilot`.)
# Anything prepare() installs into the scratch ~/.local/bin is hidden
# automatically; list only what it does not. Example: ("cpb", "pilot").
# memhouse: the suites install it themselves, so the host's copy must
# never answer for a broken install.
HIDE_FROM_PATH = ("memhouse",)


# Bench templates that supply tools a dry-run host lacks (a CLI baked into
# the template from a private repo, say). For a suite whose `template` is a
# key here, the value decides:
#   a function(env) -> True    it installed the REAL tool into
#                              env["HOME"] + "/.local/bin"; the suite runs
#   ... -> False, or None      it cannot here (no source on this host); the
#                              suite reports UNVERIFIED, naming the template
#   ... raises                 the stager is broken: a FAILURE
# Never stage a stub: a suite that passes against a fake proves nothing.
# Templates not listed run as before. Example:
#   TEMPLATES = {"my-bench-v1": stage_my_cli}
TEMPLATES = {}


def prepare(env: dict) -> None:
    """Build/stage what a suite needs, in that suite's fresh home.

    Runs PER SUITE, not once per sweep: every suite gets its own scratch
    home and workspace, as every scenario gets its own bench. And only for
    the suites it stands in for: with SKIP_STEP_SUBSTR set, prepare() runs
    for a suite that has a step matching it, and for no other — so a build
    cannot shadow what an unrelated suite installs. With SKIP_STEP_SUBSTR
    empty it runs for every suite. Fixtures EVERY suite needs therefore
    belong in the suites' own steps, or leave SKIP_STEP_SUBSTR empty. If
    your scenarios assume a built binary or generated fixtures, do it
    here (REPO is the checkout; env["HOME"] is this suite's scratch home;
    env["WORKSPACE_DIR"] its staged checkout). Put the subject's own
    binaries in env["HOME"] + "/.local/bin": whatever lands there is
    hidden from the real PATH for the suite (see sealed_path). Expensive
    builds should cache outside HOME and copy in — `go build` and most
    compilers already cache on their own.
    """
    # memhouse needs Node >= 24 (README, package.json engines). Stage the
    # official latest v24 build, SHA256-checked against nodejs.org's list and
    # cached outside the scratch home, as node/npm/npx in the scratch bin.
    # npm's global prefix is the scratch ~/.local, so the suites'
    # `npm install -g` lands in ~/.local/{bin,lib} as on a bench, never in the
    # host's (root-owned) prefix.
    home = Path(env["HOME"])
    bindir = home / ".local" / "bin"
    bindir.mkdir(parents=True, exist_ok=True)
    cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "gentar-dryrun"
    root = _node24(cache)
    for tool in ("node", "npm", "npx"):
        dst = bindir / tool
        if dst.exists() or dst.is_symlink():
            dst.unlink()
        dst.symlink_to(root / "bin" / tool)
    env["NPM_CONFIG_PREFIX"] = str(home / ".local")


def _node24(cache: Path) -> Path:
    """The latest official Node 24 for this host, extracted under `cache`."""
    oses = {"Linux": "linux", "Darwin": "darwin"}
    arches = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64"}
    here = f"{platform.system()}/{platform.machine()}"
    if platform.system() not in oses or platform.machine().lower() not in arches:
        raise RuntimeError(f"no official Node 24 build for {here} (linux or darwin, x64 or arm64)")
    suffix = f"-{oses[platform.system()]}-{arches[platform.machine().lower()]}.tar.gz"
    base = "https://nodejs.org/dist/latest-v24.x"
    sums = urllib.request.urlopen(f"{base}/SHASUMS256.txt", timeout=60).read().decode()
    found = [line.split() for line in sums.splitlines()
             if line.endswith(suffix) and line.split()[1].startswith("node-v24.")]
    if not found:
        raise RuntimeError(f"{base}/SHASUMS256.txt lists no Node 24 build for {here}")
    digest, name = found[0]
    root = cache / name[: -len(".tar.gz")]
    if (root / "bin" / "node").exists():
        return root
    data = urllib.request.urlopen(f"{base}/{name}", timeout=600).read()
    if hashlib.sha256(data).hexdigest() != digest:
        raise RuntimeError(f"{name}: checksum does not match nodejs.org's SHASUMS256.txt")
    cache.mkdir(parents=True, exist_ok=True)
    tgz = cache / name
    tgz.write_bytes(data)
    with tarfile.open(tgz) as tf:
        _extract(tf, cache)
    tgz.unlink()
    return root


def _extract(tf: tarfile.TarFile, dest: Path) -> None:
    """Extract without leaving `dest`. Python 3.12 (and 3.8.17, 3.9.17,
    3.10.12, 3.11.4) has the "data" filter; older ones get the same rules
    by hand: no absolute or `..` paths, no links pointing out, no devices."""
    if hasattr(tarfile, "data_filter"):
        tf.extractall(dest, filter="data")
        return
    base = os.path.realpath(dest)
    def inside(p):
        return os.path.realpath(p) == base or os.path.realpath(p).startswith(base + os.sep)
    for m in tf.getmembers():
        target = os.path.join(base, m.name)
        if os.path.isabs(m.name) or not inside(target):
            raise RuntimeError(f"unsafe path in the Node tarball: {m.name}")
        if m.issym() and (os.path.isabs(m.linkname)
                          or not inside(os.path.join(os.path.dirname(target), m.linkname))):
            raise RuntimeError(f"unsafe link in the Node tarball: {m.name} -> {m.linkname}")
        if m.islnk() and not inside(os.path.join(base, m.linkname)):
            raise RuntimeError(f"unsafe hard link in the Node tarball: {m.name}")
        if m.isdev():
            raise RuntimeError(f"device file in the Node tarball: {m.name}")
    tf.extractall(dest)
