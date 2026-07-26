#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
mode="docker"
forwarded=()

while (($# > 0)); do
  case "$1" in
    --mode)
      [[ $# -ge 2 ]] || { echo "--mode 缺少参数" >&2; exit 2; }
      mode="$2"
      shift 2
      ;;
    -h|--help)
      cat <<'EOF'
Hibro Node 双模式部署

用法：
  ./scripts/setup.sh --mode docker [--env-file PATH] [--port PORT] [--project-root PATH]
  sudo ./scripts/setup.sh --mode native [--env-file PATH] [--port PORT]
       [--project-root PATH] [--service-user USER]

docker 是 macOS 和个人设备的推荐模式；native 面向使用 systemd 的 Linux。
Node 默认只监听本机，不要求登录，也不要求先配置 Hibro Core。
EOF
      exit 0
      ;;
    *)
      forwarded+=("$1")
      shift
      ;;
  esac
done

case "${mode}" in
  docker)
    exec "${script_dir}/setup-docker.sh" "${forwarded[@]}"
    ;;
  native)
    exec "${script_dir}/setup-native.sh" "${forwarded[@]}"
    ;;
  *)
    echo "--mode 只支持 docker 或 native。" >&2
    exit 2
    ;;
esac
