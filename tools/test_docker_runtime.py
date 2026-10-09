#!/usr/bin/env python3
"""Runtime regressions using temporary server fixtures and loopback TCP only."""
from contextlib import contextmanager
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "mvs_docker_runtime", Path(__file__).resolve().parents[1] / "docker/runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


def file_info(name, data):
    return {"filename": name, "size": len(data),
            "hashes": {algorithm: hashlib.new(algorithm, data).hexdigest()
                       for algorithm in ("sha1", "sha512")}}


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="mvs-runtime-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.data = self.root / "data"
        self.source = self.make_image("old")

    def make_image(self, name, game="26.3", version="0.0.1", mod="old.jar", voice=True, fastback=True):
        folder = self.root / name
        (folder / "mods").mkdir(parents=True)
        launcher = ("launcher fixture " + name).encode()
        (folder / "fabric-server-launch.jar").write_bytes(launcher)
        mods = []
        for filename, content in ((mod, b"fixture " + mod.encode()), ("shared.jar", b"shared fixture")):
            (folder / "mods" / filename).write_bytes(content)
            mods.append({"sides": ["server"], "file": file_info(filename, content)})
        lock = {"minecraft": game, "pack_version": version, "java": 25, "fabric_loader": "0.19.5",
                "pack_id": "vanilla-plus", "features": {"voice": voice, "fastback": fastback},
                "server_launcher": file_info("fabric-server-launch.jar", launcher), "mods": mods}
        (folder / "pack.lock.json").write_bytes(runtime.encoded(lock))
        (folder / "server.properties").write_bytes(b"server-port=25565\nenable-status=true\nenable-rcon=false\n")
        (folder / "server-icon.png").write_bytes(b"operator icon fixture")
        (folder / "eula.txt").write_bytes(b"# operator decision required\neula=false\n")
        if voice:
            config = folder / "config/plasmovoice/server/config.toml"
            config.parent.mkdir(parents=True)
            config.write_bytes(b"[host]\nport = 24454\n[voice.proximity]\ndistances = [8, 16, 32, 48]\ndefault_distance = 48\n")
        return folder

    def snapshot(self):
        return {p.relative_to(self.data).as_posix(): p.read_bytes()
                for p in self.data.rglob("*") if p.is_file()
                and not p.relative_to(self.data).as_posix().startswith(".mvs/backups/")}

    def test_first_prepare_initializes_pinned_files_without_accepting_eula(self):
        lock = runtime.prepare(self.source, self.data)
        self.assertEqual("26.3", lock["minecraft"])
        self.assertEqual((self.source / "mods/old.jar").read_bytes(), (self.data / "mods/old.jar").read_bytes())
        self.assertEqual("false", runtime.properties((self.data / "eula.txt").read_bytes())["eula"])
        manifest = json.loads((self.data / runtime.MANIFEST).read_bytes())
        self.assertEqual({"fabric-server-launch.jar", "mods/old.jar", "mods/shared.jar"}, set(manifest["files"]))
        self.assertFalse((self.data / "world").exists())
        self.assertFalse((self.data / runtime.JOURNAL).exists())
        voice = "config/plasmovoice/server/config.toml"
        self.assertEqual((self.source / voice).read_bytes(), (self.data / voice).read_bytes())
        self.assertEqual((self.source / "server-icon.png").read_bytes(), (self.data / "server-icon.png").read_bytes())

    def test_repeat_prepare_is_a_noop(self):
        runtime.prepare(self.source, self.data)
        before = self.snapshot()
        backups = list((self.data / ".mvs/backups").iterdir())
        with mock.patch.object(runtime, "atomic_write", side_effect=AssertionError("Unexpected rewrite")):
            runtime.prepare(self.source, self.data)
        self.assertEqual(before, self.snapshot())
        self.assertEqual(backups, list((self.data / ".mvs/backups").iterdir()))

    def test_generated_metadata_with_only_sha512_upgrades_existing_volume(self):
        runtime.prepare(self.source, self.data)
        (self.data / "world").mkdir()
        (self.data / "world/level.dat").write_bytes(b"existing world")
        (self.data / "server.properties").write_bytes(b"motd=operator settings\n")
        source = self.make_image("generated", version="0.0.2", mod="new.jar")
        path = source / "pack.lock.json"
        metadata = json.loads(path.read_text())
        metadata.update(format=1, name="Minecraft Vanilla Plus")
        for info in [metadata["server_launcher"], *(mod["file"] for mod in metadata["mods"])]:
            info["hashes"] = {"sha512": info["hashes"]["sha512"]}
            info["url"] = "https://example.invalid/" + info["filename"]
        for mod in metadata["mods"]:
            mod.update(slug=Path(mod["file"]["filename"]).stem, title="Fixture mod")
        path.write_bytes(runtime.encoded(metadata))
        runtime.prepare(source, self.data)
        self.assertFalse((self.data / "mods/old.jar").exists())
        self.assertEqual((source / "mods/new.jar").read_bytes(), (self.data / "mods/new.jar").read_bytes())
        self.assertEqual(b"existing world", (self.data / "world/level.dat").read_bytes())
        self.assertEqual(b"motd=operator settings\n", (self.data / "server.properties").read_bytes())

    def test_pack_without_voice_or_icon_does_not_require_or_seed_them(self):
        source = self.make_image("minimal", voice=False, fastback=False)
        (source / "server-icon.png").unlink()
        runtime.prepare(source, self.data)
        self.assertFalse((self.data / "config/plasmovoice").exists())
        self.assertFalse((self.data / "server-icon.png").exists())

    def test_features_must_be_explicit_booleans(self):
        target = self.source / "pack.lock.json"
        lock = json.loads(target.read_text())
        for features in (None, {}, {"voice": "false", "fastback": False}):
            lock["features"] = features
            target.write_bytes(runtime.encoded(lock))
            with self.subTest(features=features), self.assertRaisesRegex(ValueError, "boolean"):
                runtime.prepare(self.source, self.data)
        self.assertFalse((self.data / "mods").exists())

    def test_matching_legacy_zip_files_are_adopted(self):
        (self.data / "mods").mkdir(parents=True)
        for name in ("fabric-server-launch.jar", "mods/old.jar", "mods/shared.jar", "pack.lock.json"):
            (self.data / name).write_bytes((self.source / name).read_bytes())
        (self.data / "server.properties").write_bytes(b"motd=operator configuration\n")
        stamp = (self.data / "mods/old.jar").stat().st_mtime_ns
        runtime.prepare(self.source, self.data)
        self.assertEqual(stamp, (self.data / "mods/old.jar").stat().st_mtime_ns)
        self.assertEqual(b"motd=operator configuration\n", (self.data / "server.properties").read_bytes())

    def test_upgrade_removes_only_old_managed_jars_and_preserves_user_data(self):
        runtime.prepare(self.source, self.data)
        preserved = {"world/level.dat": b"world fixture", "config/custom.json": b"custom config",
                     "config/plasmovoice/server/config.toml": b'[host]\nport = 24454\n[host.public]\nip = "voice.example.org"\nport = 30000\n',
                     "whitelist.json": b"[]", "ops.json": b"[]", "server.properties": b"motd=my server\n",
                     "server-icon.png": b"custom operator icon",
                     "eula.txt": b"# keep this comment\neula=false\n"}
        for name, content in preserved.items():
            path = self.data / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        old = (self.data / "mods/old.jar").read_bytes()
        newer = self.make_image("new", version="0.0.2", mod="new.jar")
        runtime.prepare(newer, self.data)
        self.assertFalse((self.data / "mods/old.jar").exists())
        self.assertTrue((self.data / "mods/new.jar").exists())
        for name, content in preserved.items():
            self.assertEqual(content, (self.data / name).read_bytes(), name)
        backups = list((self.data / ".mvs/backups").glob("*/mods/old.jar"))
        self.assertEqual(1, len(backups))
        self.assertEqual(old, backups[0].read_bytes())

    def test_upgrade_seeds_missing_icon_without_managing_it(self):
        runtime.prepare(self.source, self.data)
        (self.data / "server-icon.png").unlink()
        newer = self.make_image("new", version="0.0.2", mod="new.jar")
        runtime.prepare(newer, self.data)
        self.assertEqual((newer / "server-icon.png").read_bytes(), (self.data / "server-icon.png").read_bytes())
        self.assertNotIn("server-icon.png", json.loads((self.data / runtime.MANIFEST).read_bytes())["files"])

    def test_upgrade_seeds_voice_config_in_existing_volume(self):
        runtime.prepare(self.source, self.data)
        voice = "config/plasmovoice/server/config.toml"
        # A volume made by the previous runtime has no voice config/managed entry.
        (self.data / voice).unlink()
        newer = self.make_image("new", version="0.0.2", mod="new.jar")
        runtime.prepare(newer, self.data)
        self.assertEqual((newer / voice).read_bytes(), (self.data / voice).read_bytes())
        self.assertNotIn(voice, json.loads((self.data / runtime.MANIFEST).read_bytes())["files"])

    def test_failed_upgrade_rolls_back_new_voice_config(self):
        runtime.prepare(self.source, self.data)
        voice = "config/plasmovoice/server/config.toml"
        (self.data / voice).unlink()
        before = self.snapshot()
        newer = self.make_image("new", version="0.0.2", mod="new.jar")
        original_write = runtime.atomic_write
        failed = False

        def fail_manifest(path, data, *args, **kwargs):
            nonlocal failed
            if path == self.data / runtime.MANIFEST and not failed:
                self.assertTrue((self.data / voice).exists())
                failed = True
                raise OSError("simulated manifest write failure")
            return original_write(path, data, *args, **kwargs)

        with mock.patch.object(runtime, "atomic_write", side_effect=fail_manifest):
            with self.assertRaisesRegex(OSError, "simulated manifest"):
                runtime.prepare(newer, self.data)
        self.assertTrue(failed)
        self.assertEqual(before, self.snapshot())
        self.assertFalse((self.data / voice).exists())

    def test_voice_config_symlink_is_rejected_without_writing_outside_data(self):
        self.data.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        (self.data / "config").symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            runtime.prepare(self.source, self.data)
        self.assertEqual([], list(outside.iterdir()))
        self.assertFalse((self.data / "mods").exists())

    def test_unknown_jar_and_user_modified_managed_jar_are_rejected(self):
        runtime.prepare(self.source, self.data)
        unknown = self.data / "mods/unknown.jar"
        unknown.write_bytes(b"user mod")
        with self.assertRaisesRegex(ValueError, "Unknown JAR"):
            runtime.prepare(self.source, self.data)
        self.assertEqual(b"user mod", unknown.read_bytes())
        unknown.unlink()
        target = self.data / "mods/old.jar"
        target.write_bytes(b"user edit")
        with self.assertRaisesRegex(ValueError, "modified or removed"):
            runtime.prepare(self.source, self.data)
        self.assertEqual(b"user edit", target.read_bytes())

    def test_different_unmanaged_launcher_is_not_adopted(self):
        self.data.mkdir()
        target = self.data / "fabric-server-launch.jar"
        target.write_bytes(b"user launcher")
        with self.assertRaisesRegex(ValueError, "refusing adoption"):
            runtime.prepare(self.source, self.data)
        self.assertEqual(b"user launcher", target.read_bytes())

    def test_missing_managed_file_is_not_silently_repaired(self):
        runtime.prepare(self.source, self.data)
        (self.data / "mods/old.jar").unlink()
        with self.assertRaisesRegex(ValueError, "modified or removed"):
            runtime.prepare(self.source, self.data)

    def test_concurrent_edit_is_not_adopted_as_an_upgrade_baseline(self):
        runtime.prepare(self.source, self.data)
        newer = self.make_image("new", version="0.0.2", mod="new.jar")
        original_scan = runtime.scan_mods
        target = self.data / "mods/old.jar"
        def edit_after_scan(root, allowed):
            original_scan(root, allowed)
            if root == self.data:
                target.write_bytes(b"concurrent user edit")
        with mock.patch.object(runtime, "scan_mods", side_effect=edit_after_scan):
            with self.assertRaisesRegex(RuntimeError, "changed while preparing"):
                runtime.prepare(newer, self.data)
        self.assertEqual(b"concurrent user edit", target.read_bytes())
        self.assertFalse((self.data / "mods/new.jar").exists())

    def test_concurrent_new_jar_is_not_overwritten(self):
        runtime.prepare(self.source, self.data)
        newer = self.make_image("new", version="0.0.2", mod="new.jar")
        original_scan = runtime.scan_mods
        target = self.data / "mods/new.jar"
        def create_after_scan(root, allowed):
            original_scan(root, allowed)
            if root == self.data:
                target.write_bytes(b"concurrent user jar")
        with mock.patch.object(runtime, "scan_mods", side_effect=create_after_scan):
            with self.assertRaisesRegex(ValueError, "Unmanaged file appeared"):
                runtime.prepare(newer, self.data)
        self.assertEqual(b"concurrent user jar", target.read_bytes())

    def test_minecraft_version_change_requires_opt_in(self):
        runtime.prepare(self.source, self.data)
        newer = self.make_image("new", game="26.4", version="0.0.2", mod="new.jar")
        before = self.snapshot()
        with self.assertRaisesRegex(ValueError, "ALLOW_MINECRAFT_VERSION_CHANGE"):
            runtime.prepare(newer, self.data)
        self.assertEqual(before, self.snapshot())
        runtime.prepare(newer, self.data, allow_version_change=True)
        self.assertEqual("26.4", json.loads((self.data / runtime.MANIFEST).read_bytes())["minecraft"])

    def test_legacy_zip_version_change_requires_opt_in(self):
        self.data.mkdir()
        (self.data / "pack.lock.json").write_text('{"minecraft":"1.21.11"}')
        with self.assertRaisesRegex(ValueError, "ALLOW_MINECRAFT_VERSION_CHANGE"):
            runtime.prepare(self.source, self.data)

    def test_symlinks_and_traversal_are_rejected(self):
        (self.data / "mods").mkdir(parents=True)
        external = self.root / "outside.jar"
        external.write_bytes(b"never modify")
        (self.data / "mods/old.jar").symlink_to(external)
        with self.assertRaisesRegex(ValueError, "Symlink"):
            runtime.prepare(self.source, self.data)
        self.assertEqual(b"never modify", external.read_bytes())
        for name in ("../world/level.dat", "/tmp/file", "mods/../../file", "mods\\file.jar"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                runtime.managed_name(name)

    def test_lock_is_exclusive_and_descriptor_survives_exec(self):
        child = None
        try:
            with runtime.runtime_lock(self.data) as descriptor:
                self.assertTrue(os.get_inheritable(descriptor))
                with self.assertRaisesRegex(RuntimeError, "already owns"):
                    with runtime.runtime_lock(self.data):
                        pass
                child = subprocess.Popen([sys.executable, "-B", "-c", "import sys; sys.stdin.read()"],
                                         stdin=subprocess.PIPE, pass_fds=(descriptor,))
            with self.assertRaisesRegex(RuntimeError, "already owns"):
                with runtime.runtime_lock(self.data):
                    pass
            child.communicate(timeout=5)
            with runtime.runtime_lock(self.data):
                pass
        finally:
            if child is not None and child.poll() is None:
                child.kill()
                child.communicate(timeout=5)

    def test_failed_upgrade_rolls_back_files_and_manifest(self):
        runtime.prepare(self.source, self.data)
        before = self.snapshot()
        newer = self.make_image("new", version="0.0.2", mod="new.jar")
        original_write = runtime.atomic_write
        failed = False
        def failing_write(path, content, *args, **kwargs):
            nonlocal failed
            if Path(path) == self.data / "mods/new.jar" and not failed:
                failed = True
                raise OSError("injected disk failure")
            return original_write(path, content, *args, **kwargs)
        with mock.patch.object(runtime, "atomic_write", side_effect=failing_write):
            with self.assertRaisesRegex(OSError, "injected disk failure"):
                runtime.prepare(newer, self.data)
        self.assertTrue(failed)
        self.assertEqual(before, self.snapshot())

    def test_interrupted_upgrade_is_recovered_on_next_prepare(self):
        runtime.prepare(self.source, self.data)
        before = self.snapshot()
        newer = self.make_image("new", version="0.0.2", mod="new.jar")
        original_write = runtime.atomic_write
        def interrupted_write(path, content, *args, **kwargs):
            if Path(path) == self.data / "mods/new.jar":
                raise KeyboardInterrupt("simulated process termination")
            return original_write(path, content, *args, **kwargs)
        with mock.patch.object(runtime, "atomic_write", side_effect=interrupted_write):
            with self.assertRaises(KeyboardInterrupt):
                runtime.prepare(newer, self.data)
        self.assertTrue((self.data / runtime.JOURNAL).exists())
        runtime.prepare(self.source, self.data)
        self.assertEqual(before, self.snapshot())

    def test_prepare_ignores_eula_opt_in_and_run_decisions_are_explicit(self):
        with mock.patch.dict(os.environ, {"EULA": "true"}):
            runtime.prepare(self.source, self.data)
        self.assertEqual("false", runtime.properties((self.data / "eula.txt").read_bytes())["eula"])
        with self.assertRaisesRegex(ValueError, "not accepted"):
            runtime.require_eula(self.data, {})
        # Synthetic reads only: no test accepts the EULA on disk.
        with mock.patch.object(runtime, "read_optional", return_value=b"eula=true\n"), \
                mock.patch.object(runtime, "atomic_write") as write:
            runtime.require_eula(self.data, {})
            with self.assertRaisesRegex(ValueError, "explicitly disabled"):
                runtime.require_eula(self.data, {"EULA": "false"})
            write.assert_not_called()
        with mock.patch.object(runtime, "read_optional", return_value=b"eula=false\n"), \
                mock.patch.object(runtime, "atomic_write") as write:
            runtime.require_eula(self.data, {"EULA": "true"})
            self.assertIn(b"eula=true", write.call_args.args[1])

    def test_run_executes_java_from_data_while_holding_lock(self):
        class ExecObserved(Exception):
            pass
        previous_directory = Path.cwd()
        (self.root / "backups").mkdir()
        command = ["/fake/java", "-Xms1G", "-Xmx4G", "-jar", "fabric-server-launch.jar", "nogui"]
        def observe(executable, arguments, environment):
            self.assertEqual(self.data, Path.cwd())
            self.assertEqual(command, arguments)
            self.assertEqual(command[0], executable)
            with self.assertRaisesRegex(RuntimeError, "already owns"):
                with runtime.runtime_lock(self.data):
                    pass
            raise ExecObserved()
        try:
            with mock.patch.dict(os.environ, {"MVS_SERVER_DIR": str(self.source), "MVS_DATA_DIR": str(self.data)}), \
                    mock.patch.object(runtime, "java_command", return_value=command), \
                    mock.patch.object(runtime, "require_eula"), \
                    mock.patch.object(runtime, "initialize_fastback") as initialize, \
                    mock.patch.object(runtime.os, "execvpe", side_effect=observe):
                with self.assertRaises(ExecObserved):
                    runtime.main(["run"])
                initialize.assert_called_once_with(self.source, self.data, self.root / "backups")
        finally:
            os.chdir(previous_directory)
        self.assertEqual("false", runtime.properties((self.data / "eula.txt").read_bytes())["eula"])

    def test_missing_backup_directory_stops_before_java_or_eula_changes(self):
        with mock.patch.dict(os.environ, {"MVS_SERVER_DIR": str(self.source), "MVS_DATA_DIR": str(self.data)}), \
                mock.patch.object(runtime, "java_command") as java, \
                mock.patch.object(runtime, "require_eula") as eula:
            with self.assertRaisesRegex(ValueError, "Automatic backup directory is missing"):
                runtime.main(["run"])
            java.assert_not_called()
            eula.assert_not_called()
        self.assertFalse((self.root / "backups").exists())
        self.assertFalse((self.data / "world").exists())
        self.assertEqual("false", runtime.properties((self.data / "eula.txt").read_bytes())["eula"])

    def test_prepare_command_does_not_require_or_create_backup_mount(self):
        with mock.patch.dict(os.environ, {"MVS_SERVER_DIR": str(self.source), "MVS_DATA_DIR": str(self.data)}), \
                mock.patch.object(runtime, "check_backup_directory") as preflight, \
                mock.patch.object(runtime, "initialize_fastback") as initialize:
            runtime.main(["prepare"])
            preflight.assert_not_called()
            initialize.assert_not_called()
        self.assertFalse((self.root / "backups").exists())
        self.assertFalse((self.data / "world").exists())

    def test_run_without_fastback_never_touches_backup_mount_or_git_helper(self):
        source = self.make_image("minimal", voice=False, fastback=False)
        # An irrelevant backup path must not become a dependency for this pack.
        (self.root / "backups").symlink_to(self.root / "missing-backup-location")
        previous_directory = Path.cwd()
        try:
            with mock.patch.dict(os.environ, {"MVS_SERVER_DIR": str(source), "MVS_DATA_DIR": str(self.data)}), \
                    mock.patch.object(runtime, "java_command", return_value=["/fake/java"]), \
                    mock.patch.object(runtime, "require_eula"), \
                    mock.patch.object(runtime, "check_backup_directory") as check, \
                    mock.patch.object(runtime, "initialize_fastback") as initialize, \
                    mock.patch.object(runtime.os, "execvpe", side_effect=RuntimeError("executed Java")):
                with self.assertRaisesRegex(RuntimeError, "executed Java"):
                    runtime.main(["run"])
                check.assert_not_called()
                initialize.assert_not_called()
        finally:
            os.chdir(previous_directory)
        self.assertFalse((self.root / "backups").exists())

    def test_fastback_initialization_requires_explicit_eula(self):
        (self.root / "backups").mkdir()
        with mock.patch.dict(os.environ, {"MVS_SERVER_DIR": str(self.source), "MVS_DATA_DIR": str(self.data), "EULA": "false"}), \
                mock.patch.object(runtime, "java_command", return_value=["/fake/java"]), \
                mock.patch.object(runtime, "initialize_fastback") as initialize:
            with self.assertRaisesRegex(ValueError, "explicitly disabled"):
                runtime.main(["run"])
            initialize.assert_not_called()
        self.assertFalse((self.data / "world").exists())
        self.assertEqual("false", runtime.properties((self.data / "eula.txt").read_bytes())["eula"])

    def test_fastback_helper_uses_image_source_and_explicit_paths(self):
        helper = self.source / "fastback.py"
        helper.write_text("# fixture\n")
        with mock.patch.object(runtime.subprocess, "run") as run:
            runtime.initialize_fastback(self.source, self.data, self.root / "backups")
        run.assert_called_once_with([sys.executable, str(helper), "init", "--data-dir", str(self.data),
                                     "--backup-dir", str(self.root / "backups")], check=True)

    def test_jvm_memory_defaults_and_validation(self):
        result = subprocess.CompletedProcess([], 0, stdout="", stderr="java.specification.version = 25\n")
        with mock.patch.object(runtime.subprocess, "run", return_value=result), \
                mock.patch.object(runtime.shutil, "which", return_value="/java/bin/java"):
            command = runtime.java_command({"java": 25}, {})
            self.assertEqual(["-Xms1G", "-Xmx4G"], command[1:3])
            with self.assertRaisesRegex(ValueError, "exceeds"):
                runtime.java_command({"java": 25}, {"MC_MIN_MEMORY": "5G", "MC_MAX_MEMORY": "4G"})


class RconTests(unittest.TestCase):
    def test_password_alone_does_not_enable_rcon(self):
        settings = runtime.rcon_settings({"MC_RCON_PASSWORD": "a-secret"})
        self.assertEqual("false", settings["enable-rcon"])
        self.assertEqual("", settings["rcon.password"])

    def test_explicit_enable_requires_password_and_valid_port(self):
        for values in ({"MC_RCON_ENABLED": "yes"}, {"MC_RCON_ENABLED": "true"},
                       {"MC_RCON_ENABLED": "true", "MC_RCON_PASSWORD": "secret\nenable-query=true"},
                       {"MC_RCON_ENABLED": "true", "MC_RCON_PASSWORD": "ok", "MC_RCON_PORT": "65536"}):
            with self.subTest(values=values), self.assertRaises(ValueError):
                runtime.rcon_settings(values)
        settings = runtime.rcon_settings({"MC_RCON_ENABLED": "true", "MC_RCON_PASSWORD": "strong password\\suffix", "MC_RCON_PORT": "25576"})
        self.assertEqual("true", settings["enable-rcon"])
        self.assertEqual("25576", settings["rcon.port"])
        self.assertEqual("strong\\ password\\\\suffix", settings["rcon.password"])

    def test_configuration_preserves_world_and_operator_properties_and_can_disable(self):
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder).resolve()
            target = data / "server.properties"
            preserved = "# Personal settings\nmotd=My World\nlevel-name=my-world\nonline-mode=true\n"
            target.write_text(preserved + "enable-rcon=false\n")
            settings = runtime.rcon_settings({"MC_RCON_ENABLED": "true", "MC_RCON_PASSWORD": "secret"})
            runtime.configure_rcon(data, settings)
            self.assertTrue(target.read_text().startswith(preserved))
            self.assertEqual(0o600, target.stat().st_mode & 0o777)
            with mock.patch.object(runtime, "atomic_write", side_effect=AssertionError("Unexpected rewrite")):
                runtime.configure_rcon(data, settings)
            runtime.configure_rcon(data, runtime.rcon_settings({}))
            result = runtime.properties(target.read_bytes())
            self.assertEqual("false", result["enable-rcon"])
            self.assertEqual("", result["rcon.password"])
            self.assertEqual("my-world", result["level-name"])
            self.assertNotIn("secret", target.read_text())


