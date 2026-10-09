#!/usr/bin/env python3
"""Prepare the pinned server in /data, then replace this process with Java.

Only launcher/mod files listed in the private manifest are managed. Configuration,
worlds, player lists and Fabric's downloaded runtime cache remain in /data.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import uuid
from urllib.parse import urlsplit

MANIFEST = ".mvs/managed.json"
JOURNAL = ".mvs/transaction.json"
LOCK = ".mvs/runtime.lock"
DEFAULT_FILES = ("server.properties", "server-icon.png", "eula.txt",
                 "config/plasmovoice/server/config.toml")
VOICE_CONFIG = "config/plasmovoice/server/config.toml"


def features(lock):
    value = lock.get("features")
    if not isinstance(value, dict) or any(type(value.get(key)) is not bool for key in ("voice", "fastback")):
        raise ValueError("Image lock must declare boolean voice and fastback features")
    return value


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n").encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def checked(path):
    """Reject symlinks, including parent components, without following them."""
    path = Path(path).absolute()
    for candidate in (path, *path.parents):
        if candidate.is_symlink():
            raise ValueError(f"Symlink is not allowed: {candidate}")
    return path


def relative(name):
    if not isinstance(name, str):
        raise ValueError("Invalid relative path")
    path = PurePosixPath(name)
    if (not name or str(path) != name or path.is_absolute() or ".." in path.parts
            or "\\" in name or ":" in name or name == "."):
        raise ValueError(f"Unsafe relative path: {name!r}")
    return path


def managed_name(name):
    path = relative(name)
    if name != "fabric-server-launch.jar" and not (
            len(path.parts) == 2 and path.parts[0] == "mods" and path.suffix.lower() == ".jar"):
        raise ValueError(f"Invalid managed file: {name}")
    return name


def read_optional(path):
    path = checked(path)
    if not path.exists():
        return None
    if not path.is_file():
        raise ValueError(f"Expected a regular file: {path}")
    return path.read_bytes()


def atomic_write(path, data, mode=0o644, exclusive=False):
    path = checked(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    checked(path.parent)
    descriptor, temporary = tempfile.mkstemp(prefix=".mvs-write-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        if exclusive:
            # Install a complete new file without overwriting a concurrent creator.
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def runtime_lock(data_dir):
    data_dir = checked(data_dir)
    data_dir.mkdir(parents=True, exist_ok=True)
    directory = checked(data_dir / ".mvs")
    directory.mkdir(mode=0o700, exist_ok=True)
    path = checked(data_dir / LOCK)
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("Runtime lock is not a regular file")
        try:
            fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as error:
            raise RuntimeError("Another server or preparation process already owns /data") from error
        # exec does not release flock when its owning descriptor is inherited.
        os.set_inheritable(descriptor, True)
        yield descriptor
    finally:
        os.close(descriptor)


def verify_image_file(data, info):
    if data is None or len(data) != info["size"] or not info.get("hashes", {}).get("sha512"):
        raise ValueError("Image file is missing or has an invalid size/hash declaration")
    for algorithm, expected in info["hashes"].items():
        if algorithm not in {"sha1", "sha256", "sha512"} or hashlib.new(algorithm, data).hexdigest() != expected:
            raise ValueError(f"Image file {algorithm} verification failed")


def image_payload(source):
    source = checked(source)
    lock = json.loads(read_optional(source / "pack.lock.json") or b"null")
    if not isinstance(lock, dict) or not isinstance(lock.get("minecraft"), str):
        raise ValueError("Missing or invalid image pack.lock.json")
    if not isinstance(lock.get("java"), int) or lock["java"] < 8:
        raise ValueError("Invalid Java requirement in image lock")
    features(lock)
    payload = {}
    launcher = read_optional(source / "fabric-server-launch.jar")
    verify_image_file(launcher, lock["server_launcher"])
    payload["fabric-server-launch.jar"] = launcher
    for mod in lock["mods"]:
        if "server" not in mod["sides"]:
            continue
        name = "mods/" + mod["file"]["filename"]
        managed_name(name)
        if name in payload:
            raise ValueError(f"Duplicate image mod: {name}")
        data = read_optional(source / name)
        verify_image_file(data, mod["file"])
        payload[name] = data
    scan_mods(source, set(payload))
    return lock, payload


def scan_mods(root, allowed):
    folder = checked(root / "mods")
    if not folder.exists():
        return
    if not folder.is_dir():
        raise ValueError("mods must be a directory")
    for path in folder.rglob("*"):
        checked(path)
        if path.suffix.lower() == ".jar":
            if not path.is_file() or path.relative_to(root).as_posix() not in allowed:
                raise ValueError(f"Unknown JAR in mods: {path.relative_to(root)}")


def properties(data):
    result = {}
    for line in data.decode("utf-8-sig").splitlines():
        line = line.strip()
        if line and not line.startswith(("#", "!")):
            pair = re.split(r"\s*[:=]\s*|\s+", line, maxsplit=1)
            result[pair[0]] = pair[1] if len(pair) > 1 else ""
    return result


def transaction_name(name):
    if name != MANIFEST and name not in DEFAULT_FILES:
        managed_name(name)
    return name


def rollback(data_dir, journal):
    """Restore only files still matching this transaction's before/after hashes."""
    if journal.get("format") != 1 or not isinstance(journal.get("changes"), list):
        raise ValueError("Invalid recovery journal; preserve .mvs/backups for manual recovery")
    backup_name = journal["backup"]
    backup_path = relative(backup_name)
    if len(backup_path.parts) != 3 or backup_path.parts[:2] != (".mvs", "backups"):
        raise ValueError("Invalid transaction backup path")
    # Validate everything before restoring anything.
    restore = []
    for entry in journal["changes"]:
        name = transaction_name(entry["path"])
        destination = checked(data_dir / name)
        current = read_optional(destination)
        before = None
        if entry["before"] is not None:
            before = read_optional(data_dir / backup_name / name)
            if before is None or digest(before) != entry["before"]:
                raise RuntimeError("Recovery backup is missing or modified; manual recovery required")
        current_hash = None if current is None else digest(current)
        if current_hash not in {entry["before"], entry["after"]}:
            raise RuntimeError(f"File changed outside the transaction; preserve it for manual recovery: {name}")
        restore.append((destination, before, entry.get("mode", 0o644)))
    for destination, before, mode in reversed(restore):
        if before is None:
            if destination.exists():
                destination.unlink()
        else:
            atomic_write(destination, before, mode)
    checked(data_dir / JOURNAL).unlink()


