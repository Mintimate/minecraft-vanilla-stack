#!/usr/bin/env python3
"""FastBack initialization/export with temporary worlds and real local Git/LFS."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
import zlib

spec = importlib.util.spec_from_file_location("mvs_fastback", Path(__file__).resolve().parents[1] / "templates/server/fastback.py")
fastback = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fastback)


def git_lfs_available():
    if not shutil.which("git"):
        return False
    return subprocess.run(["git", "lfs", "version"], capture_output=True).returncode == 0


class SnapshotPathTests(unittest.TestCase):
    def test_portable_paths_reject_devices_and_keep_fastback_metadata(self):
        for name in ("/outside", "../outside", ".git/config", "region/CON", "region/nul.dat", "COM1.txt",
                     "data/file.", "data/file ", "data/../outside", "data\\outside"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                fastback.safe_entry(name)
        for name in (".gitignore", ".gitattributes", ".fastback/world-id", "region/r.0.0.mca"):
            self.assertEqual(name, str(fastback.safe_entry(name)))

    def test_allowlist_rejects_line_breaks_before_accessing_files(self):
        for name in ("bad\npath", "bad\rpath"):
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "line breaks"):
                fastback.allow_repository_symlink(Path("/data"), Path("/data/world"),
                                                  Path("/backups") / name, Path("/data/.mvs/fastback"))


@unittest.skipUnless(git_lfs_available(), "real Git and Git LFS are required")
class FastBackTests(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory(prefix="mvs-fastback-test-")
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name).resolve()
        self.data = self.root / "data"
        self.data.mkdir()
        (self.data / "server.properties").write_text("level-name=world\n")
        self.backups = self.root / "backups"
        self.backups.mkdir()
        self.world = self.data / "world"
        self.repo = self.backups / "repos/world.git"

    def init(self, **kwargs):
        return fastback.initialize(self.data, self.backups, **kwargs)

    @staticmethod
    def files(folder):
        return {p.relative_to(folder).as_posix(): p.read_bytes() for p in folder.rglob("*") if p.is_file() and not p.is_symlink()}

    def snapshot(self):
        result = self.init()
        (self.world / "level.dat").write_bytes(b"level data fixture\x00" * 300)
        (self.world / "region").mkdir()
        (self.world / "region/r.0.0.mca").write_bytes(b"region fixture\x00" * 500)
        (self.world / "notes.txt").write_text("ordinary non-LFS blob\n")
        (self.world / ".gitattributes").write_text("*.dat filter=lfs diff=lfs merge=lfs -text\n*.mca filter=lfs diff=lfs merge=lfs -text\n")
        fastback.git(["add", "--all"], self.repo)
        fastback.git(["commit", "-m", "synthetic snapshot"], self.repo)
        branch = result["world_id"] + "/2026-10-06_12-34-56"
        fastback.git(["branch", branch], self.repo)
        pointer = fastback.git(["show", branch + ":level.dat"], self.repo)
        self.assertTrue(pointer.startswith(fastback.LFS_HEADER))
        return branch

    def test_initialization_preserves_world_and_repeat_preserves_config_refs(self):
        self.world.mkdir()
        (self.world / "level.dat").write_bytes(b"existing world")
        (self.world / ".fastback").mkdir()
        (self.world / ".fastback/world-id").write_text("AbCD\n")
        first = self.init()
        self.assertEqual("AbCD", first["world_id"])
        self.assertTrue((self.world / ".git").is_symlink())
        self.assertEqual(self.repo, (self.world / ".git").resolve())
        self.assertEqual(b"existing world", (self.world / "level.dat").read_bytes())
        for key, value in {"fastback.autoback-action": "full-gc", "fastback.autoback-wait": "60",
                           "fastback.retention-policy": "fixed count=24", "fastback.shutdown-action": "local",
                           "fastback.native-git-enabled": "true", "lfs.storage": "lfs"}.items():
            self.assertEqual(value, fastback.local_config(self.repo, key))
        fastback.git(["config", "fastback.autoback-wait", "90"], self.repo)
        before = self.files(self.repo)
        self.assertFalse(self.init()["changed"])
        self.assertEqual(before, self.files(self.repo))
        self.assertEqual("90", fastback.local_config(self.repo, "fastback.autoback-wait"))
        self.assertFalse((self.data / "eula.txt").exists())

    def test_new_world_only_has_backup_metadata_not_minecraft_save(self):
        result = self.init()
        self.assertRegex(result["world_id"], r"^[1-9A-HJ-NP-Za-km-z]{4}$")
        self.assertFalse((self.world / "level.dat").exists())
        self.assertFalse((self.data / "eula.txt").exists())

    def test_new_initialization_adds_only_the_exact_repository_permission(self):
        self.init()
        expected = (r"[regex]^\Q" + str(self.repo) + "\\E$\n").encode()
        self.assertEqual(expected, (self.data / "allowed_symlinks.txt").read_bytes())
        self.assertNotIn(b"[prefix]", expected)
        self.assertNotIn(b".*", expected)

    def test_old_ready_state_repairs_missing_allowlist_and_repeat_is_noop(self):
        self.init()
        permission = self.data / "allowed_symlinks.txt"
        expected = permission.read_bytes()
        permission.unlink()
        before_repo = self.files(self.repo)
        before_state = (self.data / ".mvs/fastback/world.json").read_bytes()
        self.assertTrue(self.init()["changed"])
        self.assertEqual(expected, permission.read_bytes())
        self.assertEqual(before_repo, self.files(self.repo))
        self.assertEqual(before_state, (self.data / ".mvs/fastback/world.json").read_bytes())
        stamp = permission.stat().st_mtime_ns
        self.assertFalse(self.init()["changed"])
        self.assertEqual(stamp, permission.stat().st_mtime_ns)

    def test_allowlist_preserves_existing_bytes_rules_and_permissions(self):
        permission = self.data / "allowed_symlinks.txt"
        original = b"# operator rules\r\n[regex]^/operator/only$\r\n# no ending newline"
        permission.write_bytes(original)
        permission.chmod(0o640)
        self.init()
        expected = original + b"\n" + (r"[regex]^\Q" + str(self.repo) + "\\E$\n").encode()
        self.assertEqual(expected, permission.read_bytes())
        self.assertEqual(0o640, permission.stat().st_mode & 0o777)

    def test_allowlist_quotes_regex_characters_and_literal_quote_terminator(self):
        special = self.root / r"backup.[literal]+\E-tail"
        self.backups.rename(special)
        self.backups = special
        self.repo = self.backups / "repos/world.git"
        self.init()
        expected = (r"[regex]^\Q" + str(self.repo).replace(r"\E", r"\E\\E\Q") + "\\E$\n").encode()
        self.assertEqual(expected, (self.data / "allowed_symlinks.txt").read_bytes())

    def test_allowlist_symlink_directory_and_readonly_file_are_rejected(self):
        self.init()
        permission = self.data / "allowed_symlinks.txt"
        permission.unlink()
        before_repo = self.files(self.repo)
        outside = self.root / "operator-allowlist.txt"
        outside.write_bytes(b"keep operator rules\n")
        permission.symlink_to(outside)
        with self.assertRaisesRegex(ValueError, "symbolic link"):
            self.init()
        self.assertEqual(b"keep operator rules\n", outside.read_bytes())
        permission.unlink()
        permission.mkdir()
        with self.assertRaises(ValueError):
            self.init()
        permission.rmdir()
        permission.write_bytes(b"read only operator rules\n")
        permission.chmod(0o444)
        with self.assertRaisesRegex(PermissionError, "read-only"):
            self.init()
        self.assertEqual(b"read only operator rules\n", permission.read_bytes())
        self.assertEqual(0o444, permission.stat().st_mode & 0o777)
        self.assertEqual(before_repo, self.files(self.repo))

    def test_allowlist_write_failure_keeps_existing_rules_world_and_repo(self):
        self.init()
        (self.world / "level.dat").write_bytes(b"preserve existing world")
        permission = self.data / "allowed_symlinks.txt"
        permission.write_bytes(b"# preserve operator rules\n")
        before_repo = self.files(self.repo)
        replace = fastback.os.replace
        def fail_allowlist(source, target):
            if target == permission:
                raise PermissionError("read-only mount fixture")
            return replace(source, target)
        with mock.patch.object(fastback.os, "replace", side_effect=fail_allowlist):
            with self.assertRaisesRegex(PermissionError, "read-only mount"):
                self.init()
        self.assertEqual(b"# preserve operator rules\n", permission.read_bytes())
        self.assertEqual(b"preserve existing world", (self.world / "level.dat").read_bytes())
        self.assertEqual(before_repo, self.files(self.repo))
        self.assertFalse(list(self.data.glob(".fastback-state-*")))

    def test_two_world_initializations_preserve_both_exact_permissions(self):
        processes = [subprocess.Popen([sys.executable, "-B", str(Path(fastback.__file__)), "init",
                                       "--data-dir", str(self.data), "--backup-dir", str(self.backups), "--world", name],
                                      stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                     for name in ("world-one", "world-two")]
        for process in processes:
            stdout, stderr = process.communicate(timeout=30)
            self.assertEqual(0, process.returncode, stdout + stderr)
        rules = (self.data / "allowed_symlinks.txt").read_bytes().splitlines()
        expected = [(r"[regex]^\Q" + str(self.backups / "repos" / (name + ".git")) + r"\E$").encode()
                    for name in ("world-one", "world-two")]
        self.assertCountEqual(expected, rules)

    def test_world_name_changes_use_separate_repositories(self):
        first = self.init()
        (self.data / "server.properties").write_text("level-name=another-world\n")
        second = self.init()
        self.assertNotEqual(first["repository"], second["repository"])
        self.assertTrue(self.repo.is_dir())
        self.assertTrue((self.backups / "repos/another-world.git").is_dir())

    def test_unknown_git_directory_file_and_external_repo_are_rejected(self):
        self.world.mkdir()
        dot_git = self.world / ".git"
        dot_git.mkdir()
        with self.assertRaisesRegex(ValueError, "Existing world .git"):
            self.init()
        dot_git.rmdir()
        dot_git.write_text("gitdir: somewhere\n")
        with self.assertRaisesRegex(ValueError, "Existing world .git"):
            self.init()
        dot_git.unlink()
        self.repo.mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, "Existing external repository"):
            self.init()
        self.assertEqual([], list(self.repo.iterdir()))
        self.assertFalse((self.data / "allowed_symlinks.txt").exists())

    def test_missing_backup_mount_never_replaces_existing_history(self):
        self.init()
        self.backups.rename(self.root / "saved-backups")
        with self.assertRaisesRegex(ValueError, "Backup directory is missing"):
            self.init()
        self.backups.mkdir()
        with self.assertRaisesRegex(ValueError, "target is missing"):
            self.init()
        self.assertFalse((self.backups / "repos").exists())

    def test_interrupted_staging_is_resumed_without_changing_world_identity(self):
        with mock.patch.object(fastback.os, "rename", side_effect=OSError("injected interruption")):
            with self.assertRaisesRegex(OSError, "injected interruption"):
                self.init()
        state = json.loads((self.data / ".mvs/fastback/world.json").read_text())
        self.assertFalse((self.world / ".git").exists())
        result = self.init()
        self.assertEqual(state["world_id"], result["world_id"])
        self.assertEqual("ready", json.loads((self.data / ".mvs/fastback/world.json").read_text())["phase"])

    def test_interrupted_final_marker_is_resumed(self):
        original = fastback.write_json
        def interrupted(path, value, **kwargs):
            if value.get("phase") == "ready":
                raise OSError("injected marker failure")
            original(path, value, **kwargs)
        with mock.patch.object(fastback, "write_json", side_effect=interrupted):
            with self.assertRaisesRegex(OSError, "injected marker failure"):
                self.init()
        repo_before = self.files(self.repo)
        self.init()
        self.assertEqual(repo_before, self.files(self.repo))

    def test_export_materializes_real_lfs_objects_without_source_world_or_mutation(self):
        branch = self.snapshot()
        original = self.files(self.world)
        self.world.rename(self.data / "offline-world")
        before = self.files(self.repo)
        result = fastback.export_snapshot(self.backups, "world", branch)
        target = Path(result["target"])
        self.assertEqual(2, result["lfs_objects_verified"])
        self.assertFalse((target / ".git").exists())
        for name, data in original.items():
            self.assertEqual(data, (target / name).read_bytes(), name)
        self.assertEqual(before, self.files(self.repo))
        self.assertEqual([branch], fastback.list_snapshots(self.backups, "world"))

    def test_missing_lfs_object_fails_without_publishing_restore(self):
        branch = self.snapshot()
        pointer = fastback.git(["show", branch + ":level.dat"], self.repo)
        oid = fastback.LFS_POINTER.fullmatch(pointer)[1].decode()
        obj = self.repo / "lfs/objects" / oid[:2] / oid[2:4] / oid
        obj.unlink()
        target = self.root / "restore"
        with self.assertRaisesRegex(ValueError, "Required file is missing"):
            fastback.export_snapshot(self.backups, "world", branch, target)
        self.assertFalse(target.exists())
        self.assertFalse(list(self.root.glob(".fastback-export-*")))

    def test_modified_lfs_object_fails_hash_check(self):
        branch = self.snapshot()
        pointer = fastback.git(["show", branch + ":level.dat"], self.repo)
        oid = fastback.LFS_POINTER.fullmatch(pointer)[1].decode()
        obj = self.repo / "lfs/objects" / oid[:2] / oid[2:4] / oid
        obj.write_bytes(b"x" * obj.stat().st_size)
        with self.assertRaisesRegex(ValueError, "LFS object hash mismatch"):
            fastback.export_snapshot(self.backups, "world", branch, self.root / "restore")
        self.assertFalse((self.root / "restore").exists())

    def test_corrupt_loose_git_blob_is_rejected_by_content_hash(self):
        branch = self.snapshot()
        oid = fastback.git(["rev-parse", branch + ":notes.txt"], self.repo).decode().strip()
        loose = self.repo / "objects" / oid[:2] / oid[2:]
        header, data = zlib.decompress(loose.read_bytes()).split(b"\0", 1)
        changed = b"X" + data[1:]
        loose.chmod(0o600)
        loose.write_bytes(zlib.compress(header + b"\0" + changed))
        # cat-file still returns bytes under the requested object name.
        self.assertEqual(changed, fastback.git(["cat-file", "blob", oid], self.repo))
        with self.assertRaisesRegex(ValueError, "Git blob hash mismatch"):
            fastback.export_snapshot(self.backups, "world", branch, self.root / "restore")
        self.assertFalse((self.root / "restore").exists())

    def test_source_hooks_and_filters_are_not_executed_during_export(self):
        branch = self.snapshot()
        signal = self.root / "executed"
        evil = self.root / "hook"
        evil.write_text("#!/bin/sh\ntouch '" + str(signal) + "'\n")
        evil.chmod(0o755)
        hooks = self.root / "hooks"
        hooks.mkdir()
        shutil.copyfile(evil, hooks / "post-checkout")
        (hooks / "post-checkout").chmod(0o755)
        fastback.git(["config", "core.hooksPath", str(hooks)], self.repo)
        fastback.git(["config", "filter.lfs.smudge", str(evil)], self.repo)
        fastback.git(["config", "filter.lfs.process", str(evil)], self.repo)
        fastback.export_snapshot(self.backups, "world", branch, self.root / "restore")
        self.assertFalse(signal.exists())

    def test_snapshot_symlinks_are_rejected_without_following_them(self):
        branch = self.snapshot()
        outside = self.root / "private.txt"
        outside.write_text("must not export")
        (self.world / "outside").symlink_to(outside)
        fastback.git(["add", "outside"], self.repo)
        fastback.git(["commit", "-m", "symlink fixture"], self.repo)
        fastback.git(["branch", "-f", branch], self.repo)
        with self.assertRaisesRegex(ValueError, "symlink or submodule"):
            fastback.export_snapshot(self.backups, "world", branch, self.root / "restore")
        self.assertFalse((self.root / "restore").exists())

    def test_export_rejects_other_refs_original_world_and_nonempty_target(self):
        branch = self.snapshot()
        target = self.root / "restore"
        target.mkdir()
        (target / "keep.txt").write_text("keep")
        for destination in (target, self.world, self.world / "nested", self.repo):
            with self.subTest(destination=destination), self.assertRaises(ValueError):
                fastback.export_snapshot(self.backups, "world", branch, destination)
        for name in ("main", "refs/heads/" + branch, "ZZZZ/2026-10-06_12-34-56", "../main"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                fastback.export_snapshot(self.backups, "world", name)
        self.assertEqual("keep", (target / "keep.txt").read_text())

    def test_explicit_attach_restored_world_preserves_history_and_other_config(self):
        branch = self.snapshot()
        restored = Path(fastback.export_snapshot(self.backups, "world", branch)["target"])
        new_data = self.root / "recovered-data"
        new_data.mkdir()
        (new_data / "server.properties").write_text("level-name=world\n")
        shutil.move(str(restored), new_data / "world")
        fastback.git(["config", "fastback.autoback-wait", "95"], self.repo)
        refs = fastback.git(["show-ref"], self.repo)
        with self.assertRaisesRegex(ValueError, "Existing external repository"):
            fastback.initialize(new_data, self.backups)
        fastback.initialize(new_data, self.backups, attach_existing=True)
        self.assertEqual(refs, fastback.git(["show-ref"], self.repo))
        self.assertEqual("95", fastback.local_config(self.repo, "fastback.autoback-wait"))
        self.assertEqual(str(new_data / "world"), fastback.local_config(self.repo, "core.worktree"))
        self.assertEqual(self.repo, (new_data / "world/.git").resolve())
        self.assertEqual((r"[regex]^\Q" + str(self.repo) + "\\E$\n").encode(),
                         (new_data / "allowed_symlinks.txt").read_bytes())
        self.assertFalse(fastback.initialize(new_data, self.backups)["changed"])

    def test_attach_rejects_unrelated_world_identity(self):
        self.init()
        new_data = self.root / "other-data"
        (new_data / "world/.fastback").mkdir(parents=True)
        (new_data / "server.properties").write_text("level-name=world\n")
        (new_data / "world/level.dat").write_bytes(b"other world")
        (new_data / "world/.fastback/world-id").write_text("ZZZZ\n")
        with self.assertRaisesRegex(ValueError, "does not match"):
            fastback.initialize(new_data, self.backups, attach_existing=True)
        self.assertFalse((new_data / "world/.git").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
