#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG="cherryontop-runner:local"
CLUSTER_NAME="org-local"
# ponytail: `kind load docker-image` shells out to `docker save -o /tmp/...`,
# which a snap-confined Docker cannot write to. Saving to a plain (non-hidden)
# directory under $HOME ourselves and loading the archive works on both snap and
# native Docker. Drop back to `kind load docker-image` if snap ever goes away.
ARCHIVE_DIR="$HOME/cot-images"

echo "Building $IMAGE_TAG..."
docker build -t "$IMAGE_TAG" .

mkdir -p "$ARCHIVE_DIR"
echo "Loading $IMAGE_TAG into kind cluster $CLUSTER_NAME..."
docker save -o "$ARCHIVE_DIR/runner.tar" "$IMAGE_TAG"
kind load image-archive "$ARCHIVE_DIR/runner.tar" --name "$CLUSTER_NAME"

echo "Done. $IMAGE_TAG is available inside the cluster."
