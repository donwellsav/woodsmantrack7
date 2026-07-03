#!/usr/bin/env bash
# Regenerate PWA icons from the book's cover PDF (a full cover wrap).
# Requires: poppler (pdftoppm), ImageMagick (magick). The wrap is
# [back cover][spine][front cover] left→right, so the front cover is the right third.
set -euo pipefail
cd "$(dirname "$0")/.."

COVER_PDF="${1:-../Joey_Cover_6x9_308_13.020x9.250_EXACT.pdf}"
OUT=public/icons
mkdir -p "$OUT"

echo "Rendering cover page 1 at 300dpi…"
pdftoppm -png -r 300 -f 1 -l 1 "$COVER_PDF" "$OUT/cover-source"
SRC="$OUT/cover-source-1.png"

W=$(magick "$SRC" -format "%w" info:)
H=$(magick "$SRC" -format "%h" info:)
FRONT_X=$((W * 2 / 3))
FRONT_W=$((W / 3))
echo "Source: ${W}x${H}; cropping front cover at x=${FRONT_X} (${FRONT_W}x${H})"
magick "$SRC" -crop "${FRONT_W}x${H}+${FRONT_X}+0" +repage "$OUT/front-cover.png"

echo "Generating icon sizes…"
magick "$OUT/front-cover.png" -resize 512x512^ -gravity center -extent 512x512 "$OUT/icon-512.png"
magick "$OUT/front-cover.png" -resize 192x192^ -gravity center -extent 192x192 "$OUT/icon-192.png"
magick "$OUT/front-cover.png" -resize 180x180^ -gravity center -extent 180x180 "$OUT/apple-touch-icon.png"
magick "$OUT/front-cover.png" -resize 32x32^   -gravity center -extent 32x32   "$OUT/favicon-32.png"
magick "$OUT/front-cover.png" -resize 16x16^   -gravity center -extent 16x16   "$OUT/favicon-16.png"

# remove intermediates (keep the bundle small)
rm -f "$OUT/cover-source-1.png" "$OUT/front-cover.png"
echo "Done. Icons in $OUT:"
ls -la "$OUT"
