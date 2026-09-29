#!/usr/bin/env bash
# Initial deployment to the existing Alibaba Cloud Caddy web root.
set -euo pipefail
umask 022
test "$(id -u)" -eq 0
test -d /var/www/qdstorm
test ! -e /var/www/qdstorm/rover
test ! -L /var/www/qdstorm/rover
systemctl is-active --quiet caddy
ROVER_WORK=$(mktemp -d /var/tmp/rover-install.XXXXXXXX)
curl -fL --retry 2 --connect-timeout 15 --max-time 90 'https://codeload.github.com/loyee001/xinduyuhang/tar.gz/c1cf90fdfe44c13d52e752c57f52ef0d8bf6d4d0' -o "$ROVER_WORK/source.tar.gz"
printf '%s  %s\n' ae4ec82168ba5f3a92a5d699b439fc487291144f38ba1cd5987257cdeebbcea2 "$ROVER_WORK/source.tar.gz" | sha256sum -c -
ROVER_STAGE=$(mktemp -d /var/www/qdstorm/.rover-release.XXXXXXXX)
python3 - "$ROVER_WORK/source.tar.gz" "$ROVER_STAGE" <<'ROVER_FILES'
import hashlib, os, sys, tarfile
from pathlib import Path
expected = {
    'app.js': '54ade66b7a5de6bb3e361175a09d251d3fbe55e2fa4a42427fb92b164610d3db',
    'health.json': 'eff90b5019f263e6ff7eb27b2be9f68ed419422e17a58de1aac58bb4e9e2aa4b',
    'index.html': 'b0fbace959ed6422ccd8c09c839d533fcf2eb96c6fb46b9ce034c59a1b747b1a',
    'physics.js': 'b23649bf6ff00a74755c7e070fb9916f212f89bf99e05c348ce1d5e1dcbbac0e',
    'simulator.js': 'efb0531a5e5d49c3b46316dd26759d5f1a930ac7a28c72ee245c10c7b171fbad',
    'style.css': '18f53e0e61c86159af16e3659e5e81f51925716fc834b259464011f0670d45f3',
}
stage = Path(sys.argv[2])
with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for name, digest in expected.items():
        source = archive.getmember('xinduyuhang-c1cf90fdfe44c13d52e752c57f52ef0d8bf6d4d0/dist/' + name)
        assert source.isfile(), name
        content = archive.extractfile(source).read()
        if name == 'index.html':
            for asset in ('style.css', 'physics.js', 'simulator.js', 'app.js'):
                old = ('"/' + asset + '"').encode()
                assert content.count(old) == 1, asset
                content = content.replace(old, ('"./' + asset + '"').encode())
        elif name == 'app.js':
            old = b"fetch('/health.json?t='"
            assert content.count(old) == 1
            content = content.replace(old, b"fetch('./health.json?t='")
        assert hashlib.sha256(content).hexdigest() == digest, name
        with (stage / name).open('xb') as output:
            output.write(content)
        os.chmod(str(stage / name), 0o644)
        print('VERIFIED ' + name)
os.chmod(str(stage), 0o755)
PY
ln -sT "$ROVER_STAGE" /var/www/qdstorm/rover
curl -fsS --connect-timeout 5 --max-time 10 -H 'Host: 39.97.244.43' http://127.0.0.1/rover/health.json
printf '\nROVER_LIVE http://39.97.244.43/rover/\nRELEASE=%s\n' "$ROVER_STAGE"
