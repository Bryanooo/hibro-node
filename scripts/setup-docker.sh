#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
env_file="${HIBRO_SETUP_ENV_FILE:-${repo_dir}/.env}"
compose_project="${HIBRO_SETUP_PROJECT_NAME:-hibro-node}"
port_arg=""
project_root_arg=""

usage() {
  cat <<'EOF'
Hibro Node Docker 一键部署

用法：
  ./scripts/setup.sh --mode docker [--env-file PATH] [--port PORT]
                                   [--project-root PATH]

脚本会创建私有环境文件、构建镜像、启动 Node 并执行健康检查。
Claude/OpenClaw 可读取环境文件中的 Anthropic Token；Codex 复用当前用户的 ~/.codex。
EOF
}

while (($# > 0)); do
  case "$1" in
    --env-file)
      [[ $# -ge 2 ]] || { echo "--env-file 缺少参数" >&2; exit 2; }
      env_file="$2"
      shift 2
      ;;
    --port)
      [[ $# -ge 2 ]] || { echo "--port 缺少参数" >&2; exit 2; }
      port_arg="$2"
      shift 2
      ;;
    --project-root)
      [[ $# -ge 2 ]] || { echo "--project-root 缺少参数" >&2; exit 2; }
      project_root_arg="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "未知参数：$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

command -v docker >/dev/null 2>&1 || {
  echo "未找到 Docker，请先安装 Docker Desktop 或 Docker Engine。" >&2
  exit 1
}
docker compose version >/dev/null 2>&1 || {
  echo "当前 Docker 未提供 Compose 插件。" >&2
  exit 1
}
[[ "${compose_project}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] || {
  echo "Compose 项目名不合法。" >&2
  exit 1
}

read_env_value() {
  local key="$1"
  [[ -f "${env_file}" ]] || return 0
  awk -F= -v key="${key}" '
    $0 ~ "^[[:space:]]*" key "=" {
      sub(/^[^=]*=/, "")
      gsub(/\r$/, "")
      value = $0
    }
    END { if (value != "") print value }
  ' "${env_file}"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local temporary="${env_file}.tmp.$$"
  awk -F= -v key="${key}" -v value="${value}" '
    BEGIN { replaced = 0 }
    $0 ~ "^[[:space:]]*" key "=" {
      if (!replaced) print key "=" value
      replaced = 1
      next
    }
    { print }
    END { if (!replaced) print key "=" value }
  ' "${env_file}" >"${temporary}"
  chmod 600 "${temporary}"
  mv -f "${temporary}" "${env_file}"
}

prompt_value() {
  local prompt="$1"
  local default_value="$2"
  local value=""
  if [[ -t 0 ]]; then
    read -r -p "${prompt} [${default_value}]: " value
  fi
  printf '%s' "${value:-${default_value}}"
}

validate_port() {
  [[ "$1" =~ ^[0-9]+$ ]] && ((10#$1 >= 1 && 10#$1 <= 65535)) || {
    echo "Node 映射端口必须是 1-65535。" >&2
    exit 1
  }
}

validate_path() {
  [[ "$1" == /* && "$1" != *$'\n'* && "$1" != *$'\r'* ]] || {
    echo "项目路径必须是合法的绝对路径：$1" >&2
    exit 1
  }
}

existing_port="$(read_env_value HIBRO_DOCKER_PORT)"
existing_project_root="$(read_env_value HIBRO_NODE_PROJECT_ROOT)"
docker_port="${port_arg:-${existing_port:-}}"
project_root="${project_root_arg:-${existing_project_root:-}}"
docker_port="${docker_port:-$(prompt_value "Node 本机访问端口" "17332")}"
project_root="${project_root:-$(prompt_value "Agent 初始项目目录" "$(pwd)")}"
project_root="$(cd -- "${project_root}" 2>/dev/null && pwd)" || {
  echo "Agent 初始项目目录不存在：${project_root}" >&2
  exit 1
}
validate_port "${docker_port}"
validate_path "${project_root}"

host_home="${HOME}"
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]] &&
   command -v getent >/dev/null 2>&1; then
  candidate_home="$(getent passwd "${SUDO_USER}" | awk -F: '{print $6}')"
  host_home="${candidate_home:-${host_home}}"
fi
mkdir -p -- "${host_home}/.codex"

if [[ ! -f "${env_file}" ]]; then
  mkdir -p -- "$(dirname -- "${env_file}")"
  (
    umask 077
    {
      printf 'HIBRO_DOCKER_PORT=%s\n' "${docker_port}"
      printf 'HIBRO_NODE_PROJECT_ROOT=%s\n' "${project_root}"
      printf 'HIBRO_NODE_DATA_VOLUME=%s\n' \
        "${HIBRO_SETUP_DATA_VOLUME:-hibro-node-data}"
      printf 'HIBRO_NODE_CONTAINER_NAME=%s\n' \
        "${HIBRO_SETUP_CONTAINER_NAME:-hibro-node-local}"
      printf 'HIBRO_CODEX_DIR=%s/.codex\n' "${host_home}"
      printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY:-}"
      printf 'ANTHROPIC_AUTH_TOKEN=%s\n' "${ANTHROPIC_AUTH_TOKEN:-}"
      printf 'ANTHROPIC_BASE_URL=%s\n' "${ANTHROPIC_BASE_URL:-}"
      printf 'ANTHROPIC_MODEL=%s\n' "${ANTHROPIC_MODEL:-}"
    } >"${env_file}"
  )
  echo "已创建 ${env_file}（权限 600）。"
else
  chmod 600 "${env_file}"
  echo "沿用已有 ${env_file}；仅更新本次确认的端口和项目目录。"
fi
set_env_value HIBRO_DOCKER_PORT "${docker_port}"
set_env_value HIBRO_NODE_PROJECT_ROOT "${project_root}"
if [[ -z "$(read_env_value HIBRO_CODEX_DIR)" ]]; then
  set_env_value HIBRO_CODEX_DIR "${host_home}/.codex"
fi

compose=(
  docker compose
  --project-name "${compose_project}"
  --project-directory "${repo_dir}"
  --env-file "${env_file}"
)

echo "正在构建并启动 Hibro Node……"
"${compose[@]}" up -d --build hibro-node

healthy="false"
for _ in {1..45}; do
  if "${compose[@]}" exec -T hibro-node node -e \
    "fetch('http://127.0.0.1:7331/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    healthy="true"
    break
  fi
  sleep 1
done

if [[ "${healthy}" != "true" ]]; then
  echo "Node 未通过健康检查，最近日志如下：" >&2
  "${compose[@]}" logs --tail 100 hibro-node >&2
  exit 1
fi

echo
echo "Hibro Node 已启动：http://127.0.0.1:${docker_port}/console"
echo "Agent 初始项目：${project_root}"
echo "Node 可独立使用；如需接入 Core，请在 Node「系统配置」填写 Core URL 和一次性注册码。"