class ServiceProxyTests(unittest.TestCase):
    def test_unset_or_empty_proxy_keeps_official_defaults(self):
        self.assertEqual([], runtime.service_proxy_arguments({}))
        self.assertEqual([], runtime.service_proxy_arguments({"MC_SERVICE_PROXY_URL": ""}))

    def test_https_proxy_sets_each_service_host_before_jar(self):
        result = subprocess.CompletedProcess([], 0, stdout="", stderr="java.specification.version = 25\n")
        with mock.patch.object(runtime.subprocess, "run", return_value=result), \
                mock.patch.object(runtime.shutil, "which", return_value="/java/bin/java"):
            command = runtime.java_command({"java": 25}, {
                "MC_SERVICE_PROXY_URL": "https://minecraft.example.com/mc-proxy///"})
        expected = ["-Dminecraft.api.discovery.host=https://minecraft.example.com/mc-proxy/discovery/minecraft/client",
                    *(f"-Dminecraft.api.{service}.host=https://minecraft.example.com/mc-proxy/{service}"
                      for service in ("auth", "account", "session", "services", "profiles"))]
        self.assertEqual(["/java/bin/java", "-Xms1G", "-Xmx4G", *expected,
                          "-jar", "fabric-server-launch.jar", "nogui"], command)

    def test_valid_https_hosts_ports_and_base_paths(self):
        for base in ("https://proxy.example.com", "https://proxy.example.com:8443/mc-proxy",
                     "https://127.0.0.1:443/mc-proxy", "https://[2001:db8::1]:443/mc-proxy"):
            with self.subTest(base=base):
                self.assertIn(f"-Dminecraft.api.session.host={base}/session",
                              runtime.service_proxy_arguments({"MC_SERVICE_PROXY_URL": base}))

    def test_invalid_proxy_urls_fail_without_exposing_the_value(self):
        for base in ("http://proxy.example.com", "proxy.example.com", "https:///mc-proxy",
                     "https://user:secret@proxy.example.com/mc-proxy",
                     "https://@proxy.example.com/mc-proxy", "https://proxy.example.com?",
                     "https://proxy.example.com?token=secret", "https://proxy.example.com#fragment",
                     " https://proxy.example.com", "https://proxy.example.com/path with spaces",
                     "https://proxy.example.com/\n", "https://proxy.example.com/\t",
                     "https://proxy.example.com/\x00", "https://proxy.example.com/\x7f",
                     "https://proxy.example.com\\evil", "https://proxy.example.com:",
                     "https://proxy.example.com:0", "https://proxy.example.com:65536",
                     "https://proxy.example.com:port", "https://-bad.example.com",
                     "https://bad-.example.com", "https://bad..example.com",
                     "https://bad_host.example.com", "https://999.0.0.1", "https://127.0.0",
                     "https://[::1", "https://[::1]extra", "https://[::1]:443:80",
                     "https://[fe80::1%25eth0]", "https://proxy.example.com/%ZZ"):
            with self.subTest(base=base), self.assertRaisesRegex(ValueError, "Invalid MC_SERVICE_PROXY_URL") as raised:
                runtime.service_proxy_arguments({"MC_SERVICE_PROXY_URL": base})
            self.assertNotIn(base, str(raised.exception))


class BackupDirectoryTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="mvs-backup-dir-test-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        self.data = self.root / "data"
        self.data.mkdir()
        self.backups = self.root / "backups"
        self.backups.mkdir()

    def test_writable_directory_keeps_existing_backups_and_leaves_no_probe(self):
        existing = self.backups / "full.zip"
        existing.write_bytes(b"existing backup fixture")
        runtime.check_backup_directory(self.data / "../backups", self.data)
        self.assertEqual([existing], list(self.backups.iterdir()))
        self.assertEqual(b"existing backup fixture", existing.read_bytes())

    def test_missing_file_symlink_or_nested_destination_is_rejected(self):
        wrong_file = self.root / "file"
        wrong_file.write_text("keep")
        alias = self.root / "alias"
        alias.symlink_to(self.backups)
        nested = self.data / "world/backups"
        nested.mkdir(parents=True)
        for path in (self.root / "missing", wrong_file, alias, self.data, nested):
            with self.subTest(path=path), self.assertRaises(ValueError):
                runtime.check_backup_directory(path, self.data)
        self.assertFalse((self.root / "missing").exists())
        self.assertEqual("keep", wrong_file.read_text())

    def test_failed_write_reports_permissions_and_preserves_existing_backup(self):
        existing = self.backups / "full.zip"
        existing.write_bytes(b"existing backup fixture")
        with mock.patch.object(runtime.tempfile, "NamedTemporaryFile", side_effect=PermissionError("read-only mount")):
            with self.assertRaisesRegex(RuntimeError, "not writable by UID:GID"):
                runtime.check_backup_directory(self.backups, self.data)
        self.assertEqual(b"existing backup fixture", existing.read_bytes())


