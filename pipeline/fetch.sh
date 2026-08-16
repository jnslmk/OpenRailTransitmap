#!/usr/bin/env bash
#
# Stage 0: download the Geofabrik extract named by config/regions.yaml.
#
# Sizes as of writing: niedersachsen 479 MB, germany 4.5 GB. The file is left in
# $WORK so CI can cache it between runs and skip the download when unchanged.

set -euo pipefail

WORK="${WORK_DIR:-.work}"
mkdir -p "$WORK"

# Minimal YAML read - the file is a fixed, known shape.
ACTIVE="${REGION:-$(grep -E '^active:' config/regions.yaml | awk '{print $2}')}"
URL="$(awk -v region="  $ACTIVE:" '
  $0 == region { found = 1; next }
  found && /^    url:/ { print $2; exit }
  found && /^  [a-z]/ { exit }
' config/regions.yaml)"

if [[ -z "$URL" ]]; then
  echo "error: no url for region '$ACTIVE' in config/regions.yaml" >&2
  exit 1
fi

DEST="$WORK/${ACTIVE}-latest.osm.pbf"
echo "==> region '$ACTIVE'"
echo "==> $URL"

# Remove any other region's extract so extract.sh cannot pick up the wrong file.
find "$WORK" -maxdepth 1 -name '*-latest.osm.pbf' ! -name "$(basename "$DEST")" -delete

# -z only re-downloads when the remote copy is newer than the cached one.
curl -sSL --retry 4 --retry-delay 2 --retry-all-errors \
  ${CI:+--no-progress-meter} \
  -z "$DEST" -o "$DEST" "$URL"

echo "==> $DEST ($(du -h "$DEST" | cut -f1))"
