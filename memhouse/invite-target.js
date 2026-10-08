// Where `invite` may send a credential — and the one place that decides it (G4).
//
// `--url` is the address the INVITEE will reach the house at. It goes into the invite file;
// it is typed on a command line, so it can be a typo, a tunnel, or somebody else's server.
// A credential this install KEEPS — the member's own, or an admin saved with --keep-admin —
// belongs to the house it was saved for, and is only ever sent there. Before 0.18.11 the
// stored credential was sent to `--url`: resolveConfig() lets the flag outrank the env file,
// so `cfg.url` WAS `--url`, and the reachability probe, the grants read and the provisioning
// all authenticated against whatever `--url` named.
//
// A credential given for THIS command — `--admin-user`, or an exported MEMHOUSE_ADMIN_USER,
// with a password from a file, stdin, the environment or a prompt — was chosen by the person
// who also typed `--url`, so it provisions there, as it always has.
//
// Pure, so it is unit tested.

/**
 * @param {object} o
 * @param {string} o.url              the invitee-facing --url
 * @param {string|null} o.storedUrl   the house this install is configured for (env or env file)
 * @param {'flag'|'env'|'file'|'member'} o.adminUserSource
 *        where the credential's USER came from: --admin-user, an exported MEMHOUSE_ADMIN_USER,
 *        the env file's MEMHOUSE_ADMIN_USER, or (no admin at all) the member credential
 * @param {string|null} [o.passwordSource]  resolveAdminPassword's `source` ('stored' = the env file)
 * @returns {{ url: string, stored: boolean } | { error: string }}
 */
function provisionTarget({ url, storedUrl, adminUserSource, passwordSource = null }) {
  const stored = adminUserSource === 'file' || adminUserSource === 'member' || passwordSource === 'stored';
  if (!stored) return { url, stored: false };
  if (!storedUrl) {
    return { error: 'this install keeps no house URL to send its stored credential to — '
      + 'give the admin for this command instead (--admin-user, password from MEMHOUSE_ADMIN_PASSWORD or --admin-password-file)' };
  }
  return { url: storedUrl, stored: true };
}

module.exports = { provisionTarget };