def apply_transaction(data_dir, changes):
    """changes contain fixed (name, old bytes or None, new bytes or None) baselines."""
    if not changes:
        return
    backup_name = ".mvs/backups/" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex
    backup = checked(data_dir / backup_name)
    backup.mkdir(parents=True, mode=0o700)
    entries = []
    for name, before, after in changes:
        transaction_name(name)
        destination = checked(data_dir / name)
        if read_optional(destination) != before:
            raise RuntimeError(f"File changed while preparing: {name}")
        mode = stat.S_IMODE(destination.stat().st_mode) if before is not None else 0o644
        if before is not None:
            atomic_write(backup / name, before, 0o600)
        entries.append({"path": name, "before": None if before is None else digest(before),
                        "after": None if after is None else digest(after), "mode": mode})
    journal = {"format": 1, "backup": backup_name, "changes": entries}
    atomic_write(data_dir / JOURNAL, encoded(journal), 0o600)
    try:
        for name, before, after in changes:
            destination = checked(data_dir / name)
            if read_optional(destination) != before:
                raise RuntimeError(f"File changed while installing: {name}")
            if after is None:
                destination.unlink()
            else:
                atomic_write(destination, after, 0o600 if name == MANIFEST else 0o644,
                             exclusive=before is None)
        checked(data_dir / JOURNAL).unlink()
    except Exception:
        rollback(data_dir, journal)
        raise


