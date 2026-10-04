#!/bin/sh
# Installs the agent onto the host and runs it inside the host's namespaces.
# Env: UC_HUB (hub URL, needed for first enrollment), UC_TOKEN (one-time enrollment token).
set -eu
die() { echo "error: $*" >&2; exit 1; }

# With --pid=host, PID 1 is the host's init and lives in a different mount namespace.
[ "$(readlink /proc/1/ns/mnt)" != "$(readlink /proc/self/ns/mnt)" ] \
  || die "run with --pid=host and --privileged (see docs/agent.md)"
H="nsenter --target 1 --mount --uts --ipc --net --pid --"
$H true 2>/dev/null || die "cannot enter host namespaces — is the container --privileged?"
$H sh -c 'command -v python3 >/dev/null' || die "the host needs python3 (apt install python3)"
if $H sh -c 'systemctl is-active --quiet uc-agent 2>/dev/null'; then
  die "the native uc-agent service is already running on this host — use either it or this container, not both"
fi

$H mkdir -p /opt/update-center
$H sh -c 'cat > /opt/update-center/uc-agent.py && chmod 700 /opt/update-center/uc-agent.py' < /uc-agent.py

if ! $H test -f /etc/update-center/agent.json; then
  [ -n "${UC_HUB:-}" ] && [ -n "${UC_TOKEN:-}" ] || die "first start needs UC_HUB and UC_TOKEN"
  $H python3 /opt/update-center/uc-agent.py enroll --hub "$UC_HUB" --token "$UC_TOKEN"
fi

export UC_DETACH_JOBS=1
exec $H python3 -u /opt/update-center/uc-agent.py run
