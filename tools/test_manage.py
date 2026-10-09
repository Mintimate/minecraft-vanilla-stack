#!/usr/bin/env python3
"""Offline manage.sh tests: fake Docker, temporary fixtures and local PTYs only."""
import errno
import hashlib
import io
import json
import os
from pathlib import Path
import pty
import select
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest

CID = "b" * 64
OTHER = "c" * 64
HELPER = "d" * 64
IMAGE = "sha256:" + "a" * 64

FAKE_DOCKER = r'''import json, os, pathlib, sys
args = sys.argv[1:]
state_path = pathlib.Path(os.environ["FAKE_DOCKER_STATE"])
state = json.loads(state_path.read_text())
with pathlib.Path(os.environ["FAKE_DOCKER_LOG"]).open("a") as output:
    output.write(json.dumps({"args": args, "cwd": str(pathlib.Path.cwd()),
                            "compose_file": os.environ.get("COMPOSE_FILE"),
                            "compose_separator": os.environ.get("COMPOSE_PATH_SEPARATOR")}) + "\n")
def save():
    state_path.write_text(json.dumps(state))
def boolean(value):
    return "true" if value else "false"
def stop():
    for cid in state["ids"]:
        item = state["containers"][cid]
        item.update({"running": False, "status": "exited", "exit_code": 0, "oom": False, "error": ""})
        item.update(state.get("stop_result", {}))
    save()
if args[:2] == ["compose", "version"]:
    print("Docker Compose version fixture")
elif args and args[0] == "compose":
    if args[1] != "--project-directory":
        raise SystemExit("Compose must use an explicit project directory")
    command = args[3]
    if command == "ps":
        if "--quiet" in args or "-q" in args:
            print("\n".join(state["ids"]))
        else:
            print("fixture minecraft status")
    elif command == "logs":
        print("fixture Minecraft log")
    elif command == "stop":
        stop()
    elif command in ("up", "restart"):
        for cid in state["ids"]:
            state["containers"][cid].update({"running": True, "status": "running"})
        save()
    else:
        raise SystemExit("Unexpected compose command: " + repr(args))
elif args and args[0] == "inspect":
    item = state["containers"][args[-1]]
    template = args[args.index("--format") + 1]
    fields = {
        '{{index .Config.Labels "com.docker.compose.service"}}': item["service"],
        '{{index .Config.Labels "com.docker.compose.project"}}': item["project"],
        '{{.Config.OpenStdin}} {{.Config.Tty}}': boolean(item["stdin"]) + " " + boolean(item["tty"]),
        '{{.State.Status}}': item["status"],
        '{{.State.Running}}': boolean(item["running"]),
        '{{.Image}}': item["image"],
        '{{.Config.Image}}': "docker.cnb.cool/fixture/repository/vanilla-plus:v1.2.3",
        '{{.State.Status}}|{{.State.ExitCode}}|{{.State.OOMKilled}}|{{.State.Error}}':
            item["status"] + "|" + str(item["exit_code"]) + "|" + boolean(item["oom"]) + "|" + item["error"],
    }
    if template in fields:
        print(fields[template])
    elif template.startswith('{{range .Mounts}}{{if eq .Destination "/data"}}'):
        key = "Type" if "{{.Type}}" in template else "Source"
        print("".join(m[key] for m in item["mounts"] if m["Destination"] == "/data"))
    elif template.startswith('{{range .Mounts}}{{printf'):
        print("\n".join(m["Type"] + ":" + m["Source"] for m in item["mounts"]))
    else:
        raise SystemExit("Unexpected inspect template: " + template)
elif args[:2] == ["image", "inspect"]:
    if args[args.index("--format") + 1] != '{{json .RepoDigests}}' or args[-1] != "sha256:" + "a" * 64:
        raise SystemExit("Unexpected image inspect")
    print(json.dumps(["docker.cnb.cool/fixture/repository/vanilla-plus@sha256:" + "e" * 64]))
elif args and args[0] == "ps":
    print("\n".join(cid for cid, item in state["containers"].items() if item["running"]))
elif args and args[0] == "logs":
    print("fixture: Saving chunks and stopping server")
elif args and args[0] == "attach":
    print("fixture console attached")
elif args and args[0] == "run":
    if "--cidfile" in args:
        pathlib.Path(args[args.index("--cidfile") + 1]).write_text("d" * 64)
    mode = state.get("helper_mode", "ok")
    if mode == "busy":
        print("fixture runtime lock is held", file=sys.stderr)
        raise SystemExit(74)
    data = pathlib.Path(os.environ["FAKE_DOCKER_ARCHIVE"]).read_bytes()
    if mode == "stream-failure":
        sys.stdout.buffer.write(data[:32])
        raise SystemExit(55)
    sys.stdout.buffer.write(b"not a gzip archive" if mode == "corrupt" else data)
elif args and args[0] == "start":
    if state.get("start_failure"):
        raise SystemExit(47)
    state["containers"][args[-1]].update({"running": True, "status": "running"})
    save()
    print(args[-1])
elif args and args[0] == "rm":
    if args != ["rm", "--force", "d" * 64]:
        raise SystemExit("Cleanup must only remove the backup helper")
else:
    raise SystemExit("Unexpected Docker invocation: " + repr(args))
'''


class ManageTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="mvs-manage-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.deployment = self.root / "deployment with spaces"
        self.deployment.mkdir()
        self.script = self.deployment / "manage.sh"
        shutil.copyfile(Path(__file__).resolve().parents[1] / "manage.sh", self.script)
        (self.deployment / "compose.yaml").write_text("services: {minecraft: {image: fixture}}\n")
        self.foreign = self.root / "other working directory"
        self.foreign.mkdir()
        self.state_path = self.root / "fake-state.json"
        self.log_path = self.root / "docker-calls.jsonl"
        item = {"service": "minecraft", "project": "fixture", "stdin": True, "tty": True,
                "running": True, "status": "running", "exit_code": 0, "oom": False, "error": "",
                "image": IMAGE, "mounts": [{"Type": "volume", "Source": "/fixture/volume/_data",
                                           "Destination": "/data"}]}
        self.write_state({"ids": [CID], "containers": {CID: item}})
        archive_path = self.root / "fixture.tar.gz"
        with tarfile.open(archive_path, "w:gz") as archive:
            content = b"temporary world fixture, never a real game world"
            info = tarfile.TarInfo("world/level.dat")
            info.size = len(content)
            archive.addfile(info, io.BytesIO(content))
        bin_dir = self.root / "bin"
        bin_dir.mkdir()
        docker = bin_dir / "docker"
        docker.write_text(f"#!{sys.executable}\n" + FAKE_DOCKER)
        docker.chmod(0o755)
        cleared = {"COMPOSE_FILE", "COMPOSE_PROJECT_NAME", "COMPOSE_PATH_SEPARATOR", "MC_COMPOSE_DIR", "MC_BACKUP_DIR"}
        self.env = {key: value for key, value in os.environ.items() if key not in cleared}
        self.env.update(PATH=str(bin_dir) + os.pathsep + os.environ["PATH"], PYTHONDONTWRITEBYTECODE="1",
                        FAKE_DOCKER_STATE=str(self.state_path), FAKE_DOCKER_LOG=str(self.log_path),
                        FAKE_DOCKER_ARCHIVE=str(archive_path))

    def state(self):
        return json.loads(self.state_path.read_text())

    def write_state(self, value):
        self.state_path.write_text(json.dumps(value))

    def configure(self, **values):
        state = self.state()
        state.update(values)
        self.write_state(state)

    def configure_container(self, **values):
        state = self.state()
        state["containers"][CID].update(values)
        self.write_state(state)

    def calls(self):
        return [json.loads(line) for line in self.log_path.read_text().splitlines()] if self.log_path.exists() else []

    def arguments(self):
        return [call["args"] for call in self.calls()]

    def mutations(self, calls=None):
        return [args for args in (self.arguments() if calls is None else calls)
                if args[0] in ("run", "start", "stop", "restart", "rm", "exec", "attach")
                or (args[0] == "compose" and any(command in args for command in ("up", "stop", "restart")))]

    def run_script(self, *arguments, tty=False, terminal_input=b"", **environment):
        command = ["sh", str(self.script), *arguments]
        env = dict(self.env, **environment)
        if not tty:
            return subprocess.run(command, cwd=self.foreign, env=env, text=True, capture_output=True, timeout=15)
        master, slave = pty.openpty()
        process = None
        output = bytearray()
        try:
            process = subprocess.Popen(command, cwd=self.foreign, env=env, stdin=slave, stdout=slave, stderr=slave)
            os.close(slave)
            slave = None
            if terminal_input:
                os.write(master, terminal_input)
            deadline = time.monotonic() + 15
            while time.monotonic() < deadline:
                ready, _, _ = select.select([master], [], [], 0.1)
                if ready:
                    try:
                        block = os.read(master, 65536)
                    except OSError as error:
                        if error.errno == errno.EIO:
                            break
                        raise
                    if not block:
                        break
                    output.extend(block)
                elif process.poll() is not None:
                    break
            code = process.wait(timeout=1)
            return subprocess.CompletedProcess(command, code, output.decode(errors="replace"), "")
        finally:
            if slave is not None:
                os.close(slave)
            os.close(master)
            if process is not None and process.poll() is None:
                process.kill()
                process.wait(timeout=3)

    def assert_success(self, *arguments, **options):
        result = self.run_script(*arguments, **options)
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        return result

    def backup_folders(self, base=None):
        return sorted((base or self.deployment / "backups").glob("backup-*"))

    def assert_valid_backup(self, folder):
        archive = folder / "data.tar.gz"
        self.assertFalse((folder / "data.tar.gz.partial").exists())
        with tarfile.open(archive, "r:gz") as data:
            self.assertIn("world/level.dat", data.getnames())
        self.assertEqual(hashlib.sha256(archive.read_bytes()).hexdigest(),
                         (folder / "SHA256SUMS.txt").read_text().split()[0])
        metadata = (folder / "metadata.txt").read_text()
        self.assertIn("CONTAINER_ID=" + CID, metadata)
        self.assertIn("IMAGE_ID=" + IMAGE, metadata)
        self.assertIn("IMAGE_REFERENCE=docker.cnb.cool/fixture/repository/vanilla-plus:v1.2.3", metadata)
        self.assertIn("docker.cnb.cool/fixture/repository/vanilla-plus@sha256:" + "e" * 64, metadata)

    def test_help_and_non_terminal_default_are_read_only(self):
        for arguments in ((), ("help",), ("--help",)):
            with self.subTest(arguments=arguments):
                self.assertIn("Usage:", self.assert_success(*arguments).stdout)
        self.assertEqual([], self.calls())

    def test_unknown_and_extra_arguments_do_not_call_docker(self):
        for arguments in (("unknown",), ("start", "extra"), ("console", "stop"), ("whitelist", "add", "Player")):
            with self.subTest(arguments=arguments):
                self.assertNotEqual(0, self.run_script(*arguments).returncode)
        self.assertEqual([], self.calls())

    def test_terminal_menu_can_exit_without_docker(self):
        result = self.assert_success(tty=True, terminal_input=b"0\n")
        self.assertIn("0) Exit", result.stdout)
        self.assertEqual([], self.calls())

    def test_standard_commands_preserve_compose_arguments(self):
        for command in ("start", "stop", "restart", "status", "logs"):
            self.assert_success(command)
        commands = [call["args"][3:] for call in self.calls() if call["args"][:2] == ["compose", "--project-directory"]]
        self.assertIn(["up", "-d", "--no-build", "minecraft"], commands)
        self.assertIn(["stop", "minecraft"], commands)
        self.assertIn(["restart", "minecraft"], commands)
        self.assertIn(["ps", "--all"], commands)
        self.assertIn(["logs", "--tail", "100", "--follow", "minecraft"], commands)
        self.assertFalse((self.deployment / ".mvs-manage.lock").exists())

    def test_running_from_another_directory_uses_script_directory(self):
        self.assert_success("status")
        project_calls = [call for call in self.calls() if "--project-directory" in call["args"]]
        self.assertTrue(project_calls)
        for call in project_calls:
            self.assertEqual(str(self.deployment), call["args"][call["args"].index("--project-directory") + 1])
            self.assertEqual(str(self.deployment), call["cwd"])

    def test_compose_directory_and_multiple_file_overrides_are_preserved(self):
        deployment = self.root / "custom deployment ; literal"
        deployment.mkdir()
        names = ("base config.yaml", "override $(touch INJECTED).yaml")
        for name in names:
            (deployment / name).write_text("services: {}\n")
        compose_files = "|".join(names)
        self.assert_success("status", MC_COMPOSE_DIR=str(deployment), COMPOSE_FILE=compose_files, COMPOSE_PATH_SEPARATOR="|")
        for call in self.calls():
            self.assertEqual(compose_files, call["compose_file"])
            self.assertEqual("|", call["compose_separator"])
            if "--project-directory" in call["args"]:
                self.assertEqual(str(deployment), call["args"][2])
        self.assertFalse((deployment / "INJECTED").exists())

    def test_console_and_whitelist_require_a_terminal(self):
        for command in ("console", "whitelist"):
            self.assertNotEqual(0, self.run_script(command).returncode)
        self.assertEqual([], self.calls())

    def test_console_and_whitelist_only_attach_for_manual_input(self):
        self.assert_success("console", tty=True)
        result = self.assert_success("whitelist", tty=True)
        for sample in ("whitelist add PlayerName", "whitelist list", "whitelist remove PlayerName"):
            self.assertIn(sample, result.stdout)
        attaches = [args for args in self.arguments() if args[0] == "attach"]
        self.assertEqual(2, len(attaches))
        self.assertTrue(all(args == ["attach", "--sig-proxy=false", "--detach-keys", "ctrl-p,ctrl-q", CID]
                            for args in attaches))
        self.assertFalse(any(args[0] in ("exec", "run") or any("rcon" in value.lower() for value in args)
                             for args in self.arguments()))

    def test_console_rejects_ambiguous_stopped_or_noninteractive_containers(self):
        baseline = self.state()
        cases = [{"ids": []}, {"ids": [CID, OTHER]}, {"running": False, "status": "exited"},
                 {"stdin": False}, {"tty": False}, {"service": "another-service"}]
        for case in cases:
            with self.subTest(case=case):
                self.write_state(json.loads(json.dumps(baseline)))
                if "ids" in case:
                    self.configure(**case)
                else:
                    self.configure_container(**case)
                before = len(self.calls())
                self.assertNotEqual(0, self.run_script("console", tty=True).returncode)
                self.assertFalse(any(call["args"][0] == "attach" for call in self.calls()[before:]))

    def test_backup_rejects_missing_or_multiple_containers(self):
        for ids in ([], [CID, OTHER]):
            with self.subTest(ids=ids):
                self.configure(ids=ids)
                self.assertNotEqual(0, self.run_script("backup").returncode)
                self.assertEqual([], self.mutations())

    def test_running_backup_verifies_data_and_restarts_exact_original_container(self):
        self.assert_success("backup")
        folders = self.backup_folders()
        self.assertEqual(1, len(folders))
        self.assert_valid_backup(folders[0])
        calls = self.arguments()
        self.assertEqual([["start", CID]], [args for args in calls if args[0] == "start"])
        stop = [args for args in calls if args[:2] == ["compose", "--project-directory"] and "stop" in args]
        self.assertEqual(1, len(stop))
        self.assertEqual(["stop", "minecraft"], stop[0][3:])
        helper = next(args for args in calls if args[0] == "run")
        for flag, value in (("--volumes-from", CID + ":ro"), ("--user", "0:0"),
                            ("--network", "none"), ("--entrypoint", "python3")):
            self.assertEqual(value, helper[helper.index(flag) + 1])
        self.assertIn("--pull=never", helper)
        self.assertIn("--no-healthcheck", helper)
        self.assertIn(IMAGE, helper)
        program = helper[helper.index("-c") + 1]
        self.assertIn("/data/.mvs/runtime.lock", program)
        self.assertIn("os.O_RDONLY", program)
        self.assertIn("fcntl.flock", program)
        self.assertTrue(self.state()["containers"][CID]["running"])

    def test_stopped_headless_container_is_backed_up_without_starting_it(self):
        self.configure_container(running=False, status="exited", exit_code=143, stdin=False, tty=False)
        self.assert_success("backup")
        self.assert_valid_backup(self.backup_folders()[0])
        self.assertFalse(any(args[0] == "start" or "stop" in args for args in self.arguments()))
        self.assertFalse(self.state()["containers"][CID]["running"])

    def test_unclean_exit_oom_or_engine_error_cancel_backup_and_restart(self):
        cases = [{"exit_code": 1}, {"exit_code": 137}, {"oom": True},
                 {"error": "engine failure"}, {"status": "running", "running": True}]
        for result in cases:
            with self.subTest(result=result):
                self.configure_container(running=True, status="running", exit_code=0, oom=False, error="")
                self.configure(stop_result=result)
                before = len(self.calls())
                self.assertNotEqual(0, self.run_script("backup").returncode)
                recent = [call["args"] for call in self.calls()[before:]]
                self.assertFalse(any(args[0] in ("run", "start") for args in recent))

    def test_archive_stream_or_runtime_lock_failure_leaves_partial_and_no_restart(self):
        for mode in ("stream-failure", "busy"):
            with self.subTest(mode=mode):
                self.configure_container(running=True, status="running")
                self.configure(helper_mode=mode)
                self.assertNotEqual(0, self.run_script("backup").returncode)
                self.assertFalse(self.state()["containers"][CID]["running"])
        self.assertEqual(2, len(list((self.deployment / "backups").glob("*/data.tar.gz.partial"))))
        self.assertFalse(list((self.deployment / "backups").glob("*/data.tar.gz")))
        self.assertFalse(any(args[0] == "start" for args in self.arguments()))
        self.assertTrue(all(args[-1] == HELPER for args in self.arguments() if args[0] == "rm"))
        self.assertFalse((self.deployment / ".mvs-manage.lock").exists())

    def test_invalid_gzip_is_not_finalized_or_restarted(self):
        self.configure(helper_mode="corrupt")
        self.assertNotEqual(0, self.run_script("backup").returncode)
        self.assertTrue(list((self.deployment / "backups").glob("*/data.tar.gz.partial")))
        self.assertFalse(list((self.deployment / "backups").glob("*/data.tar.gz")))
        self.assertFalse(any(args[0] == "start" for args in self.arguments()))

    def test_backup_destination_inside_bind_source_is_rejected_including_symlinks(self):
        data = self.root / "bind data"
        data.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(data, target_is_directory=True)
        self.configure_container(mounts=[{"Type": "bind", "Source": str(data), "Destination": "/data"}])
        for target in (data / "backups", alias / "backups"):
            with self.subTest(target=target):
                self.assertNotEqual(0, self.run_script("backup", MC_BACKUP_DIR=str(target)).returncode)
                self.assertEqual([], self.mutations())

    def test_another_running_container_sharing_data_prevents_backup(self):
        state = self.state()
        state["containers"][OTHER] = json.loads(json.dumps(state["containers"][CID]))
        self.write_state(state)
        self.assertNotEqual(0, self.run_script("backup").returncode)
        self.assertEqual([], self.mutations())

    def test_maintenance_lock_blocks_mutating_commands(self):
        lock = self.deployment / ".mvs-manage.lock"
        lock.mkdir()
        (lock / "pid").write_text("12345\n")
        for command in ("start", "stop", "restart", "backup"):
            with self.subTest(command=command):
                self.assertNotEqual(0, self.run_script(command).returncode)
                self.assertEqual([], self.mutations())
        self.assertEqual("12345\n", (lock / "pid").read_text())

    def test_backup_paths_with_spaces_and_shell_characters_are_literal(self):
        backup = self.root / "backups ; $(touch INJECTED) 'quoted'"
        self.assert_success("backup", MC_BACKUP_DIR=str(backup))
        self.assert_valid_backup(self.backup_folders(backup)[0])
        for folder in (self.root, self.deployment, self.foreign):
            self.assertFalse((folder / "INJECTED").exists())

    def test_restart_failure_retains_a_complete_verified_backup(self):
        self.configure(start_failure=True)
        self.assertNotEqual(0, self.run_script("backup").returncode)
        self.assert_valid_backup(self.backup_folders()[0])
        self.assertFalse(self.state()["containers"][CID]["running"])
        self.assertEqual([["start", CID]], [args for args in self.arguments() if args[0] == "start"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
