#!/usr/bin/env bash
# Builds the verifier: the Stables card's own checking code (bundle, hop, exit line, key attestation rules) and the
# evidence decoder. Needs a JDK 11 or newer and Minima's minima.jar (only for its JSON classes), from
# https://github.com/minima-global/Minima/releases.
#
# Usage: MINIMA_JAR=/path/to/minima.jar ./build.sh
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${MINIMA_JAR:?set MINIMA_JAR to the path of minima.jar}"
rm -rf "$HERE/build" && mkdir -p "$HERE/build"
javac --release 11 -encoding UTF-8 -cp "$MINIMA_JAR" -d "$HERE/build" "$HERE"/java/org/stablescouncil/stables/route2/*.java
echo "built $HERE/build"
echo "decode a package: java -cp \"$HERE/build:$MINIMA_JAR\" org.stablescouncil.stables.route2.R2Evidence --pkg <file with the package hex>"
