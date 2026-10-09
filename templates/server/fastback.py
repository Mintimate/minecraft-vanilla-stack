#!/usr/bin/env python3
"""Initialize external FastBack repositories and export verified local snapshots.

Python 3.10+, Git and Git LFS. Stop the server before init/attach/export.
This tool never accepts the Minecraft EULA, starts Minecraft, or contacts a remote.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
WORLD_ID = re.compile(r"[1-9A-HJ-NP-Za-km-z]{4}")
STAMP = re.compile(r"\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}")
REPO_MARKER = "mvs-fastback.json"
LFS_HEADER = b"version https://git-lfs.github.com/spec/v1\n"
LFS_POINTER = re.compile(rb"version https://git-lfs.github.com/spec/v1\noid sha256:([a-f0-9]{64})\nsize ([0-9]+)\n?")
RESERVED_NAMES = {"CON", "PRN", "AUX", "NUL", *[f"COM{i}" for i in range(1, 10)], *[f"LPT{i}" for i in range(1, 10)]}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def checked(path):
    path = Path(path).absolute()
    for part in (path, *path.parents):
        require(not part.is_symlink(), "Unexpected symbolic link: " + str(part))
    return path.resolve()


def regular(path):
    path = checked(path)
    require(path.is_file(), "Required file is missing: " + str(path))
    return path


def safe_world(value):
    require(isinstance(value, str) and 0 < len(value) <= 128
            and re.fullmatch(r'[^/\\:\x00-\x1f<>"|?*]+', value)
            and not value.startswith(".") and not value.endswith((".", " ")),
            "level-name must be a single safe directory name")
    require(value.split(".")[0].upper() not in RESERVED_NAMES, "Reserved world directory name")
    return value


def world_name(data_dir, explicit=None):
    if explicit is not None:
        return safe_world(explicit)
    values = {}
    for line in regular(data_dir / "server.properties").read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if line and not line.startswith(("#", "!")):
            pair = re.split(r"\s*[:=]\s*|\s+", line, maxsplit=1)
            values[pair[0]] = pair[1] if len(pair) > 1 else ""
    return safe_world(values.get("level-name", "world"))


def git_env():
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_SYSTEM=os.devnull, GIT_CONFIG_GLOBAL=os.devnull,
                       GIT_TERMINAL_PROMPT="0", GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1",
                       GIT_ALLOW_PROTOCOL="", GIT_LFS_SKIP_SMUDGE="1")
    return environment


def git_args(arguments, repo=None):
    result = ["git", "-c", "core.hooksPath=" + os.devnull, "-c", "core.fsmonitor=false"]
    if repo is not None:
        result += ["--git-dir=" + str(repo)]
    return result + list(arguments)


def git(arguments, repo=None, optional=False):
    result = subprocess.run(git_args(arguments, repo), env=git_env(), capture_output=True, timeout=120)
    if optional and result.returncode == 1:
        return None
    require(result.returncode == 0, "Git operation failed: " + arguments[0])
    return result.stdout


def dependencies():
    require(shutil.which("git") is not None, "Git is required; install Git and Git LFS")
    git(["--version"])
    git(["lfs", "version"])


def atomic_bytes(path, data, exclusive=False, mode=None):
    path = checked(path)
    descriptor, temporary = tempfile.mkstemp(prefix=".fastback-state-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        if mode is not None:
            os.chmod(temporary, mode)
        if exclusive:
            os.link(temporary, path)
        else:
            os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def write_json(path, value, exclusive=False):
    atomic_bytes(path, (json.dumps(value, sort_keys=True, indent=2) + "\n").encode(), exclusive)


def read_json(path):
    return json.loads(regular(path).read_text(encoding="utf-8"))


@contextmanager
def init_lock(path, blocking=False):
    path = checked(path)
    if path.exists():
        regular(path)
    with path.open("a+b") as stream:
        if os.name == "nt":
            import msvcrt
            if path.stat().st_size == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_LOCK if blocking else msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        try:
            yield
        finally:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)


def identity(state):
    return {key: state[key] for key in ("format", "world", "world_id", "token")}


def read_identity(repo, world):
    require(checked(repo).is_dir(), "Backup repository is missing; restore the original backup mount")
    record = read_json(repo / REPO_MARKER)
    require(isinstance(record, dict) and set(record) == {"format", "world", "world_id", "token"}
            and record["format"] == 1 and record["world"] == world
            and isinstance(record["world_id"], str) and WORLD_ID.fullmatch(record["world_id"])
            and isinstance(record["token"], str) and re.fullmatch(r"[a-f0-9]{32}", record["token"]),
            "Unrecognized external backup repository; refusing adoption")
    return record


def local_config(repo, name):
    value = git(["config", "--local", "--no-includes", "--get", name], repo, optional=True)
    return None if value is None else value.decode().strip()


def validate_repo(repo, record, world=None):
    require(read_identity(repo, record["world"]) == identity(record), "Backup repository identity differs from local state")
    require(git(["rev-parse", "--is-bare-repository"], repo).strip() == b"false", "Expected a FastBack worktree repository")
    require(local_config(repo, "lfs.storage") == "lfs", "Unsupported LFS storage setting; preserve and inspect existing objects")
    if world is not None:
        require(local_config(repo, "core.worktree") == str(world), "Repository worktree differs; use explicit --attach-existing after recovery")


def check_link(world, repo, required=False):
    link = world / ".git"
    if link.is_symlink():
        require(link.resolve() == repo, "World .git points to a different backup repository")
        require(repo.is_dir(), "World .git target is missing; restore the original backup mount")
        return True
    require(not link.exists(), "Existing world .git is not managed by this helper; refusing migration or overwrite")
    require(not required, "Managed world .git link is missing; explicit recovery is required")
    return False


def allow_repository_symlink(data_dir, world, repo, state_dir):
    """Permit only this already-validated absolute Git target in Minecraft."""
    target = str(repo)
    require("\n" not in target and "\r" not in target, "Repository path cannot contain line breaks")
    # Minecraft matches the literal readSymbolicLink target, not its resolved path.
    require(os.readlink(world / ".git") == target,
            "World .git must use the managed absolute repository target")
    quoted = r"\Q" + target.replace(r"\E", r"\E\\E\Q") + r"\E"
    rule = ("[regex]^" + quoted + "$").encode("utf-8")
    # All worlds share this file. A separate common lock prevents lost rules when
    # different worlds initialize concurrently; per-world locks are still held.
    with init_lock(state_dir / ".allowed-symlinks.lock", blocking=True):
        path = checked(data_dir / "allowed_symlinks.txt")
        before = regular(path).read_bytes() if path.exists() else None
        if before is not None and rule in before.splitlines():
            return False
        mode = stat.S_IMODE(path.stat().st_mode) if before is not None else 0o644
        if before is not None and (not mode & 0o222 or not os.access(path, os.W_OK)):
            raise PermissionError("Minecraft allowed_symlinks.txt is read-only; preserve it and grant the server user write access")
        separator = b"" if not before or before.endswith((b"\n", b"\r")) else b"\n"
        atomic_bytes(path, (before or b"") + separator + rule + b"\n", exclusive=before is None, mode=mode)
        return True


def configure_new_repo(stage, repo, world, state, backup_dir):
    if not stage.exists():
        stage.mkdir()
    marker = stage / REPO_MARKER
    if marker.exists():
        require(read_json(marker) == identity(state), "Initialization staging directory has another owner")
    else:
        require(not any(stage.iterdir()), "Unknown initialization staging contents")
        write_json(marker, identity(state), exclusive=True)
    # Retrying an interrupted, unpublished staging repository is safe. It has
    # never been linked into the world and must not contain any snapshot refs.
    if (stage / "HEAD").exists():
        require(not git(["for-each-ref", "--format=%(refname)"], stage).strip(), "Staged repository unexpectedly contains refs")
    git(["init", "--bare", "--initial-branch=main", "--template=", str(stage)])
    defaults = {
        "core.bare": "false", "core.worktree": str(world), "commit.gpgsign": "false",
        "user.name": state["world_id"], "user.email": state["world_id"] + "@fastback",
        "lfs.storage": "lfs", "fastback.native-git-enabled": "true", "fastback.backup-enabled": "true",
        "fastback.autoback-action": "full-gc", "fastback.autoback-wait": "60",
        "fastback.shutdown-action": "local", "fastback.retention-policy": "fixed count=24",
        "fastback.restore-directory": str(backup_dir / "restores" / state["world"]),
    }
    for key, value in defaults.items():
        git(["config", "--local", key, value], stage)
    git(["lfs", "install", "--local", "--skip-repo"], stage)
    validate_repo(stage, state, world)
    require(not repo.exists() and not repo.is_symlink(), "External repository appeared during initialization")
    os.rename(stage, repo)


def initialize(data_dir, backup_dir, world=None, attach_existing=False):
    dependencies()
    data_dir, backup_dir = checked(data_dir), checked(backup_dir)
    require(data_dir.is_dir(), "Server data directory is missing")
    require(backup_dir.is_dir(), "Backup directory is missing; mount the existing backups before starting")
    require(backup_dir != data_dir and data_dir not in backup_dir.parents, "Backup directory must be outside server data")
    name = world_name(data_dir, world)
    world = checked(data_dir / name)
    repo = checked(backup_dir / "repos" / (name + ".git"))
    state_dir = checked(data_dir / ".mvs/fastback")
    state_dir.mkdir(parents=True, exist_ok=True)
    state_file = state_dir / (name + ".json")
    with init_lock(state_dir / (name + ".lock")):
        id_file = checked(world / ".fastback/world-id")
        require(not (world / "fastback").exists() and not (world / ".fastback/world.uuid").exists(),
                "Legacy FastBack identity requires explicit migration; no files were moved")
        state = read_json(state_file) if state_file.exists() else None
        link_present = check_link(world, repo)
        current_id = regular(id_file).read_text().strip() if id_file.exists() else None
        if current_id is not None:
            require(WORLD_ID.fullmatch(current_id), "Unsupported existing FastBack world-id; refusing replacement")
        if state is not None:
            require(isinstance(state, dict) and state.get("format") == 1 and state.get("world") == name
                    and state.get("data_dir") == str(data_dir) and state.get("repository") == str(repo)
                    and state.get("phase") in ("pending", "ready") and state.get("mode") in ("create", "attach")
                    and isinstance(state.get("world_id"), str) and WORLD_ID.fullmatch(state["world_id"])
                    and isinstance(state.get("token"), str) and re.fullmatch(r"[a-f0-9]{32}", state["token"]),
                    "Existing FastBack initialization state does not match this deployment")
            require(current_id in (None, state["world_id"]), "World identity changed during initialization")
            if state["phase"] == "ready":
                validate_repo(repo, state, world)
                require(current_id == state["world_id"], "Managed world-id is missing; do not create a new backup history")
                check_link(world, repo, required=True)
                changed = allow_repository_symlink(data_dir, world, repo, state_dir)
                return {"world": name, "world_id": current_id, "repository": str(repo), "changed": changed}
        else:
            if attach_existing:
                regular(world / "level.dat")
                require(current_id is not None, "Restored world-id is required for --attach-existing")
                record = read_identity(repo, name)
                require(record["world_id"] == current_id, "Restored world-id does not match the backup repository")
                validate_repo(repo, record)
                mode = "attach"
            else:
                require(not repo.exists() and not link_present,
                        "Existing external repository has no local state; restore a matching world and use --attach-existing")
                record = {"format": 1, "world": name, "world_id": current_id or "".join(secrets.choice(BASE58) for _ in range(4)),
                          "token": uuid.uuid4().hex}
                mode = "create"
            state = dict(record, data_dir=str(data_dir), repository=str(repo), phase="pending", mode=mode)
            write_json(state_file, state, exclusive=True)
        if state["mode"] == "attach":
            regular(world / "level.dat")
            require(current_id == state["world_id"], "Restored world identity changed")
            validate_repo(repo, state)
            git(["config", "--local", "core.worktree", str(world)], repo)
        elif repo.exists():
            # Resume only the completed repo carrying this pending transaction ID.
            validate_repo(repo, state, world)
        else:
            require(not link_present, "Backup mount/repository is missing; refusing to replace history")
            world.mkdir(parents=True, exist_ok=True)
            checked(repo.parent).mkdir(parents=True, exist_ok=True)
            stage = checked(repo.parent / ("." + name + ".init-" + state["token"]))
            configure_new_repo(stage, repo, world, state, backup_dir)
        if current_id is None:
            id_file.parent.mkdir(parents=True, exist_ok=True)
            atomic_bytes(id_file, (state["world_id"] + "\n").encode("ascii"), exclusive=True)
        if not check_link(world, repo):
            # Directory symlinks are required by JGit; a gitfile is not compatible.
            (world / ".git").symlink_to(repo, target_is_directory=True)
        validate_repo(repo, state, world)
        check_link(world, repo, required=True)
        allow_repository_symlink(data_dir, world, repo, state_dir)
        ready = dict(state, phase="ready")
        write_json(state_file, ready)
        return {"world": name, "world_id": state["world_id"], "repository": str(repo), "changed": True}


def repository(backup_dir, world):
    dependencies()
    backup_dir = checked(backup_dir)
    require(backup_dir.is_dir(), "Backup mount is missing")
    name = safe_world(world)
    repo = checked(backup_dir / "repos" / (name + ".git"))
    record = read_identity(repo, name)
    validate_repo(repo, record)
    return backup_dir, repo, record


def snapshot_ref(record, snapshot):
    prefix = record["world_id"] + "/"
    require(snapshot.startswith(prefix), "Snapshot must belong to this world's FastBack ID")
    stamp = snapshot[len(prefix):]
    require(STAMP.fullmatch(stamp), "Snapshot must be WORLDID/yyyy-MM-dd_HH-mm-ss")
    datetime.strptime(stamp, "%Y-%m-%d_%H-%M-%S")
    return "refs/heads/" + snapshot


def list_snapshots(backup_dir, world):
    _, repo, record = repository(backup_dir, world)
    output = git(["for-each-ref", "--format=%(refname)", "refs/heads/" + record["world_id"] + "/"], repo)
    snapshots = []
    for ref in output.decode().splitlines():
        name = ref.removeprefix("refs/heads/")
        snapshot_ref(record, name)
        snapshots.append(name)
    return sorted(snapshots)


def safe_entry(name):
    path = PurePosixPath(name)
    require(not path.is_absolute() and str(path) == name and path.parts
            and all(part not in (".", "..") and part.lower() != ".git"
                    and not part.endswith((".", " ")) and part.split(".")[0].upper() not in RESERVED_NAMES
                    and re.fullmatch(r'[^\\:\x00-\x1f<>"|?*]+', part) for part in path.parts),
            "Snapshot contains an unsafe path")
    return path


def copy_lfs(repo, pointer, target):
    match = LFS_POINTER.fullmatch(pointer)
    require(match is not None, "Unsupported or malformed LFS pointer; export cancelled")
    oid, size = match[1].decode(), int(match[2])
    source = regular(repo / "lfs/objects" / oid[:2] / oid[2:4] / oid)
    require(source.stat().st_size == size, "LFS object size mismatch; export cancelled")
    digest = hashlib.sha256()
    with source.open("rb") as stream, target.open("xb") as output:
        while chunk := stream.read(1024 * 1024):
            digest.update(chunk)
            output.write(chunk)
    require(digest.hexdigest() == oid, "LFS object hash mismatch; export cancelled")


def export_snapshot(backup_dir, world, snapshot, target=None):
    backup_dir, repo, record = repository(backup_dir, world)
    ref = snapshot_ref(record, snapshot)
    commit = git(["rev-parse", "--verify", ref + "^{commit}"], repo).decode().strip()
    require(re.fullmatch(r"[a-f0-9]{40}|[a-f0-9]{64}", commit), "Invalid snapshot commit")
    configured_world = local_config(repo, "core.worktree")
    target = checked(target if target is not None else backup_dir / "restores" / world / snapshot.split("/")[1])
    source_world = Path(configured_world).resolve() if configured_world else None
    require(target != repo and repo not in target.parents and target not in repo.parents, "Export destination overlaps the backup repository")
    require(source_world is None or (target != source_world and source_world not in target.parents
                                    and target not in source_world.parents), "Export destination overlaps the original world")
    require(not target.exists() or (target.is_dir() and not any(target.iterdir())), "Export destination must be absent or empty")
    entries = []
    for raw in git(["ls-tree", "-r", "-z", commit], repo).split(b"\0"):
        if not raw:
            continue
        metadata, raw_name = raw.split(b"\t", 1)
        mode, kind, oid = metadata.split()
        require(mode in (b"100644", b"100755") and kind == b"blob", "Snapshot contains a symlink or submodule; export cancelled")
        name = safe_entry(raw_name.decode("utf-8"))
        entries.append((mode, oid, name))
    require(entries, "Snapshot is empty")
    target.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=".fastback-export-", dir=target.parent))
    process = None
    lfs_count = 0
    try:
        process = subprocess.Popen(git_args(["cat-file", "--batch"], repo), env=git_env(),
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        for mode, oid, name in entries:
            process.stdin.write(oid + b"\n")
            process.stdin.flush()
            header = process.stdout.readline().split()
            require(len(header) == 3 and header[0] == oid and header[1] == b"blob", "Git blob could not be read")
            size = int(header[2])
            require(len(oid) in (40, 64), "Unsupported Git object ID")
            blob_hash = hashlib.new("sha1" if len(oid) == 40 else "sha256")
            blob_hash.update(b"blob " + str(size).encode("ascii") + b"\0")
            output = stage.joinpath(*name.parts)
            output.parent.mkdir(parents=True, exist_ok=True)
            if size <= 1024:
                data = process.stdout.read(size)
                require(len(data) == size, "Truncated Git blob")
                blob_hash.update(data)
                if data.startswith(LFS_HEADER):
                    require(blob_hash.hexdigest().encode() == oid, "Git blob hash mismatch; export cancelled")
                    copy_lfs(repo, data, output)
                    lfs_count += 1
                else:
                    with output.open("xb") as stream:
                        stream.write(data)
            else:
                remaining = size
                with output.open("xb") as stream:
                    while remaining:
                        chunk = process.stdout.read(min(remaining, 1024 * 1024))
                        require(chunk, "Truncated Git blob")
                        if remaining == size:
                            require(not chunk.startswith(LFS_HEADER), "Oversized LFS pointer; export cancelled")
                        blob_hash.update(chunk)
                        stream.write(chunk)
                        remaining -= len(chunk)
            require(blob_hash.hexdigest().encode() == oid, "Git blob hash mismatch; export cancelled")
            require(process.stdout.read(1) == b"\n", "Invalid Git batch response")
            output.chmod(0o755 if mode == b"100755" else 0o644)
        process.stdin.close()
        require(process.wait(timeout=120) == 0, "Git object export failed")
        regular(stage / "level.dat")
        id_file = stage / ".fastback/world-id"
        if id_file.exists():
            require(regular(id_file).read_text().strip() == record["world_id"], "Snapshot identity differs from repository")
        else:
            id_file.parent.mkdir(parents=True, exist_ok=True)
            id_file.write_text(record["world_id"] + "\n", encoding="ascii")
        require(not target.exists() or (target.is_dir() and not any(target.iterdir())), "Export destination changed during verification")
        if target.exists():
            target.rmdir()
        os.rename(stage, target)
        return {"snapshot": snapshot, "commit": commit, "target": str(target), "files": len(entries), "lfs_objects_verified": lfs_count}
    finally:
        if process is not None:
            if process.poll() is None:
                process.kill()
                process.wait()
            for stream in (process.stdin, process.stdout):
                if stream is not None:
                    stream.close()
        if stage.exists():
            shutil.rmtree(stage)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init", help="Initialize or validate; never generate a Minecraft world")
    init.add_argument("--data-dir", type=Path, default=Path.cwd())
    init.add_argument("--backup-dir", type=Path, default=Path("../backups"))
    init.add_argument("--world")
    init.add_argument("--attach-existing", action="store_true", help="Explicitly attach a restored matching world to existing history")
    for name in ("list", "export"):
        action = commands.add_parser(name)
        action.add_argument("--backup-dir", type=Path, default=Path("../backups"))
        action.add_argument("--world", default="world")
        if name == "export":
            action.add_argument("--snapshot", required=True, help="WORLDID/yyyy-MM-dd_HH-mm-ss")
            action.add_argument("--target", type=Path)
    args = parser.parse_args(argv)
    if args.command == "init":
        result = initialize(args.data_dir, args.backup_dir, args.world, args.attach_existing)
    elif args.command == "list":
        result = list_snapshots(args.backup_dir, args.world)
    else:
        result = export_snapshot(args.backup_dir, args.world, args.snapshot, args.target)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, KeyError, subprocess.SubprocessError) as error:
        print("FastBack helper stopped: " + str(error), file=sys.stderr)
        sys.exit(1)
