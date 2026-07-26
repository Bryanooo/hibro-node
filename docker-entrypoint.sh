#!/bin/sh
set -eu

mkdir -p "${CODEX_HOME:-/home/node/.codex}"

if [ -f /run/host-codex/auth.json ]; then
  cp /run/host-codex/auth.json "${CODEX_HOME:-/home/node/.codex}/auth.json"
  chmod 600 "${CODEX_HOME:-/home/node/.codex}/auth.json"
fi

if [ -f /run/host-codex/config.toml ]; then
  cp /run/host-codex/config.toml "${CODEX_HOME:-/home/node/.codex}/config.toml"
  chmod 600 "${CODEX_HOME:-/home/node/.codex}/config.toml"
fi

exec dumb-init -- "$@"
