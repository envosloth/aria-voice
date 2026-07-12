#!/bin/sh
# Runs under pkexec. Keep this a fixed-argument helper: the Electron process
# never composes shell source from the downloaded filename or release metadata.
set -eu
PATH=/usr/sbin:/usr/bin:/sbin:/bin

expected_sha512_hex=${1:-}
deb_path=${2:-}

if [ "${#expected_sha512_hex}" -ne 128 ] || ! printf '%s\n' "$expected_sha512_hex" | grep -Eq '^[0-9a-f]{128}$'; then
  echo 'Invalid SHA-512 argument.' >&2
  exit 2
fi
case "$deb_path" in
  /*) ;;
  *) echo 'Package path must be absolute.' >&2; exit 2 ;;
esac
if [ ! -f "$deb_path" ] || [ -L "$deb_path" ]; then
  echo 'Package is not a regular file.' >&2
  exit 2
fi

# Copy into a root-owned private directory before verification. The original
# staging file belongs to the desktop user and may be replaced at any time;
# hashing and installing that pathname separately would be a TOCTOU boundary.
root_dir="$(mktemp -d /var/tmp/aria-update.XXXXXX)"
trap 'rm -rf -- "$root_dir"' EXIT HUP INT TERM
root_deb="$root_dir/update.deb"
cp -- "$deb_path" "$root_deb"
chmod 0600 "$root_deb"

actual="$(sha512sum -- "$root_deb")" || exit 1
actual=${actual%% *}
if [ "$actual" != "$expected_sha512_hex" ]; then
  echo 'Downloaded package failed SHA-512 verification.' >&2
  exit 1
fi

# apt installs a local package while resolving any newly-added dependencies;
# bare dpkg can leave the application unpacked but unconfigured on such updates.
DEBIAN_FRONTEND=noninteractive apt-get -y install "$root_deb"