class HealthcheckTests(unittest.TestCase):
    @contextmanager
    def server(self, response):
        errors = []
        listener = socket.socket()
        try:
            listener.bind(("127.0.0.1", 0))
            listener.listen(1)
            listener.settimeout(5)
        except BaseException:
            listener.close()
            raise
        port = listener.getsockname()[1]
        def receive(connection, count):
            result = b""
            while len(result) < count:
                part = connection.recv(count - len(result))
                if not part:
                    raise AssertionError("client closed before sending the request")
                result += part
            return result
        def serve():
            try:
                with listener.accept()[0] as connection:
                    connection.settimeout(5)
                    count = receive(connection, 1)[0]
                    handshake = receive(connection, count)
                    expected = b"\x00\xff\xff\xff\xff\x0f\x09" + b"127.0.0.1" + struct.pack(">H", port) + b"\x01"
                    self.assertEqual(expected, handshake)
                    self.assertEqual(b"\x01\x00", receive(connection, 2))
                    connection.sendall(response)
            except BaseException as error:
                errors.append(error)
        worker = threading.Thread(target=serve, daemon=True)
        worker.start()
        try:
            yield port
        finally:
            worker.join(timeout=6)
            listener.close()
            self.assertFalse(worker.is_alive(), "loopback server thread did not finish")
            if errors:
                raise errors[0]

    def test_protocol_status_works_without_rcon(self):
        document = b'{"version":{"name":"26.3"},"players":{"online":0}}'
        payload = b"\x00" + bytes([len(document)]) + document
        with self.server(bytes([len(payload)]) + payload) as port:
            response = runtime.status_ping(port)
        self.assertEqual(0, response["players"]["online"])

    def test_malformed_or_oversized_responses_fail(self):
        for response in (b"\x03\x00\x01x", b"\xff\xff\xff\xff\x7f"):
            with self.subTest(response=response), self.server(response) as port:
                with self.assertRaises(ValueError):
                    runtime.status_ping(port)

    def test_healthcheck_reads_configured_port_and_does_not_need_rcon(self):
        with tempfile.TemporaryDirectory(prefix="mvs-health-test-") as directory:
            data = Path(directory).resolve()
            (data / "server.properties").write_text("server-port=25580\nenable-rcon=false\nenable-query=false\n")
            with mock.patch.object(runtime, "status_ping") as ping:
                runtime.healthcheck(data)
                ping.assert_called_once_with(25580)


if __name__ == "__main__":
    unittest.main(verbosity=2)