def prepare_locked(source, data_dir, allow_version_change=False):
    source, data_dir = checked(source), checked(data_dir)
    pending = read_optional(data_dir / JOURNAL)
    if pending is not None:
        rollback(data_dir, json.loads(pending))
    lock, payload = image_payload(source)
    manifest_raw = read_optional(data_dir / MANIFEST)
    old = json.loads(manifest_raw) if manifest_raw is not None else None
    old_files = {}
    old_bytes = {}
    previous_game = None
    if old is not None:
        if old.get("format") != 1 or not isinstance(old.get("files"), dict):
            raise ValueError("Invalid managed file manifest")
        old_files = old["files"]
        if "fabric-server-launch.jar" not in old_files:
            raise ValueError("Managed manifest does not contain the launcher")
        previous_game = old["minecraft"]
        for name, info in old_files.items():
            managed_name(name)
            content = read_optional(data_dir / name)
            if content is None or len(content) != info["size"] or digest(content) != info["sha256"]:
                raise ValueError(f"Managed file was modified or removed: {name}")
            old_bytes[name] = content
    else:
        legacy = read_optional(data_dir / "pack.lock.json")
        if legacy is not None:
            previous_game = json.loads(legacy)["minecraft"]
    if previous_game and previous_game != lock["minecraft"] and not allow_version_change:
        raise ValueError("Minecraft version change requires ALLOW_MINECRAFT_VERSION_CHANGE=true and a world backup")
    scan_mods(data_dir, set(old_files) if old is not None else set(payload))
    changes = []
    for name in sorted(set(old_files) | set(payload)):
        # Never adopt a fresh baseline after validating the previous manifest.
        before = old_bytes[name] if name in old_bytes else read_optional(data_dir / name)
        after = payload.get(name)
        if old is not None and name not in old_files and before is not None:
            raise ValueError(f"Unmanaged file appeared while preparing: {name}")
        if old is None and before is not None and before != after:
            raise ValueError(f"Existing file differs from the image; refusing adoption: {name}")
        if before != after:
            changes.append((name, before, after))
    # Seed missing defaults on both new and upgraded volumes. They remain
    # operator-owned, outside the managed manifest, so later edits are retained.
    for name in DEFAULT_FILES:
        if name == VOICE_CONFIG and not features(lock)["voice"]:
            continue
        if read_optional(data_dir / name) is None:
            default = read_optional(source / name)
            if name == "server-icon.png" and default is None:
                continue
            if default is None:
                raise ValueError(f"Image is missing default {name}")
            if name == "eula.txt" and properties(default).get("eula") != "false":
                raise ValueError("Image must not pre-accept the EULA")
            changes.append((name, None, default))
    manifest = {"format": 1, "minecraft": lock["minecraft"], "pack_version": lock["pack_version"],
                "fabric_loader": lock["fabric_loader"],
                "pack_id": lock.get("pack_id"), "features": features(lock),
                "files": {name: {"size": len(data), "sha256": digest(data)} for name, data in payload.items()}}
    manifest_data = encoded(manifest)
    if manifest_raw != manifest_data:
        changes.append((MANIFEST, manifest_raw, manifest_data))
    apply_transaction(data_dir, changes)
    scan_mods(data_dir, set(payload))
    for name, expected in payload.items():
        if read_optional(data_dir / name) != expected:
            raise RuntimeError(f"Managed file changed before startup: {name}")
    return lock


def prepare(source, data_dir, allow_version_change=False):
    with runtime_lock(data_dir):
        return prepare_locked(source, data_dir, allow_version_change)


