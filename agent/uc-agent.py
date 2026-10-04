#!/usr/bin/env python3
"""Update Center agent.

Connects outbound to the hub over WebSocket, reports system info/metrics/updates,
runs upgrade/reboot/command jobs and provides a web terminal (pty).
Python 3.7+, standard library only. Runs as root (systemd service).

Usage:
  uc-agent.py enroll --hub https://hub.example.com --token TOKEN
  uc-agent.py run
"""
import base64, codecs, fcntl, hashlib, json, os, platform, pty, pwd, queue, re, shutil
import signal, socket, ssl, struct, subprocess, sys, termios, threading, time
import urllib.error, urllib.parse, urllib.request

VERSION = "0.1.0"
CONFIG = os.environ.get("UC_CONFIG", "/etc/update-center/agent.json")
METRICS_EVERY = 10
EXEC_TIMEOUT = 3600
# Set by the Docker launcher: run upgrades as transient systemd units on the host so an
# upgrade that restarts Docker itself cannot kill apt/dpkg halfway through.
DETACH_JOBS = os.environ.get("UC_DETACH_JOBS") == "1"


def log(*a):
    print(time.strftime("%Y-%m-%d %H:%M:%S"), *a, flush=True)


# --------------------------------------------------------------------------- WebSocket client
class WebSocket:
    """Minimal RFC 6455 client: text frames, ping/pong, fragmentation."""
    GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    def __init__(self, url, headers):
        u = urllib.parse.urlsplit(url)
        port = u.port or (443 if u.scheme == "wss" else 80)
        sock = socket.create_connection((u.hostname, port), timeout=30)
        if u.scheme == "wss":
            sock = ssl.create_default_context().wrap_socket(sock, server_hostname=u.hostname)
        key = base64.b64encode(os.urandom(16)).decode()
        host = u.hostname + ("" if u.port is None else ":%d" % u.port)
        lines = ["GET %s HTTP/1.1" % (u.path or "/"), "Host: " + host, "Upgrade: websocket",
                 "Connection: Upgrade", "Sec-WebSocket-Key: " + key, "Sec-WebSocket-Version: 13"]
        lines += ["%s: %s" % kv for kv in headers.items()]
        sock.sendall(("\r\n".join(lines) + "\r\n\r\n").encode())
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(4096)
            if not chunk or len(buf) > 65536:
                raise ConnectionError("handshake failed")
            buf += chunk
        head, self.buf = buf.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n")[0].decode(errors="replace")
        if " 101 " not in status + " ":
            raise PermissionError(status) if " 401 " in status else ConnectionError(status)
        expected = base64.b64encode(hashlib.sha1((key + self.GUID).encode()).digest()).decode()
        if ("sec-websocket-accept: " + expected.lower()).encode() not in head.lower():
            raise ConnectionError("bad Sec-WebSocket-Accept")
        sock.settimeout(120)  # hub pings every 30s; silence means a dead link
        self.sock = sock
        self.lock = threading.Lock()

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("connection closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send_frame(self, opcode, payload):
        n = len(payload)
        if n < 126:
            head = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        mask = os.urandom(4)
        if n:
            m = (mask * (n // 4 + 1))[:n]
            payload = (int.from_bytes(payload, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")
        with self.lock:
            self.sock.sendall(head + mask + payload)

    def send(self, obj):
        self._send_frame(1, json.dumps(obj).encode())

    def recv(self):
        """Returns the next text message as str. Raises ConnectionError on close."""
        parts = []
        while True:
            b1, b2 = self._read(2)
            n = b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            mask = self._read(4) if b2 & 0x80 else None
            payload = self._read(n)
            if mask:
                payload = bytes(c ^ mask[i % 4] for i, c in enumerate(payload))
            op = b1 & 0x0F
            if op == 9:
                self._send_frame(10, payload)
            elif op == 8:
                code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                raise ConnectionError("closed by hub (%d %s)" % (code, payload[2:].decode(errors="replace")))
            elif op in (0, 1, 2):
                parts.append(payload)
                if b1 & 0x80:
                    return b"".join(parts).decode("utf-8", errors="replace")

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class Link:
    """The current hub connection (None while disconnected). Sends are dropped when offline."""
    ws = None

    def send(self, obj):
        ws = self.ws
        if ws is None:
            return False
        try:
            ws.send(obj)
            return True
        except (OSError, ConnectionError):
            return False


LINK = Link()


# --------------------------------------------------------------------------- helpers
def sh(cmd, timeout=120):
    """Run a command, return (exit_code, stdout). Never raises for missing binaries."""
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                           timeout=timeout, env=dict(os.environ, LC_ALL="C", DEBIAN_FRONTEND="noninteractive"))
        return p.returncode, p.stdout.decode(errors="replace")
    except (OSError, subprocess.TimeoutExpired):
        return 127, ""


def read(path, default=""):
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return default


def stream(cmd, job_id, timeout=None, detach=False):
    """Run cmd, streaming merged stdout/stderr to the hub as job_output. Returns exit code.
    detach: in Docker mode, run it outside the agent's cgroup via systemd-run."""
    LINK.send({"type": "job_output", "job_id": job_id, "data": "$ %s\n" % " ".join(cmd)})
    env = dict(os.environ, DEBIAN_FRONTEND="noninteractive")
    if detach and DETACH_JOBS and shutil.which("systemd-run"):
        cmd = ["systemd-run", "--quiet", "--pipe", "--wait", "--collect",
               "--setenv=DEBIAN_FRONTEND=noninteractive", "--"] + cmd
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             env=env, start_new_session=True)
    except OSError as e:
        LINK.send({"type": "job_output", "job_id": job_id, "data": "error: %s\n" % e})
        return 127
    timer = None
    if timeout:
        timer = threading.Timer(timeout, kill_group, (p.pid,))
        timer.start()
    dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
    while True:
        chunk = p.stdout.read1(16384) if hasattr(p.stdout, "read1") else os.read(p.stdout.fileno(), 16384)
        if not chunk:
            break
        LINK.send({"type": "job_output", "job_id": job_id, "data": dec.decode(chunk)})
    code = p.wait()
    if timer:
        timer.cancel()
    return code


def kill_group(pid):
    try:
        os.killpg(pid, signal.SIGKILL)
    except OSError:
        pass


def kernel_reboot_needed():
    """Generic check: running kernel's modules are gone => a newer kernel was installed."""
    rel = platform.release()
    return not (os.path.isdir("/lib/modules/" + rel) or os.path.isdir("/usr/lib/modules/" + rel))


# --------------------------------------------------------------------------- package managers
class Apt:
    name = "apt"
    UPGRADE_OPTS = ["-y", "-o", "Dpkg::Options::=--force-confdef", "-o", "Dpkg::Options::=--force-confold"]

    def refresh_cmd(self):
        return ["apt-get", "-q", "update"]

    def list_updates(self):
        _, out = sh(["apt-get", "-s", "-o", "Debug::NoLocking=1", "--with-new-pkgs", "upgrade"])
        ups = []
        for m in re.finditer(r"^Inst (\S+) (?:\[(\S+)\] )?\((\S+) (.*?)\)", out, re.M):
            ups.append({"name": m.group(1), "current": m.group(2), "version": m.group(3),
                        "security": "security" in m.group(4).lower()})
        return ups

    def upgrade_cmds(self, security_only):
        if security_only:
            if not shutil.which("unattended-upgrade"):
                raise RuntimeError("security-only upgrades need the 'unattended-upgrades' package")
            return [["unattended-upgrade", "-v"]]
        return [["apt-get"] + self.UPGRADE_OPTS + ["--with-new-pkgs", "upgrade"],
                ["apt-get", "-y", "autoremove"]]

    def reboot_required(self):
        return os.path.exists("/var/run/reboot-required") or os.path.exists("/run/reboot-required")


class Dnf:
    def __init__(self, binary):
        self.name = binary

    def refresh_cmd(self):
        return [self.name, "-q", "makecache"]

    def list_updates(self):
        _, out = sh([self.name, "-q", "check-update"], timeout=600)
        _, sec = sh([self.name, "-q", "updateinfo", "list", "--security"], timeout=600)
        sec_names = {l.split()[-1].rsplit("-", 2)[0] for l in sec.splitlines() if l.strip()}
        ups = []
        for line in out.splitlines():
            if line.startswith("Obsoleting"):
                break
            f = line.split()
            if len(f) == 3 and "." in f[0]:
                name = f[0].rsplit(".", 1)[0]
                ups.append({"name": name, "version": f[1], "security": name in sec_names})
        return ups

    def upgrade_cmds(self, security_only):
        return [[self.name, "-y", "upgrade"] + (["--security"] if security_only else [])]

    def reboot_required(self):
        if shutil.which("needs-restarting"):
            return sh(["needs-restarting", "-r"])[0] == 1
        return kernel_reboot_needed()


class Pacman:
    name = "pacman"

    def refresh_cmd(self):
        return None  # checkupdates uses its own temporary database

    def list_updates(self):
        if shutil.which("checkupdates"):
            _, out = sh(["checkupdates"], timeout=600)
        else:
            sh(["pacman", "-Sy"], timeout=600)
            _, out = sh(["pacman", "-Qu"])
        ups = []
        for line in out.splitlines():
            f = line.split()
            if len(f) >= 4 and f[2] == "->":
                ups.append({"name": f[0], "current": f[1], "version": f[3], "security": False})
        return ups

    def upgrade_cmds(self, security_only):
        return [["pacman", "-Syu", "--noconfirm"]]

    def reboot_required(self):
        return kernel_reboot_needed()


class Zypper:
    name = "zypper"

    def refresh_cmd(self):
        return ["zypper", "-n", "refresh"]

    def list_updates(self):
        _, out = sh(["zypper", "-n", "-q", "list-updates"], timeout=600)
        ups = []
        for line in out.splitlines():
            f = [c.strip() for c in line.split("|")]
            if len(f) >= 5 and f[0] == "v":
                ups.append({"name": f[2], "current": f[3], "version": f[4], "security": False})
        return ups

    def upgrade_cmds(self, security_only):
        if security_only:
            return [["zypper", "-n", "patch", "--category", "security"]]
        return [["zypper", "-n", "update"]]

    def reboot_required(self):
        return sh(["zypper", "needs-rebooting"])[0] == 102


class Apk:
    name = "apk"

    def refresh_cmd(self):
        return ["apk", "update"]

    def list_updates(self):
        _, out = sh(["apk", "version", "-l", "<"])
        ups = []
        for line in out.splitlines()[1:]:
            f = line.split()
            if len(f) == 3 and f[1] == "<":
                ups.append({"name": f[0].rsplit("-", 2)[0], "current": f[0], "version": f[2], "security": False})
        return ups

    def upgrade_cmds(self, security_only):
        return [["apk", "upgrade"]]

    def reboot_required(self):
        return kernel_reboot_needed()


def detect_pm():
    for binary, factory in (("apt-get", Apt), ("dnf", lambda: Dnf("dnf")), ("yum", lambda: Dnf("yum")),
                            ("pacman", Pacman), ("zypper", Zypper), ("apk", Apk)):
        if shutil.which(binary):
            return factory()
    return None


PM = detect_pm()


# --------------------------------------------------------------------------- system info & metrics
def os_release():
    d = {}
    for line in read("/etc/os-release").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            d[k] = v.strip('"')
    return d


def system_info():
    cpuinfo = read("/proc/cpuinfo")
    m = re.search(r"^(?:model name|Model|Hardware)\s*:\s*(.+)$", cpuinfo, re.M)
    mem = re.search(r"MemTotal:\s+(\d+)", read("/proc/meminfo"))
    return {
        "hostname": socket.gethostname(),
        "os": os_release().get("PRETTY_NAME", platform.system()),
        "kernel": platform.release(),
        "arch": platform.machine(),
        "cpu": m.group(1).strip() if m else "",
        "cpus": os.cpu_count(),
        "mem_total": int(mem.group(1)) * 1024 if mem else 0,
        "pkg_manager": PM.name if PM else None,
        "virt": sh(["systemd-detect-virt"])[1].strip() or None,
        "ips": sh(["hostname", "-I"])[1].split()[:6],
        "python": platform.python_version(),
    }


class Metrics:
    REAL_FS = {"ext2", "ext3", "ext4", "xfs", "btrfs", "zfs", "vfat", "f2fs", "reiserfs", "jfs", "ntfs", "exfat"}

    def __init__(self):
        self.prev_cpu = None
        self.prev_net = None

    def cpu(self):
        f = [int(x) for x in read("/proc/stat").split("\n", 1)[0].split()[1:]]
        idle, total = f[3] + (f[4] if len(f) > 4 else 0), sum(f)
        pct = None
        if self.prev_cpu and total > self.prev_cpu[1]:
            pct = round(100 * (1 - (idle - self.prev_cpu[0]) / (total - self.prev_cpu[1])), 1)
        self.prev_cpu = (idle, total)
        return pct

    def net(self):
        rx = tx = 0
        for line in read("/proc/net/dev").splitlines()[2:]:
            name, data = line.split(":", 1)
            if name.strip() == "lo":
                continue
            f = data.split()
            rx, tx = rx + int(f[0]), tx + int(f[8])
        t = time.time()
        rate = None
        if self.prev_net:
            dt = t - self.prev_net[0]
            rate = {"rx": int((rx - self.prev_net[1]) / dt), "tx": int((tx - self.prev_net[2]) / dt)}
        self.prev_net = (t, rx, tx)
        return rate

    @classmethod
    def disks(cls):
        out, seen = [], set()
        for line in read("/proc/mounts").splitlines():
            f = line.split()
            if len(f) < 3 or f[2] not in cls.REAL_FS or f[0] in seen:
                continue
            seen.add(f[0])
            try:
                s = os.statvfs(f[1])
            except OSError:
                continue
            total = s.f_blocks * s.f_frsize
            if not total:
                continue
            used = total - s.f_bfree * s.f_frsize
            avail = s.f_bavail * s.f_frsize
            out.append({"mount": f[1], "fs": f[2], "total": total, "used": used,
                        "pct": round(100 * used / (used + avail)) if used + avail else 0})
        return out

    @staticmethod
    def top():
        code, out = sh(["ps", "-eo", "pid,pcpu,pmem,comm", "--sort=-pcpu", "--no-headers"])
        procs = []
        for line in out.splitlines()[:6]:
            f = line.split(None, 3)
            if len(f) == 4:
                procs.append({"pid": int(f[0]), "cpu": float(f[1]), "mem": float(f[2]), "cmd": f[3]})
        return procs

    def collect(self):
        mi = {k: int(v.split()[0]) * 1024 for k, v in
              (l.split(":", 1) for l in read("/proc/meminfo").splitlines() if ":" in l)}
        total = mi.get("MemTotal", 0)
        avail = mi.get("MemAvailable", mi.get("MemFree", 0))
        swap_t = mi.get("SwapTotal", 0)
        temp = read("/sys/class/thermal/thermal_zone0/temp").strip()
        return {
            "cpu_pct": self.cpu(),
            "mem_total": total, "mem_used": total - avail,
            "mem_pct": round(100 * (total - avail) / total, 1) if total else None,
            "swap_pct": round(100 * (swap_t - mi.get("SwapFree", 0)) / swap_t, 1) if swap_t else 0,
            "load": list(os.getloadavg()),
            "uptime": int(float(read("/proc/uptime", "0 0").split()[0])),
            "temp": round(int(temp) / 1000, 1) if temp.lstrip("-").isdigit() else None,
            "net": self.net(),
            "disks": self.disks(),
            "top": self.top(),
            "procs": len([p for p in os.listdir("/proc") if p.isdigit()]),
        }


def metrics_loop():
    m = Metrics()
    while True:
        try:
            data = m.collect()
            LINK.send({"type": "metrics", "metrics": data})
        except Exception as e:  # never let metrics kill the agent
            log("metrics error:", e)
        time.sleep(METRICS_EVERY)


def inventory():
    inv = {"pkg_manager": PM.name if PM else None, "updates": [], "reboot_required": False}
    if PM:
        inv["updates"] = PM.list_updates()
        inv["reboot_required"] = PM.reboot_required()
        if inv["reboot_required"]:
            inv["reboot_pkgs"] = read("/var/run/reboot-required.pkgs").split()
    if shutil.which("systemctl"):
        inv["failed_units"] = [l.split()[0] for l in sh(["systemctl", "--failed", "--no-legend", "--plain"])[1].splitlines() if l.strip()]
    if shutil.which("docker"):
        code, out = sh(["docker", "ps", "-a", "--format", "{{json .}}"], timeout=20)
        if code == 0:
            cs = [json.loads(l) for l in out.splitlines() if l.strip()]
            inv["containers"] = [{"name": c.get("Names"), "image": c.get("Image"), "state": c.get("State"),
                                  "status": c.get("Status")} for c in cs]
    return inv


# --------------------------------------------------------------------------- jobs
PKG_QUEUE = queue.Queue()  # package-manager work is serialized (apt/dnf locks)


def pkg_worker():
    while True:
        task = PKG_QUEUE.get()
        try:
            if task["type"] == "refresh":
                if PM and PM.refresh_cmd():
                    sh(PM.refresh_cmd(), timeout=900)
                LINK.send({"type": "inventory", "inventory": inventory()})
            elif task["type"] == "upgrade":
                job_upgrade(task["job_id"], task["params"])
        except Exception as e:
            log("pkg task failed:", e)
            if task.get("job_id"):
                LINK.send({"type": "job_output", "job_id": task["job_id"], "data": "\nagent error: %s\n" % e})
                LINK.send({"type": "job_done", "job_id": task["job_id"], "exit_code": 1})


def job_upgrade(job_id, params):
    if not PM:
        raise RuntimeError("no supported package manager found")
    cmds = PM.upgrade_cmds(bool(params.get("security_only")))
    code = 0
    if PM.refresh_cmd():
        code = stream(PM.refresh_cmd(), job_id, detach=True)
    count = len(PM.list_updates()) if code == 0 else 0
    for cmd in cmds:
        if code != 0:
            break
        code = stream(cmd, job_id, detach=True)
    reboot = PM.reboot_required()
    LINK.send({"type": "job_output", "job_id": job_id,
               "data": "\n== finished with exit code %d, reboot required: %s ==\n" % (code, "yes" if reboot else "no")})
    LINK.send({"type": "job_done", "job_id": job_id, "exit_code": code,
               "result": {"upgraded": count, "reboot_required": reboot}})
    LINK.send({"type": "inventory", "inventory": inventory()})


def job_exec(job_id, command):
    code = stream(["/bin/sh", "-c", command], job_id, timeout=EXEC_TIMEOUT)
    LINK.send({"type": "job_done", "job_id": job_id, "exit_code": code})


def job_reboot(job_id):
    cmd = ["systemctl", "reboot"] if shutil.which("systemctl") else ["reboot"]
    LINK.send({"type": "job_output", "job_id": job_id, "data": "Rebooting now (%s)…\n" % " ".join(cmd)})
    time.sleep(1)
    code, _ = sh(cmd, timeout=60)
    LINK.send({"type": "job_done", "job_id": job_id, "exit_code": code})


def bg(fn, *args):
    threading.Thread(target=fn, args=args, daemon=True).start()


# --------------------------------------------------------------------------- terminals
TERMINALS = {}  # sid -> (pid, fd)


def term_open(sid, cols, rows):
    try:
        shell = pwd.getpwuid(os.getuid()).pw_shell or "/bin/sh"
        home = pwd.getpwuid(os.getuid()).pw_dir or "/"
    except KeyError:
        shell, home = "/bin/sh", "/"
    if not os.path.exists(shell):
        shell = "/bin/sh"
    pid, fd = pty.fork()
    if pid == 0:  # child
        try:
            os.chdir(home)
        except OSError:
            pass
        os.environ.update(TERM="xterm-256color", HOME=home, LANG=os.environ.get("LANG", "C.UTF-8"))
        os.execvp(shell, [shell, "-l"])
    TERMINALS[sid] = (pid, fd)
    term_resize(sid, cols, rows)
    bg(term_reader, sid, pid, fd)


def term_reader(sid, pid, fd):
    while True:
        try:
            data = os.read(fd, 65536)
        except OSError:
            data = b""
        if not data:
            break
        LINK.send({"type": "term_output", "sid": sid, "data": base64.b64encode(data).decode()})
    term_close(sid)
    try:
        os.waitpid(pid, 0)
    except OSError:
        pass
    LINK.send({"type": "term_exit", "sid": sid})


def term_resize(sid, cols, rows):
    t = TERMINALS.get(sid)
    if t and cols > 0 and rows > 0:
        fcntl.ioctl(t[1], termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def term_close(sid):
    t = TERMINALS.pop(sid, None)
    if t:
        for action in (lambda: os.kill(t[0], signal.SIGHUP), lambda: os.close(t[1])):
            try:
                action()
            except OSError:
                pass


# --------------------------------------------------------------------------- main loop
def handle(m):
    t = m.get("type")
    if t == "refresh":
        PKG_QUEUE.put({"type": "refresh"})
    elif t == "job":
        kind, job_id, params = m.get("kind"), m.get("job_id"), m.get("params") or {}
        if kind == "upgrade":
            PKG_QUEUE.put({"type": "upgrade", "job_id": job_id, "params": params})
        elif kind == "reboot":
            bg(job_reboot, job_id)
        elif kind == "exec":
            bg(job_exec, job_id, str(params.get("command", "")))
        else:
            LINK.send({"type": "job_done", "job_id": job_id, "exit_code": 2})
    elif t == "term_open":
        term_open(m["sid"], int(m.get("cols", 80)), int(m.get("rows", 24)))
    elif t == "term_input":
        tt = TERMINALS.get(m.get("sid"))
        if tt:
            os.write(tt[1], m.get("data", "").encode())
    elif t == "term_resize":
        term_resize(m.get("sid"), int(m.get("cols", 0)), int(m.get("rows", 0)))
    elif t == "term_close":
        term_close(m.get("sid"))


def load_config():
    with open(CONFIG) as f:
        return json.load(f)


def run():
    cfg = load_config()
    url = re.sub(r"^http", "ws", cfg["hub"].rstrip("/")) + "/ws/agent"
    if url.startswith("ws://"):
        log("WARNING: hub URL is not HTTPS — traffic (incl. terminal) is unencrypted")
    headers = {"Authorization": "Bearer %s:%s" % (cfg["host_id"], cfg["secret"]),
               "User-Agent": "uc-agent/" + VERSION}
    for target in (pkg_worker, metrics_loop):
        bg(target)
    delay = 5
    while True:
        try:
            ws = WebSocket(url, headers)
            log("connected to", cfg["hub"])
            delay = 5
            LINK.ws = ws
            ws.send({"type": "hello", "agent_version": VERSION, "info": system_info()})
            PKG_QUEUE.put({"type": "refresh"})
            while True:
                msg = json.loads(ws.recv())
                try:
                    handle(msg)
                except Exception as e:  # a bad message must not drop the connection
                    log("error handling %s: %s" % (msg.get("type"), e))
        except PermissionError as e:
            log("hub rejected credentials (%s) — host removed? retrying in 5 min" % e)
            delay = 300
        except Exception as e:
            log("connection lost:", e)
        LINK.ws = None
        for sid in list(TERMINALS):
            term_close(sid)
        time.sleep(delay)
        delay = min(delay * 2, 60) if delay < 300 else 300


def enroll(hub, token):
    hub = hub.rstrip("/")
    body = json.dumps({"token": token, "hostname": socket.gethostname()}).encode()
    req = urllib.request.Request(hub + "/api/agent/enroll", data=body, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            res = json.load(r)
    except urllib.error.HTTPError as e:
        sys.exit("enrollment failed: %s %s" % (e.code, e.read().decode(errors="replace")))
    os.makedirs(os.path.dirname(CONFIG), mode=0o700, exist_ok=True)
    fd = os.open(CONFIG, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump({"hub": hub, "host_id": res["host_id"], "secret": res["secret"]}, f)
    print("enrolled as '%s' (%s)" % (res["name"], res["host_id"]))


def main():
    args = sys.argv[1:]
    if args[:1] == ["enroll"]:
        opts = dict(zip(args[1::2], args[2::2]))
        if "--hub" not in opts or "--token" not in opts:
            sys.exit(__doc__)
        enroll(opts["--hub"], opts["--token"])
    elif args[:1] == ["run"]:
        if os.geteuid() != 0:
            log("WARNING: not running as root — updates, reboots and terminal will be limited")
        run()
    else:
        sys.exit(__doc__)


if __name__ == "__main__":
    main()
