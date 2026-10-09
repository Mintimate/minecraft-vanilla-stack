#!/usr/bin/env python3
"""Build a bundled HMCL client and a server ZIP from fixed YAML downloads."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import io
import json
from pathlib import Path
import re
import shutil
import sys
import tempfile
from urllib.parse import urlsplit
from urllib.request import Request, urlopen
import zipfile

import yaml

ROOT = Path(__file__).resolve().parents[1]
SIDES = {"client", "server"}
ID = re.compile(r"[a-z][a-z0-9-]{0,63}")
VERSION = re.compile(r"[A-Za-z0-9][A-Za-z0-9._+-]*")


class RecipeLoader(yaml.SafeLoader):
    pass


def unique_mapping(loader, node):
    result = {}
    for key, value in node.value:
        key = loader.construct_object(key)
        if not isinstance(key, str) or key in result:
            raise ValueError("YAML keys must be unique strings")
        result[key] = loader.construct_object(value)
    return result


RecipeLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def safe(path):
    path = Path(path)
    path.relative_to(ROOT)
    for part in (path, *path.parents):
        if part.is_symlink():
            raise ValueError(f"Symlinks are not allowed: {part}")
        if part == ROOT:
            break
    return path


def file_info(item, suffix):
    name = item["filename"]
    if (not isinstance(name, str) or not name.endswith(suffix) or name.startswith(".")
            or any(c in name for c in '\\/:<>|?*"') or any(ord(c) < 32 for c in name)):
        raise ValueError(f"Invalid download filename: {name}")
    url = urlsplit(item["url"])
    if url.scheme != "https" or not url.hostname or url.username or url.password or url.fragment:
        raise ValueError("Downloads require a public HTTPS URL")
    if not re.fullmatch(r"[a-f0-9]{128}", item["sha512"]):
        raise ValueError(f"Invalid SHA-512: {name}")


def list_packs():
    return [path.stem for path in sorted((ROOT / "packs").glob("*.yaml"))]


def load_pack(pack_id):
    if not ID.fullmatch(pack_id):
        raise ValueError("Invalid pack ID")
    recipe = yaml.load(safe(ROOT / "packs" / (pack_id + ".yaml")).read_text(), Loader=RecipeLoader)
    allowed = {"id", "name", "version", "summary", "minecraft", "java", "fabric_loader",
               "server_launcher", "mods", "resourcepacks"}
    if not isinstance(recipe, dict) or set(recipe) - allowed or recipe["id"] != pack_id:
        raise ValueError("Recipe fields or ID are invalid")
    for key in ("version", "minecraft", "fabric_loader"):
        if not isinstance(recipe[key], str) or not VERSION.fullmatch(recipe[key]):
            raise ValueError(f"Invalid {key}")
    if not isinstance(recipe["name"], str) or not recipe["name"]:
        raise ValueError("Pack name is required")
    if type(recipe["java"]) is not int or not 8 <= recipe["java"] <= 99:
        raise ValueError("Invalid Java version")
    file_info(recipe["server_launcher"], ".jar")
    if recipe["server_launcher"]["filename"] != "fabric-server-launch.jar":
        raise ValueError("The launcher filename must be fabric-server-launch.jar")
    mods = recipe["mods"]
    if not isinstance(mods, list) or not mods:
        raise ValueError("List every mod, including its required dependencies")
    by_id, names = {}, set()
    for mod in mods:
        file_info(mod, ".jar")
        if not ID.fullmatch(mod["id"]) or mod["id"] in by_id or mod["filename"] in names:
            raise ValueError("Duplicate or invalid mod ID/filename")
        sides = mod["sides"]
        if not isinstance(sides, list) or not sides or len(set(sides)) != len(sides) or set(sides) - SIDES:
            raise ValueError(f"Invalid sides: {mod['id']}")
        if not isinstance(mod["license"], str) or not mod["license"]:
            raise ValueError(f"Declare the upstream license: {mod['id']}")
        by_id[mod["id"]] = mod
        names.add(mod["filename"])
    for mod in mods:
        for required in mod.get("requires", []):
            if required not in by_id or not set(mod["sides"]) <= set(by_id[required]["sides"]):
                raise ValueError(f"Missing dependency on the selected sides: {mod['id']} -> {required}")
    names = set()
    for resource in recipe.get("resourcepacks", []):
        file_info(resource, ".zip")
        if resource["filename"] in names:
            raise ValueError("Duplicate resource pack filename")
        names.add(resource["filename"])
    return recipe


def download(item, offline=False):
    suffix = Path(item["filename"]).suffix
    target = safe(ROOT / ".cache/downloads" / (item["sha512"] + suffix))
    if target.exists():
        data = target.read_bytes()
    else:
        if offline:
            raise ValueError(f"Offline cache missing: {item['filename']}")
        request = Request(item["url"], headers={"User-Agent": "Minecraft-Vanilla-Stack/0.1"})
        with urlopen(request, timeout=90) as response:
            data = response.read()
    if hashlib.sha512(data).hexdigest() != item["sha512"]:
        raise ValueError(f"SHA-512 mismatch: {item['filename']}")
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        if suffix == ".zip":
            metadata = json.loads(archive.read("pack.mcmeta"))
            if not isinstance(metadata.get("pack"), dict):
                raise ValueError("Invalid resource pack")
    if not target.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = safe(target.with_suffix(".part"))
        temporary.write_bytes(data)
        temporary.replace(target)
    return target


def check_mods(recipe, paths, side):
    """Check Fabric dependency presence and Java bytecode, including nested JARs."""
    # MixinExtras is bundled by the pinned Fabric Loader used by these recipes.
    identifiers = {"minecraft", "java", "fabricloader", "mixinextras"}
    requirements = []
    def visit(data, depth=0):
        if depth > 8:
            raise ValueError("Nested mod archive depth is too large")
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            metadata = json.loads(archive.read("fabric.mod.json"))
            if metadata.get("environment", "*") not in ("*", side):
                return
            identifiers.add(metadata["id"])
            identifiers.update(metadata.get("provides", []))
            requirements.append((metadata["id"], metadata.get("depends", {})))
            for name in archive.namelist():
                if name.endswith(".class"):
                    if name.startswith("META-INF/versions/") and int(name.split("/")[2]) > recipe["java"]:
                        continue
                    header = archive.read(name)[:8]
                    if header[:4] == b"\xca\xfe\xba\xbe" and int.from_bytes(header[6:8], "big") > recipe["java"] + 44:
                        raise ValueError(f"Java {recipe['java']} cannot load {name}")
            for nested in metadata.get("jars", []):
                visit(archive.read(nested["file"]), depth + 1)
    for mod in recipe["mods"]:
        if side in mod["sides"]:
            visit(paths[mod["sha512"]].read_bytes())
    for name, required in requirements:
        missing = set(required) - identifiers
        if missing:
            raise ValueError(f"Missing Fabric dependencies for {name}: {sorted(missing)}")


def snapshot(folder):
    result = {}
    for path in sorted(folder.rglob("*")):
        safe(path)
        name = path.relative_to(folder).as_posix()
        if name != ".build-manifest.json":
            result[name] = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else "directory"
    return result


def check_output(folder):
    safe(folder)
    if folder.exists():
        marker = safe(folder / ".build-manifest.json")
        if not marker.is_file() or json.loads(marker.read_text()) != snapshot(folder):
            raise ValueError(f"Build output contains user changes; move it before rebuilding: {folder}")


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def copy_tree(source, target):
    safe(source)
    for path in source.rglob("*"):
        safe(path)
    shutil.copytree(source, target)


def assemble(recipe, side, target, paths):
    copy_tree(ROOT / "templates" / side, target)
    selected = {mod["id"] for mod in recipe["mods"] if side in mod["sides"]}
    for mod, folder in (("plasmo-voice", "plasmovoice"), ("inventory-profiles-next", "inventoryprofilesnext"),
                        ("rei", "roughlyenoughitems")):
        if mod not in selected:
            shutil.rmtree(target / "config" / folder, ignore_errors=True)
    if side == "client" and "xaeros-world-map" not in selected:
        (target / "options.txt").unlink(missing_ok=True)
    if side == "server" and "fastback" not in selected:
        (target / "fastback.py").unlink(missing_ok=True)
    def info(item):
        return {"filename": item["filename"], "url": item["url"], "size": paths[item["sha512"]].stat().st_size,
                "hashes": {"sha512": item["sha512"]}}
    mods = [{"slug": mod["id"], "title": mod["id"], "sides": mod["sides"], "file": info(mod)}
            for mod in recipe["mods"] if side in mod["sides"]]
    metadata = {"format": 1, "pack_id": recipe["id"], "name": recipe["name"], "pack_version": recipe["version"],
                "minecraft": recipe["minecraft"], "java": recipe["java"], "fabric_loader": recipe["fabric_loader"],
                "features": {"voice": "plasmo-voice" in selected and side == "server",
                             "fastback": "fastback" in selected and side == "server"},
                "mods": mods}
    (target / "mods").mkdir(exist_ok=True)
    for mod in recipe["mods"]:
        if side in mod["sides"]:
            shutil.copyfile(paths[mod["sha512"]], target / "mods" / mod["filename"])
    if side == "server":
        metadata["server_launcher"] = info(recipe["server_launcher"])
        shutil.copyfile(paths[recipe["server_launcher"]["sha512"]], target / "fabric-server-launch.jar")
        for name in ("start.sh", "start.bat", "README.md"):
            path = target / name
            path.write_text(path.read_text().replace("__JAVA_MAJOR__", str(recipe["java"])), encoding="utf-8")
    else:
        for resource in recipe.get("resourcepacks", []):
            (target / "resourcepacks").mkdir(exist_ok=True)
            shutil.copyfile(paths[resource["sha512"]], target / "resourcepacks" / resource["filename"])
    guides = (["client-hmcl.md", "inventory.md", "voice-chat.md"] if side == "client" else
              (["backups.md"] if "fastback" in selected else []) + (["voice-chat.md"] if "plasmo-voice" in selected else []))
    for name in guides:
        source = ROOT / "docs" / name
        if source.exists():
            (target / "docs").mkdir(exist_ok=True)
            shutil.copyfile(source, target / "docs" / name)
    for name in ("LICENSE", "THIRD_PARTY.md"):
        shutil.copyfile(ROOT / name, target / name)
    lines = ["# " + recipe["name"], "", "| Mod | License |", "| --- | --- |"]
    lines += [f"| {mod['id']} | {mod['license']} |" for mod in recipe["mods"] if side in mod["sides"]]
    (target / "MODS.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    write_json(target / "pack.lock.json", metadata)
    sums = [f"{hashlib.sha512(path.read_bytes()).hexdigest()}  {path.relative_to(target).as_posix()}"
            for path in sorted(target.rglob("*")) if path.is_file() and path.suffix in (".jar", ".zip")]
    (target / "SHA512SUMS.txt").write_text("\n".join(sums) + "\n")
    write_json(target / ".build-manifest.json", snapshot(target))


def write_archive(path, entries):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for name, data in sorted(entries):
            entry = zipfile.ZipInfo(name, (2026, 1, 1, 0, 0, 0))
            entry.create_system = 3
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = (0o100755 if name.endswith(".sh") else 0o100644) << 16
            archive.writestr(entry, data)


def build(recipe, side="both", offline=False):
    sides = ["client", "server"] if side == "both" else [side]
    output = safe(ROOT / "build" / recipe["id"])
    distribution = safe(ROOT / "dist" / recipe["id"])
    for selected in sides:
        check_output(output / selected)
    items = [mod for mod in recipe["mods"] if set(mod["sides"]) & set(sides)]
    if "server" in sides:
        items += [recipe["server_launcher"]]
    if "client" in sides:
        items += recipe.get("resourcepacks", [])
    items = {item["sha512"]: item for item in items}
    with ThreadPoolExecutor(max_workers=5) as pool:
        paths = dict(zip(items, pool.map(lambda item: download(item, offline), items.values())))
    for selected in sides:
        check_mods(recipe, paths, selected)
    if "server" in sides:
        with zipfile.ZipFile(paths[recipe["server_launcher"]["sha512"]]) as launcher:
            settings = dict(line.split("=", 1) for line in launcher.read("install.properties").decode().splitlines()
                            if "=" in line and not line.startswith("#"))
        if (settings.get("game-version") != recipe["minecraft"]
                or settings.get("fabric-loader-version") != recipe["fabric_loader"]):
            raise ValueError("Server launcher versions differ from the YAML recipe")
    staging_parent = safe(ROOT / ".cache/assembly")
    staging_parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=staging_parent, prefix=recipe["id"] + "-") as temporary:
        staging = Path(temporary)
        archives = []
        for selected in sides:
            target = staging / selected
            assemble(recipe, selected, target, paths)
            stem = f"{recipe['id']}-{'client-hmcl' if selected == 'client' else 'server'}-{recipe['minecraft']}-{recipe['version']}"
            name = stem + (".mrpack" if selected == "client" else ".zip")
            entries = []
            if selected == "client":
                index = {"formatVersion": 1, "game": "minecraft", "name": recipe["name"], "versionId": recipe["version"],
                         "summary": recipe.get("summary", ""), "files": [],
                         "dependencies": {"minecraft": recipe["minecraft"], "fabric-loader": recipe["fabric_loader"]}}
                entries.append(("modrinth.index.json", json.dumps(index, ensure_ascii=False).encode()))
            for path in target.rglob("*"):
                if path.is_file() and path.name != ".build-manifest.json":
                    relative = path.relative_to(target).as_posix()
                    if selected != "client" or relative != "pack.lock.json":
                        entries.append((("overrides/" if selected == "client" else "") + relative, path.read_bytes()))
            write_archive(staging / name, entries)
            archives.append(name)
        for selected in sides:
            check_output(output / selected)
        distribution.mkdir(parents=True, exist_ok=True)
        checksum_file = safe(distribution / "SHA256SUMS.txt")
        old = {}
        if checksum_file.exists():
            for line in checksum_file.read_text().splitlines():
                digest, name = line.split("  ", 1)
                path = safe(distribution / name)
                if Path(name).name != name or not re.fullmatch(r"[a-f0-9]{64}", digest):
                    raise ValueError("Invalid previous distribution checksum")
                if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
                    raise ValueError(f"Distribution contains user changes: {name}")
                old[name] = digest
        current = {f"{recipe['id']}-{kind}-{recipe['minecraft']}-{recipe['version']}{suffix}"
                   for kind, suffix in (("client-hmcl", ".mrpack"), ("server", ".zip"))}
        for name in current:
            path = safe(distribution / name)
            if path.exists() and name not in old:
                raise ValueError(f"Unmanaged distribution already exists: {name}")
        output.mkdir(parents=True, exist_ok=True)
        previous = staging / "previous"
        previous.mkdir()
        installed, saved = [], []
        try:
            for selected in sides:
                if (output / selected).exists():
                    (output / selected).rename(previous / selected)
                    saved.append(selected)
                (staging / selected).rename(output / selected)
                installed.append(selected)
        except Exception:
            for selected in installed:
                shutil.rmtree(output / selected)
            for selected in saved:
                (previous / selected).rename(output / selected)
            raise
        for name in archives:
            safe(distribution / name)
            (staging / name).replace(distribution / name)
            print(f"Built: dist/{recipe['id']}/{name}")
        for name in old:
            if name not in current and name.startswith(recipe["id"] + "-") and name.endswith((".zip", ".mrpack")):
                (distribution / name).unlink()
        names = sorted(name for name in current if (distribution / name).is_file())
        checksum_file.write_text("".join(f"{hashlib.sha256((distribution / name).read_bytes()).hexdigest()}  {name}\n" for name in names))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("list", "validate", "build"))
    parser.add_argument("--pack")
    parser.add_argument("--side", choices=("client", "server", "both"), default="both")
    parser.add_argument("--offline", action="store_true")
    args = parser.parse_args()
    ids = [args.pack] if args.pack else list_packs()
    if not ids:
        raise ValueError("No recipes found")
    recipes = [load_pack(pack_id) for pack_id in ids]
    for recipe in recipes:
        if args.command == "list":
            print(recipe["id"])
        elif args.command == "validate":
            print(f"Validated: {recipe['id']} ({len(recipe['mods'])} mods)")
        else:
            build(recipe, args.side, args.offline)


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError, yaml.YAMLError, zipfile.BadZipFile) as error:
        print(f"Build failed: {error}", file=sys.stderr)
        sys.exit(1)