def check_backup_directory(backup_dir, data_dir):
    """Check the Compose/default backup destination without changing mod settings."""
    backup_dir = checked(backup_dir).resolve()
    data_dir = checked(data_dir).resolve()
    if backup_dir == data_dir or data_dir in backup_dir.parents:
        raise ValueError("Automatic backup directory must be outside the server data directory")
    if not backup_dir.is_dir():
        raise ValueError(f"Automatic backup directory is missing or is not a directory: {backup_dir}; "
                         "mount the backup volume before starting the server")
    try:
        # os.access alone is insufficient for read-only mounts or ACL restrictions.
        # Never change ownership or touch existing backups during this check.
        with tempfile.NamedTemporaryFile(prefix=".mvs-backup-write-", dir=backup_dir) as probe:
            probe.write(b"MVS backup directory write check\n")
            probe.flush()
            os.fsync(probe.fileno())
    except OSError as error:
        raise RuntimeError(f"Automatic backup directory is not writable by UID:GID "
                           f"{os.getuid()}:{os.getgid()}: {backup_dir}; "
                           "check host directory ownership, permissions and free disk space") from error


def initialize_fastback(source, data_dir, backup_dir):
    helper = checked(source / "fastback.py")
    if not helper.is_file():
        raise ValueError("Image is missing the FastBack initialization helper")
    subprocess.run([sys.executable, str(helper), "init", "--data-dir", str(data_dir),
                    "--backup-dir", str(backup_dir)], check=True)


def require_eula(data_dir, environment):
    choice = environment.get("EULA")
    if choice is not None:
        choice = choice.strip().lower()
        if choice != "true":
            raise ValueError("EULA is explicitly disabled or invalid; read the EULA and opt in with EULA=true")
        target = data_dir / "eula.txt"
        if properties(read_optional(target) or b"").get("eula") != "true":
            atomic_write(target, b"# Accepted explicitly by the operator via EULA=true\neula=true\n")
    elif properties(read_optional(data_dir / "eula.txt") or b"").get("eula") != "true":
        raise ValueError("EULA not accepted; read https://www.minecraft.net/eula and explicitly opt in")


def rcon_settings(environment):
    """RCON needs an explicit switch; a stray password never enables it."""
    enabled = environment.get("MC_RCON_ENABLED", "false").strip().lower()
    if enabled not in {"true", "false"}:
        raise ValueError("MC_RCON_ENABLED must be true or false")
    if enabled == "false":
        return {"enable-rcon": "false", "rcon.password": ""}
    password = environment.get("MC_RCON_PASSWORD", "")
    if not password or any(ord(char) < 32 or ord(char) > 126 for char in password):
        raise ValueError("Enabled RCON requires a nonempty printable ASCII MC_RCON_PASSWORD")
    port = environment.get("MC_RCON_PORT", "25575")
    if not re.fullmatch(r"[0-9]{1,5}", port) or not 1 <= int(port) <= 65535:
        raise ValueError("MC_RCON_PORT must be an integer from 1 to 65535")
    # Java Properties consumes backslashes and leading whitespace in values.
    escaped = "".join("\\" + char if char in "\\ " else char for char in password)
    return {"enable-rcon": "true", "rcon.password": escaped, "rcon.port": str(int(port)),
            "broadcast-rcon-to-ops": "false"}


def configure_rcon(data_dir, settings):
    """Only RCON keys are runtime-controlled; preserve other operator settings."""
    target = data_dir / "server.properties"
    original = read_optional(target)
    if original is None:
        raise ValueError("server.properties is missing")
    lines = original.decode("utf-8-sig").splitlines(keepends=True)
    existing = properties(original)
    if all(existing.get(key, "") == value for key, value in settings.items()):
        return
    kept = []
    for line in lines:
        entry = properties(line.encode("utf-8"))
        if not any(key in settings for key in entry):
            kept.append(line)
    content = "".join(kept)
    if content and not content.endswith(("\n", "\r")):
        content += "\n"
    content += "".join(f"{key}={value}\n" for key, value in settings.items())
    atomic_write(target, content.encode("utf-8"), 0o600)


