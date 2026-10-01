#!/usr/bin/env bash
# Update only the existing Rover static site; never edit or reload Caddy.
set -Eeuo pipefail
umask 077

usage() {
  printf 'Usage: bash %s [--check] <40-character GitHub commit SHA>\n' "$0" >&2
  exit 2
}
ROVER_CHECK=0
if [[ ${1:-} == --check ]]; then ROVER_CHECK=1; shift; fi
[[ $# == 1 && $1 =~ ^[0-9a-f]{40}$ ]] || usage
ROVER_COMMIT=$1
ROVER_ROOT=/var/www/qdstorm
ROVER_ENTRY=$ROVER_ROOT/rover
ROVER_LOCK=/run/lock/rover-static-update.lock
ROVER_WORK=''
ROVER_STAGE=''
ROVER_OLD=''
ROVER_TEMP_LINK=''
ROVER_LOCKED=0
ROVER_SWITCHED=0
ROVER_COMMITTED=0

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
[[ $(id -u) == 0 ]] || fail 'Run on the existing Aliyun server as root.'
for ROVER_TOOL in curl python3 sha256sum systemctl mktemp readlink ln mv; do
  command -v "$ROVER_TOOL" >/dev/null || fail "Missing command: $ROVER_TOOL"
done

finish() {
  local result=$?
  trap - EXIT
  set +e
  if [[ $ROVER_SWITCHED == 1 && $ROVER_COMMITTED == 0 ]]; then
    if [[ -L $ROVER_ENTRY && $(readlink -f -- "$ROVER_ENTRY") == "$ROVER_STAGE" ]]; then
      local rollback_link=$ROVER_ROOT/.rover-rollback.${ROVER_WORK##*/}
      if ln -sT -- "$ROVER_OLD" "$rollback_link" && mv -Tf -- "$rollback_link" "$ROVER_ENTRY"; then
        printf 'ROLLED_BACK=%s\n' "$ROVER_OLD" >&2
      else
        printf 'ROLLBACK_FAILED: restore %s to %s manually.\n' "$ROVER_ENTRY" "$ROVER_OLD" >&2
      fi
    elif [[ -L $ROVER_ENTRY && $(readlink -f -- "$ROVER_ENTRY") == "$ROVER_OLD" ]]; then
      printf 'UNCHANGED: original release is still active.\n' >&2
    else
      printf 'ROLLBACK_SKIPPED: the site link changed concurrently; inspect it before recovery.\n' >&2
    fi
    result=1
  fi
  if [[ -n $ROVER_TEMP_LINK && -L $ROVER_TEMP_LINK && $(readlink -- "$ROVER_TEMP_LINK") == "$ROVER_STAGE" ]]; then
    rm -- "$ROVER_TEMP_LINK"
  fi
  [[ $ROVER_LOCKED == 0 ]] || rmdir -- "$ROVER_LOCK"
  [[ -z $ROVER_WORK ]] || printf 'RECORDS=%s\n' "$ROVER_WORK"
  exit "$result"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ $ROVER_CHECK == 0 ]]; then
  mkdir -- "$ROVER_LOCK" || fail "Another update is active, or a stale lock needs inspection: $ROVER_LOCK"
  ROVER_LOCKED=1
fi
systemctl is-active --quiet caddy || fail 'Caddy is not active.'
# Resolve the real target, not just a string prefix; reject files, broken
# links, and releases outside this site's web-root directory.
ROVER_OLD=$(python3 - "$ROVER_ROOT" "$ROVER_ENTRY" <<'ROVER_PREFLIGHT'
import sys
from pathlib import Path
root, entry = map(Path, sys.argv[1:])
if not root.is_dir() or not entry.is_symlink():
    raise SystemExit('Expected an existing Rover symlink inside the Caddy web root.')
target = entry.resolve(strict=True)
if target.parent != root.resolve(strict=True) or not target.name.startswith('.rover-release.') or not target.is_dir():
    raise SystemExit('Existing Rover release is outside the allowed release directory.')
print(target)
ROVER_PREFLIGHT
)
ROVER_WORK=$(mktemp -d /var/tmp/rover-update.XXXXXXXX)
printf '%s\n' "$ROVER_OLD" > "$ROVER_WORK/previous-release.txt"
printf '%s\n' "$ROVER_COMMIT" > "$ROVER_WORK/commit.txt"
printf 'PREVIOUS_RELEASE=%s\nCOMMIT=%s\n' "$ROVER_OLD" "$ROVER_COMMIT"
curl --proto '=https' --tlsv1.2 -fL --retry 2 --connect-timeout 15 --max-time 120 \
  "https://codeload.github.com/loyee001/xinduyuhang/tar.gz/$ROVER_COMMIT" \
  -o "$ROVER_WORK/source.tar.gz"
sha256sum "$ROVER_WORK/source.tar.gz" > "$ROVER_WORK/archive.sha256"
if [[ $ROVER_CHECK == 1 ]]; then
  ROVER_STAGE=$(mktemp -d "$ROVER_WORK/check.XXXXXXXX")
else
  ROVER_STAGE=$(mktemp -d "$ROVER_ROOT/.rover-release.XXXXXXXX")
fi
ROVER_STAGE=$(readlink -f -- "$ROVER_STAGE")

python3 - "$ROVER_WORK/source.tar.gz" "$ROVER_COMMIT" "$ROVER_STAGE" "$ROVER_WORK/SHA256SUMS" <<'ROVER_VERIFY'
import hashlib
import os
import re
import sys
import tarfile
from pathlib import Path

archive_path, commit, stage_path, manifest_path = sys.argv[1:]
allowed = {
    'index.html', 'style.css', 'app.js', 'physics.js', 'road.js',
    'traffic.js', 'lane-control.js', 'simulator.js', 'commands.js',
    'autopilot.js', 'health.json',
}
prefix = 'xinduyuhang-' + commit + '/'
stage = Path(stage_path)
with tarfile.open(archive_path, 'r:gz') as archive:
    members = {}
    for member in archive.getmembers():
        if member.name in members:
            raise SystemExit('Duplicate archive entry: ' + member.name)
        members[member.name] = member
    manifest_member = members.get(prefix + 'deploy/SHA256SUMS')
    if not manifest_member or not manifest_member.isfile() or manifest_member.size > 16384:
        raise SystemExit('Missing or invalid commit-specific deploy/SHA256SUMS.')
    manifest = archive.extractfile(manifest_member).read().decode('ascii')
    expected = {}
    for line in manifest.splitlines():
        match = re.fullmatch(r'([0-9a-f]{64})  ([a-z0-9.-]+)', line)
        if not match or match[2] not in allowed or match[2] in expected:
            raise SystemExit('Invalid or duplicate SHA256SUMS entry: ' + line)
        expected[match[2]] = match[1]
    if set(expected) != allowed:
        raise SystemExit('SHA256SUMS must contain exactly all 11 current static files.')
    dist_members = {
        name[len(prefix + 'dist/'):]: member
        for name, member in members.items() if name.startswith(prefix + 'dist/')
    }
    if set(dist_members) != allowed:
        raise SystemExit('The commit dist directory does not match the 11-file allowlist.')
    contents = {}
    for name in sorted(allowed):
        member = dist_members[name]
        if not member.isfile() or member.size <= 0 or member.size > 5 * 1024 * 1024:
            raise SystemExit('Not a supported regular static file: ' + name)
        content = archive.extractfile(member).read()
        if hashlib.sha256(content).hexdigest() != expected[name]:
            raise SystemExit('Source checksum mismatch: ' + name)
        contents[name] = content
    # No archive path or link is extracted; only these verified bytes are used.
    for name, content in contents.items():
        destination = stage / name
        with destination.open('xb') as output:
            output.write(content)
        os.chmod(str(destination), 0o644)
        if hashlib.sha256(destination.read_bytes()).hexdigest() != expected[name]:
            raise SystemExit('Written checksum mismatch: ' + name)
        print('VERIFIED ' + name)
    Path(manifest_path).write_text(manifest, encoding='ascii')
    os.chmod(str(stage), 0o755)
ROVER_VERIFY

if [[ $ROVER_CHECK == 1 ]]; then
  printf 'CHECK_OK: all 11 files verified; live site unchanged.\n'
  exit 0
fi

systemctl is-active --quiet caddy || fail 'Caddy stopped before the link switch.'
[[ -L $ROVER_ENTRY && $(readlink -f -- "$ROVER_ENTRY") == "$ROVER_OLD" ]] || fail 'The live release changed during preparation.'
ROVER_TEMP_LINK=$ROVER_ROOT/.rover-link.${ROVER_WORK##*/}
ln -sT -- "$ROVER_STAGE" "$ROVER_TEMP_LINK"
# Set the rollback guard before mv, so a signal immediately after mv is safe.
ROVER_SWITCHED=1
mv -Tf -- "$ROVER_TEMP_LINK" "$ROVER_ENTRY"
printf '%s\n' "$ROVER_STAGE" > "$ROVER_WORK/new-release.txt"

# Check health first, then require the Caddy-served bytes of every static file
# to equal the pinned commit. Any failure triggers the EXIT rollback above.
mkdir -- "$ROVER_WORK/http"
curl -fsS --retry 2 --connect-timeout 5 --max-time 15 -H 'Host: 39.97.244.43' \
  "http://127.0.0.1/rover/health.json?release=$ROVER_COMMIT" -o "$ROVER_WORK/http/health.json"
while read -r ROVER_DIGEST ROVER_FILE; do
  if [[ $ROVER_FILE != health.json ]]; then
    curl -fsS --retry 2 --connect-timeout 5 --max-time 15 -H 'Host: 39.97.244.43' \
      "http://127.0.0.1/rover/$ROVER_FILE?release=$ROVER_COMMIT" -o "$ROVER_WORK/http/$ROVER_FILE"
  fi
  [[ $(sha256sum "$ROVER_WORK/http/$ROVER_FILE" | cut -d ' ' -f 1) == "$ROVER_DIGEST" ]] || fail "HTTP checksum mismatch: $ROVER_FILE"
  printf 'HTTP_VERIFIED %s\n' "$ROVER_FILE"
done < "$ROVER_WORK/SHA256SUMS"
systemctl is-active --quiet caddy || fail 'Caddy is no longer active.'
[[ -L $ROVER_ENTRY && $(readlink -f -- "$ROVER_ENTRY") == "$ROVER_STAGE" ]] || fail 'The live release changed during verification.'
ROVER_COMMITTED=1
printf 'ROVER_LIVE=http://39.97.244.43/rover/\nRELEASE=%s\nPREVIOUS_RELEASE=%s\n' "$ROVER_STAGE" "$ROVER_OLD"
