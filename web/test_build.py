"""Verify the public Web bundle and its protection against accidental secret publication."""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


@unittest.skipUnless(shutil.which("node"), "Node.js is required for the Makers static builder")
class MakersAssetBuildTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        shutil.copyfile(ROOT / "web/build.mjs", self.root / "build.mjs")
        for name in ("index.html", "styles.css", "app.js", "config.js"):
            (self.root / name).write_text("public content\n")
        (self.root / "assets").mkdir()
        shutil.copyfile(ROOT / "web/assets/icon.svg", self.root / "assets/icon.svg")
        (self.root / "admin").mkdir()
        for name in ("index.html", "app.js", "styles.css"):
            (self.root / "admin" / name).write_text("public admin ui\n")

    def build(self):
        return subprocess.run(["node", "build.mjs"], cwd=self.root, capture_output=True)

    def test_only_explicit_public_files_are_published(self):
        sentinel = "private-test-secret-never-publish"
        for name in (".env", "README.md", "assets/.env", "assets/private.json", "admin/.env", "admin/config.json"):
            (self.root / name).write_text(sentinel)
        for name in ("cloud-functions/admin/[[default]].js", "cloud-functions/api/server-status.js", "cloud-functions/mc-proxy/[[path]].js", "lib/log.mjs", "lib/server-status.mjs", "lib/minecraft-proxy.mjs"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(sentinel)
        (self.root / "edgeone.json").write_text("{}")
        self.assertEqual(self.build().returncode, 0)
        files = {p.relative_to(self.root / "dist").as_posix() for p in (self.root / "dist").rglob("*") if p.is_file()}
        self.assertEqual(files, {
            "index.html", "styles.css", "app.js", "config.js", "assets/icon.svg", "favicon.svg",
            "admin/index.html", "admin/app.js", "admin/styles.css",
        })
        for path in (self.root / "dist").rglob("*"):
            if path.is_file():
                self.assertNotIn(sentinel.encode(), path.read_bytes())

    def test_root_favicon_matches_neutral_svg(self):
        self.assertEqual(self.build().returncode, 0)
        self.assertEqual((self.root / "dist/favicon.svg").read_bytes(), (self.root / "assets/icon.svg").read_bytes())

    def test_invalid_favicon_does_not_replace_successful_output(self):
        (self.root / "dist").mkdir()
        (self.root / "dist/keep").write_text("last successful build")
        (self.root / "assets/icon.svg").write_text("not an SVG")
        self.assertNotEqual(self.build().returncode, 0)
        self.assertEqual((self.root / "dist/keep").read_text(), "last successful build")

    def test_symlink_public_file_is_rejected(self):
        (self.root / ".env").write_text("private-test-secret")
        (self.root / "admin/app.js").unlink()
        (self.root / "admin/app.js").symlink_to(self.root / ".env")
        self.assertNotEqual(self.build().returncode, 0)
        self.assertFalse((self.root / "dist").exists())

    def test_symlink_public_directory_is_rejected(self):
        original = self.root / "admin"
        original.rename(self.root / "protected-admin")
        original.symlink_to(self.root / "protected-admin", target_is_directory=True)
        self.assertNotEqual(self.build().returncode, 0)
        self.assertFalse((self.root / "dist").exists())

    def test_output_symlink_does_not_delete_its_target(self):
        protected = self.root / "protected"
        protected.mkdir()
        (protected / "keep").write_text("keep me")
        (self.root / "dist").symlink_to(protected, target_is_directory=True)
        self.assertNotEqual(self.build().returncode, 0)
        self.assertEqual((protected / "keep").read_text(), "keep me")

    def test_missing_public_file_preserves_successful_output(self):
        self.assertEqual(self.build().returncode, 0)
        (self.root / "app.js").unlink()
        self.assertNotEqual(self.build().returncode, 0)
        self.assertTrue((self.root / "dist/app.js").is_file())


if __name__ == "__main__":
    unittest.main()
