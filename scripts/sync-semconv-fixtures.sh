#!/usr/bin/env bash
# Copy the shared recorded spans from rius-semconv into this SDK's tests, at a
# pinned commit.
#
#   scripts/sync-semconv-fixtures.sh                     # ../rius-semconv @ origin/main
#   RIUS_SEMCONV=<checkout> REF=<commit|branch> scripts/sync-semconv-fixtures.sh
#
# rius-semconv holds every instrumentor's recording and its expected
# normalized result; tests/conformance.test.ts replays them through this SDK's
# processors. Only the data is copied (manifests, recordings, expected results
# and the format README), never the recorders, plus the module that encodes a
# replayed span, vendored unchanged as tests/conformance/_recording.mjs, and
# the media parts registry (registry/media_parts.yaml) as JSON, whose golden
# strip examples tests/mediaParts.test.ts runs. Converting it needs python3
# with PyYAML.
# SOURCE records the commit the copy came from. Both copies are excluded from
# biome (biome.json) so they stay byte-for-byte what rius-semconv wrote.
set -euo pipefail

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
SRC="${RIUS_SEMCONV:-$ROOT/../rius-semconv}"
REF="${REF:-origin/main}"
DATA="$ROOT/tests/fixtures/semconv"
CODE="$ROOT/tests/conformance"

if ! git -C "$SRC" rev-parse --git-dir >/dev/null 2>&1; then
  echo "no rius-semconv checkout at $SRC (set RIUS_SEMCONV)" >&2
  exit 1
fi
if [[ "$REF" == origin/* ]]; then
  git -C "$SRC" fetch --quiet origin
fi
COMMIT="$(git -C "$SRC" rev-parse "$REF^{commit}")"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git -C "$SRC" archive "$COMMIT" fixtures registry/media_parts.yaml | tar -x -C "$WORK"

rm -rf "$DATA"
mkdir -p "$DATA/fixtures"
cp "$WORK/fixtures/README.md" "$DATA/fixtures/README.md"
for family in "$WORK"/fixtures/*/; do
  name="$(basename "$family")"
  [[ "$name" == _* ]] && continue
  mkdir -p "$DATA/fixtures/$name"
  for file in "$family"*.json; do
    case "$(basename "$file")" in
      package.json | package-lock.json) continue ;;
    esac
    cp "$file" "$DATA/fixtures/$name/"
  done
done
python3 -c 'import json, sys, yaml
json.dump(yaml.safe_load(open(sys.argv[1], encoding="utf-8")), sys.stdout, ensure_ascii=False, indent=2)
print()' "$WORK/registry/media_parts.yaml" >"$DATA/media_parts.json"
printf 'rius-semconv %s\n' "$COMMIT" >"$DATA/SOURCE"

mkdir -p "$CODE"
{
  printf '// Vendored from rius-semconv %s fixtures/_recording.mjs by\n' "$COMMIT"
  printf '// scripts/sync-semconv-fixtures.sh. Do not edit: change it in rius-semconv.\n'
  cat "$WORK/fixtures/_recording.mjs"
} >"$CODE/_recording.mjs"

echo "synced $(find "$DATA/fixtures" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ') families from rius-semconv ${COMMIT:0:7}"
