#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"
git config core.hooksPath .githooks
echo 'Installed verification, Conventional Commit, and owner/protected-branch hooks.'
