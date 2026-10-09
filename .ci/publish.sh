#!/bin/sh
# Run build before CNB's release/attachments stages; run promote only afterward.
set -eu
cd "$(dirname "$0")/.."
case "${1:-}" in build|promote) ;; *) echo 'Usage: sh .ci/publish.sh build|promote' >&2; exit 2 ;; esac
test "${CNB_EVENT:-}" = tag_push
test "${CNB_DOCKER_REGISTRY:-}" = docker.cnb.cool
python3 - <<'PY'
import os, re
from pathlib import Path
import yaml
tag = os.environ['CNB_BRANCH']
assert re.fullmatch(r'v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)', tag), 'Expected a stable vX.Y.Z tag'
assert re.fullmatch(r'[a-f0-9]{40}', os.environ['CNB_COMMIT']), 'Expected the source commit SHA'
slug = os.environ['CNB_REPO_SLUG']
assert re.fullmatch(r'[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)+', slug), 'Invalid CNB repository'
assert os.environ['CNB_REPO_SLUG_LOWERCASE'] == slug.lower(), 'Repository casing mismatch'
for path in Path('packs').glob('*.yaml'):
    assert str(yaml.safe_load(path.read_text())['version']) == tag[1:], f'{path}: version must match {tag}'
PY
base="$CNB_DOCKER_REGISTRY/$CNB_REPO_SLUG_LOWERCASE"
packs=$(python3 tools/build.py list)
test -n "$packs"
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT HUP INT TERM

# Docker's JSON manifest provides both the index digest and platform descriptors.
inspect() {
  docker buildx imagetools inspect --format '{{json .Manifest}}' "$1" > "$temporary/index.json" || return
  jq -e '
    (.digest | test("^sha256:[a-f0-9]{64}$")) and
    ([.manifests[].platform | .os + "/" + .architecture] | sort == ["linux/amd64", "linux/arm64"]) and
    all(.manifests[]; .digest | test("^sha256:[a-f0-9]{64}$"))
  ' "$temporary/index.json" >/dev/null || return
  jq -r .digest "$temporary/index.json"
}

if [ "$1" = build ]; then
  # Preflight every pack before pushing any version tag. Auth/network errors fail.
  for pack in $packs; do
    if docker buildx imagetools inspect "$base/$pack:$CNB_BRANCH" > "$temporary/existing" 2> "$temporary/error"; then
      echo "Version image already exists: $base/$pack:$CNB_BRANCH" >&2
      exit 1
    fi
    case "$(tr '[:upper:]' '[:lower:]' < "$temporary/error")" in
      *unauthorized*|*denied*|*forbidden*) cat "$temporary/error" >&2; exit 1 ;;
      *'manifest unknown'*|*'name unknown'*|*'not found'*) ;;
      *) cat "$temporary/error" >&2; exit 1 ;;
    esac
    (cd "dist/$pack" && sha256sum -c SHA256SUMS.txt)
  done
  rm -rf .release
  mkdir -p .release/assets
  for pack in $packs; do
    image="$base/$pack"
    docker buildx build --platform linux/amd64,linux/arm64 --target runtime-prebuilt \
      --build-arg "PACK_ID=$pack" --build-arg "MVS_VERSION=${CNB_BRANCH#v}" \
      --build-arg "VCS_REF=$CNB_COMMIT" --build-arg "IMAGE_SOURCE=https://cnb.cool/$CNB_REPO_SLUG" \
      --tag "$image:$CNB_BRANCH" --push --provenance=false --sbom=false \
      --metadata-file "$temporary/build.json" .
    digest=$(inspect "$image:$CNB_BRANCH")
    test "$digest" = "$(jq -r '."containerimage.digest"' "$temporary/build.json")"
    printf '%s@%s\n' "$image" "$digest" >> .release/images.txt
    while read -r hash filename; do
      cp "dist/$pack/$filename" .release/assets/
    done < "dist/$pack/SHA256SUMS.txt"
    cp "dist/$pack/SHA256SUMS.txt" ".release/assets/$pack-SHA256SUMS.txt"
  done
  cp .release/images.txt .release/assets/Docker-images.txt
  cat > .release/notes.md <<EOF
Minecraft Vanilla Stack $CNB_BRANCH

Each pack includes an HMCL client bundle, server ZIP, and SHA256 checksums.
Docker-images.txt lists verified linux/amd64 + linux/arm64 images by immutable digest.
Set MC_IMAGE to the desired digest in the repository deployment configuration.

[Docker guide](https://cnb.cool/$CNB_REPO_SLUG/-/blob/$CNB_COMMIT/docs/docker.md)
· [Compose](https://cnb.cool/$CNB_REPO_SLUG/-/blob/$CNB_COMMIT/compose.yaml)
EOF
else
  test -s .release/images.txt
  # Validate every recorded version before changing any latest tag.
  for pack in $packs; do
    digest=$(inspect "$base/$pack:$CNB_BRANCH")
    test "$(awk -v prefix="$base/$pack@" 'index($0, prefix) == 1 { print }' .release/images.txt)" = "$base/$pack@$digest"
  done
  while read -r reference; do
    image=${reference%@*}
    docker buildx imagetools create --tag "$image:latest" "$reference"
    test "$(inspect "$image:latest")" = "${reference#*@}"
  done < .release/images.txt
fi