def service_proxy_arguments(environment):
    """Configure only Minecraft's HTTP service hosts, leaving game traffic alone."""
    base = environment.get("MC_SERVICE_PROXY_URL", "")
    if not base:
        return []
    error_message = ("Invalid MC_SERVICE_PROXY_URL; use an HTTPS URL without credentials, "
                     "query, fragment or whitespace, such as https://example.com/mc-proxy")
    try:
        if any(character.isspace() or ord(character) < 32 or ord(character) == 127
               for character in base) or any(character in base for character in "\\?#"):
            raise ValueError(error_message)
        url = urlsplit(base)
        if url.scheme != "https" or not url.hostname or url.username is not None or url.password is not None:
            raise ValueError(error_message)
        if not re.fullmatch(r"(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::[0-9]+)?", url.netloc):
            raise ValueError(error_message)
        # urlsplit alone accepts invalid DNS names, empty ports and port zero.
        if url.netloc.endswith(":") or (url.port is not None and not 1 <= url.port <= 65535):
            raise ValueError(error_message)
        hostname = url.hostname
        if ":" in hostname:
            ipaddress.IPv6Address(hostname)
            if "%" in hostname:
                raise ValueError(error_message)
        elif re.fullmatch(r"[0-9.]+", hostname):
            ipaddress.IPv4Address(hostname)
        elif (len(hostname) > 253 or any(not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", label)
                                       for label in hostname.split("."))):
            raise ValueError(error_message)
        if not re.fullmatch(r"(?:[a-zA-Z0-9._~!$&'()*+,;=:@/-]|%[0-9a-fA-F]{2})*", url.path):
            raise ValueError(error_message)
    except ValueError as error:
        raise ValueError(error_message) from error
    base = base.rstrip("/")
    # Authlib 10 discovers its service endpoints from this complete URL. Older
    # Authlib releases use individual host overrides and ignore discovery.host.
    return [f"-Dminecraft.api.discovery.host={base}/discovery/minecraft/client",
            *(f"-Dminecraft.api.{service}.host={base}/{service}"
              for service in ("auth", "account", "session", "services", "profiles"))]


def java_command(lock, environment):
    java = str(Path(environment["JAVA_HOME"]) / "bin/java") if environment.get("JAVA_HOME") else shutil.which("java")
    if not java:
        raise ValueError("Java is not available")
    java = str(Path(java).expanduser().absolute())
    version = subprocess.run([java, "-XshowSettings:properties", "-version"], capture_output=True,
                             text=True, timeout=15, check=False)
    match = re.search(r"java\.specification\.version\s*=\s*(\d+)(?:\.(\d+))?", version.stderr + version.stdout)
    major = int(match[2]) if match and match[1] == "1" else int(match[1]) if match else 0
    if version.returncode or major < lock["java"]:
        raise ValueError(f"Java {lock['java']} or newer is required")
    minimum, maximum = environment.get("MC_MIN_MEMORY", "1G"), environment.get("MC_MAX_MEMORY", "4G")
    def memory(value):
        match = re.fullmatch(r"([1-9][0-9]*)([KMG]?)", value.upper())
        if not match:
            raise ValueError("Invalid memory value; use a value such as 1G or 4096M")
        return int(match[1]) * {"": 1, "K": 1024, "M": 1024 ** 2, "G": 1024 ** 3}[match[2]]
    if memory(minimum) > memory(maximum):
        raise ValueError("MC_MIN_MEMORY exceeds MC_MAX_MEMORY")
    return [java, "-Xms" + minimum, "-Xmx" + maximum, *service_proxy_arguments(environment),
            "-jar", "fabric-server-launch.jar", "nogui"]


def varint(value):
    value &= 0xffffffff
    output = bytearray()
    while True:
        part = value & 0x7f
        value >>= 7
        output.append(part | (0x80 if value else 0))
        if not value:
            return bytes(output)


