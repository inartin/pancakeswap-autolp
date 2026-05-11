#!/usr/bin/env bash

# Load nvm (nvm is incompatible with strict bash modes)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use --lts >/dev/null 2>&1

# Enable strict mode after nvm is loaded
set -eo pipefail

corepack enable >/dev/null 2>&1 || true
exec pnpm start