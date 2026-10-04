#!/bin/sh
# Update Center agent installer.
#   curl -fsSL https://HUB/install.sh | sudo sh -s -- --hub https://HUB --token TOKEN
# Re-running without --token just updates the agent file and restarts it.
# Uninstall: sh install.sh --uninstall
set -eu

HUB="" TOKEN="" UNINSTALL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --hub) HUB="$2"; shift 2 ;;
    --token) TOKEN="$2"; shift 2 ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 1 ;;
  esac
done

DIR=/opt/update-center
CONF=/etc/update-center/agent.json
UNIT=/etc/systemd/system/uc-agent.service

die() { echo "error: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root (sudo)"

if [ -n "$UNINSTALL" ]; then
  systemctl disable --now uc-agent 2>/dev/null || true
  rm -rf "$UNIT" "$DIR" /etc/update-center
  systemctl daemon-reload 2>/dev/null || true
  echo "Update Center agent removed."; exit 0
fi

[ -n "$HUB" ] || die "--hub is required"
HUB="${HUB%/}"

if ! command -v python3 >/dev/null 2>&1; then
  echo "Installing python3…"
  if command -v apt-get >/dev/null; then apt-get update -q && apt-get install -y -q python3
  elif command -v dnf >/dev/null; then dnf install -y python3
  elif command -v yum >/dev/null; then yum install -y python3
  elif command -v pacman >/dev/null; then pacman -Sy --noconfirm python
  elif command -v zypper >/dev/null; then zypper -n install python3
  elif command -v apk >/dev/null; then apk add python3
  else die "python3 missing and no known package manager"; fi
fi

mkdir -p "$DIR"
fetch() { if command -v curl >/dev/null; then curl -fsSL "$1" -o "$2"; else wget -qO "$2" "$1"; fi; }
fetch "$HUB/agent/uc-agent.py" "$DIR/uc-agent.py.new"
python3 -m py_compile "$DIR/uc-agent.py.new" || die "downloaded agent is invalid"
mv "$DIR/uc-agent.py.new" "$DIR/uc-agent.py"
chmod 700 "$DIR/uc-agent.py"
rm -rf "$DIR/__pycache__"

if [ ! -f "$CONF" ]; then
  [ -n "$TOKEN" ] || die "--token is required for the first install"
  python3 "$DIR/uc-agent.py" enroll --hub "$HUB" --token "$TOKEN"
fi

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  cat > "$UNIT" <<EOF
[Unit]
Description=Update Center agent
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$(command -v python3) $DIR/uc-agent.py run
Restart=always
RestartSec=5
# Do not kill a running upgrade when the agent restarts.
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable uc-agent >/dev/null 2>&1
  systemctl restart uc-agent
  echo "Agent installed and running: systemctl status uc-agent"
else
  echo "No systemd found. Start the agent yourself, e.g.:"
  echo "  nohup python3 $DIR/uc-agent.py run >/var/log/uc-agent.log 2>&1 &"
fi