def receive_exact(connection, length, deadline):
    output = bytearray()
    while len(output) < length:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError("Minecraft status query timed out")
        connection.settimeout(remaining)
        data = connection.recv(length - len(output))
        if not data:
            raise ValueError("Minecraft status connection closed early")
        output.extend(data)
    return bytes(output)


def read_varint(read_byte):
    value = 0
    for index in range(5):
        part = read_byte()[0]
        if index == 4 and part & 0xf0:
            raise ValueError("Oversized VarInt")
        value |= (part & 0x7f) << (index * 7)
        if not part & 0x80:
            return value
    raise ValueError("Unterminated VarInt")


def status_ping(port, timeout=3):
    deadline = time.monotonic() + timeout
    address = b"127.0.0.1"
    handshake = b"\x00" + varint(-1) + varint(len(address)) + address + struct.pack(">H", port) + b"\x01"
    with socket.create_connection(("127.0.0.1", port), timeout=timeout) as connection:
        connection.sendall(varint(len(handshake)) + handshake + b"\x01\x00")
        length = read_varint(lambda: receive_exact(connection, 1, deadline))
        if not 1 <= length <= 1024 * 1024:
            raise ValueError("Invalid status packet size")
        packet = receive_exact(connection, length, deadline)
    offset = 0
    def byte():
        nonlocal offset
        if offset >= len(packet):
            raise ValueError("Truncated status packet")
        offset += 1
        return packet[offset - 1:offset]
    if read_varint(byte) != 0:
        raise ValueError("Unexpected status packet ID")
    string_length = read_varint(byte)
    if string_length != len(packet) - offset:
        raise ValueError("Invalid status JSON length")
    result = json.loads(packet[offset:].decode("utf-8"))
    if not isinstance(result, dict) or not isinstance(result.get("version"), dict) or not isinstance(result.get("players"), dict):
        raise ValueError("Invalid Minecraft status response")
    return result


def healthcheck(data_dir):
    values = properties(read_optional(checked(data_dir) / "server.properties") or b"")
    if values.get("enable-status", "true").lower() != "true":
        raise ValueError("Healthcheck requires enable-status=true; RCON is not required")
    port = int(values.get("server-port", "25565"))
    if not 1 <= port <= 65535:
        raise ValueError("Invalid server-port")
    status_ping(port)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", nargs="?", choices=("run", "prepare", "healthcheck"), default="run")
    args = parser.parse_args(argv)
    source = checked(os.environ.get("MVS_SERVER_DIR", "/opt/mvs/server"))
    data_dir = checked(os.environ.get("MVS_DATA_DIR", "/data"))
    if args.command == "healthcheck":
        healthcheck(data_dir)
        return
    allow = os.environ.get("ALLOW_MINECRAFT_VERSION_CHANGE", "false").lower() == "true"
    with runtime_lock(data_dir):
        lock = prepare_locked(source, data_dir, allow)
        if args.command == "prepare":
            print(f"Prepared Minecraft {lock['minecraft']} / pack {lock['pack_version']}; EULA unchanged", flush=True)
            return
        backup_dir = None
        if features(lock)["fastback"]:
            backup_dir = checked(data_dir / "../backups").resolve()
            check_backup_directory(backup_dir, data_dir)
        command = java_command(lock, os.environ)
        rcon = rcon_settings(os.environ)
        require_eula(data_dir, os.environ)
        configure_rcon(data_dir, rcon)
        if features(lock)["fastback"]:
            initialize_fastback(source, data_dir, backup_dir)
        os.chdir(data_dir)
        print(f"Starting Minecraft {lock['minecraft']} in {data_dir}", flush=True)
        os.execvpe(command[0], command, dict(os.environ))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
        print(f"MVS runtime stopped: {error}", file=sys.stderr)
        sys.exit(1)
