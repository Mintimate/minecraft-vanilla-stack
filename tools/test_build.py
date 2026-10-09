"""Exercise fixed-download packaging and protection of existing local outputs."""
import copy
import hashlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import yaml
import build


def jar(entries):
    data = io.BytesIO()
    with zipfile.ZipFile(data, "w") as archive:
        for name, value in entries.items():
            archive.writestr(name, value)
    return data.getvalue()


class BuildTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name).resolve()
        patcher = patch.object(build, "ROOT", self.root)
        patcher.start()
        self.addCleanup(patcher.stop)
        for folder in ("packs", ".cache/downloads", "templates/client", "templates/server"):
            (self.root / folder).mkdir(parents=True)
        for name in ("LICENSE", "THIRD_PARTY.md"):
            (self.root / name).write_text("Attribution\n")
        for side in ("client", "server"):
            (self.root / "templates" / side / "README.md").write_text("Java __JAVA_MAJOR__\n")
        server = self.root / "templates/server"
        (server / "start.sh").write_text("#!/bin/sh\njava -jar fabric-server-launch.jar\n")
        (server / "start.bat").write_text("java -jar fabric-server-launch.jar\n")
        (server / "eula.txt").write_text("eula=false\n")
        (self.root / "templates/client/options.txt").write_text("key_map:key.keyboard.j\n")
        launcher = jar({"install.properties": "game-version=26.3\nfabric-loader-version=0.19.5"})
        self.recipe = {"id": "fixture", "name": "Fixture", "version": "0.1.0", "minecraft": "26.3",
                       "java": 25, "fabric_loader": "0.19.5", "server_launcher": self.asset(launcher, "fabric-server-launch.jar"),
                       "mods": [], "resourcepacks": []}
        for name, sides, depends in (("fabric-api", ["client", "server"], {}),
                                     ("client-tool", ["client"], {"fabric-api": "*"}),
                                     ("server-tool", ["server"], {"fabric-api": "*", "mixinextras": "*"})):
            data = jar({"fabric.mod.json": json.dumps({"id": name, "environment": "*", "depends": depends})})
            self.recipe["mods"].append(dict(self.asset(data, name + ".jar"), id=name, sides=sides, license="MIT",
                                           requires=["fabric-api"] if depends else []))
        resource = jar({"pack.mcmeta": '{"pack":{"pack_format":1,"description":"Fixture"}}'})
        self.recipe["resourcepacks"] = [dict(self.asset(resource, "fixture.zip"), id="resource")]
        self.write_recipe()

    def asset(self, data, filename):
        digest = hashlib.sha512(data).hexdigest()
        (self.root / ".cache/downloads" / (digest + Path(filename).suffix)).write_bytes(data)
        return {"filename": filename, "sha512": digest, "url": "https://example.test/" + filename}

    def write_recipe(self):
        (self.root / "packs/fixture.yaml").write_text(yaml.safe_dump(self.recipe))

    def build(self, side="both"):
        build.build(build.load_pack("fixture"), side, offline=True)

    def dist(self):
        return self.root / "dist/fixture"

    def archive(self, side):
        return self.dist() / ("fixture-" + ("client-hmcl" if side == "client" else "server") + "-26.3-0.1.0"
                             + (".mrpack" if side == "client" else ".zip"))

    def test_only_two_formats_with_correct_sides_and_eula(self):
        self.build()
        self.assertEqual(len(list(self.dist().iterdir())), 3)
        with zipfile.ZipFile(self.archive("client")) as archive:
            index = json.loads(archive.read("modrinth.index.json"))
            self.assertEqual(index["files"], [])
            self.assertIn("overrides/mods/client-tool.jar", archive.namelist())
            self.assertNotIn("overrides/mods/server-tool.jar", archive.namelist())
            self.assertIn("overrides/resourcepacks/fixture.zip", archive.namelist())
            self.assertIn("overrides/THIRD_PARTY.md", archive.namelist())
            self.assertNotIn("overrides/options.txt", archive.namelist())
        with zipfile.ZipFile(self.archive("server")) as archive:
            self.assertEqual(archive.read("eula.txt"), b"eula=false\n")
            self.assertNotIn("mods/client-tool.jar", archive.namelist())
            metadata = json.loads(archive.read("pack.lock.json"))
            self.assertEqual(metadata["server_launcher"]["hashes"]["sha512"], self.recipe["server_launcher"]["sha512"])
            self.assertEqual(len(metadata["mods"]), 2)

    def test_side_rebuild_keeps_other_archive_and_complete_checksums(self):
        self.build()
        before = {path.name: path.read_bytes() for path in self.dist().iterdir()}
        self.build("client")
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.dist().iterdir()})
        self.assertEqual(len((self.dist() / "SHA256SUMS.txt").read_text().splitlines()), 2)

    def test_duplicate_yaml_and_dependency_side_mismatch_are_rejected(self):
        path = self.root / "packs/fixture.yaml"
        path.write_text(path.read_text() + "\nid: fixture\n")
        with self.assertRaises(ValueError):
            build.load_pack("fixture")
        self.recipe["mods"][0]["sides"] = ["client"]
        self.write_recipe()
        with self.assertRaisesRegex(ValueError, "Missing dependency"):
            build.load_pack("fixture")

    def test_unsafe_filename_url_and_hash_are_rejected(self):
        original = copy.deepcopy(self.recipe)
        for key, value in (("filename", "../escape.jar"), ("url", "http://example.test/mod.jar"), ("sha512", "abc")):
            self.recipe = copy.deepcopy(original)
            self.recipe["mods"][0][key] = value
            self.write_recipe()
            with self.assertRaises(ValueError):
                build.load_pack("fixture")

    def test_tampered_cache_does_not_replace_previous_outputs(self):
        self.build()
        before = self.archive("server").read_bytes()
        mod = self.recipe["mods"][0]
        (self.root / ".cache/downloads" / (mod["sha512"] + ".jar")).write_bytes(b"tampered")
        with self.assertRaisesRegex(ValueError, "SHA-512 mismatch"):
            self.build()
        self.assertEqual(self.archive("server").read_bytes(), before)

    def test_user_changes_and_unregistered_archives_are_preserved(self):
        self.build()
        folder = self.root / "build/fixture/server"
        (folder / "world").mkdir()
        (folder / "world/level.dat").write_bytes(b"World")
        with self.assertRaisesRegex(ValueError, "user changes"):
            self.build()
        self.assertEqual((folder / "world/level.dat").read_bytes(), b"World")
        import shutil
        shutil.rmtree(folder / "world")
        (self.dist() / "SHA256SUMS.txt").unlink()
        with self.assertRaisesRegex(ValueError, "Unmanaged distribution"):
            self.build()

    def test_second_side_failure_keeps_both_previous_outputs(self):
        self.build()
        before = build.snapshot(self.root / "build/fixture/client")
        original = build.assemble
        def fail(recipe, side, target, paths):
            if side == "server":
                raise ValueError("Assembly failed")
            return original(recipe, side, target, paths)
        with patch.object(build, "assemble", side_effect=fail), self.assertRaises(ValueError):
            self.build()
        self.assertEqual(build.snapshot(self.root / "build/fixture/client"), before)

    def test_launcher_version_mismatch_is_rejected(self):
        self.recipe["minecraft"] = "26.4"
        self.write_recipe()
        with self.assertRaisesRegex(ValueError, "launcher versions"):
            self.build("server")
        self.assertFalse((self.root / "build/fixture").exists())

    def test_server_only_does_not_need_client_or_resource_cache(self):
        for item in (self.recipe["mods"][1], self.recipe["resourcepacks"][0]):
            (self.root / ".cache/downloads" / (item["sha512"] + Path(item["filename"]).suffix)).unlink()
        self.build("server")
        self.assertTrue(self.archive("server").exists())
        self.assertFalse(self.archive("client").exists())

    def test_real_jar_dependency_presence_and_java_requirement(self):
        bad = jar({"fabric.mod.json": '{"id":"broken","depends":{"missing-mod":"*"}}'})
        self.recipe["mods"][1].update(self.asset(bad, "client-tool.jar"))
        self.write_recipe()
        with self.assertRaisesRegex(ValueError, "Missing Fabric dependencies"):
            self.build("client")
        bad = jar({"fabric.mod.json": '{"id":"broken"}', "Example.class": b"\xca\xfe\xba\xbe\x00\x00\x00\x46"})
        self.recipe["mods"][1].update(self.asset(bad, "client-tool.jar"))
        self.write_recipe()
        with self.assertRaisesRegex(ValueError, "cannot load"):
            self.build("client")

    def test_symlinked_output_is_rejected(self):
        folder = self.root / "build"
        folder.symlink_to(self.root / "templates", target_is_directory=True)
        with self.assertRaisesRegex(ValueError, "Symlinks"):
            self.build()


if __name__ == "__main__":
    unittest.main()
