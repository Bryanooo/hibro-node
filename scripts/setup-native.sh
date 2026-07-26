#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
install_dir="${HIBRO_NATIVE_INSTALL_DIR:-/opt/hibro-node}"
data_dir="${HIBRO_NATIVE_DATA_DIR:-}"
config_dir="${HIBRO_NATIVE_CONFIG_DIR:-/etc/hibro-node}"
systemd_dir="${HIBRO_NATIVE_SYSTEMD_DIR:-/etc/systemd/system}"
service_name="${HIBRO_NATIVE_SERVICE_NAME:-hibro-node}"
skip_systemd="${HIBRO_NATIVE_SKIP_SYSTEMD:-false}"
skip_engines="${HIBRO_NATIVE_SKIP_ENGINES:-false}"
env_file="${HIBRO_SETUP_ENV_FILE:-${config_dir}/hibro-node.env}"
port_arg=""
project_root_arg=""
service_user_arg=""

usage() {
  cat <<'EOF'
Hibro Node Linux Native 一键部署

用法：
  sudo ./scripts/setup.sh --mode native [--env-file PATH] [--port PORT]
       [--project-root PATH] [--service-user USER]

脚本安装 Node 运行时、三种 Agent CLI 和 systemd 服务。服务默认以 sudo 发起者运行，
从而复用该用户已有的 Claude/Codex/OpenClaw 登录信息。
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
    --service-user)
      [[ $# -ge 2 ]] || { echo "--service-user 缺少参数" >&2; exit 2; }
      service_user_arg="$2"
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

if [[ "${skip_systemd}" != "true" ]]; then
  [[ "$(uname -s)" == "Linux" ]] || {
    echo "Native 服务模式只支持 systemd Linux；macOS 请使用 Docker 模式。" >&2
    exit 1
  }
  [[ "${EUID}" -eq 0 ]] || {
    echo "Native 模式需要安装系统服务，请使用 sudo。" >&2
    exit 1
  }
  for command_name in systemctl runuser; do
    command -v "${command_name}" >/dev/null 2>&1 || {
      echo "未找到 ${command_name}，无法安装 Native 服务。" >&2
      exit 1
    }
  done
fi
for command_name in node npm; do
  command -v "${command_name}" >/dev/null 2>&1 || {
    echo "未找到 ${command_name}，请先安装 Node.js 24 或更高版本。" >&2
    exit 1
  }
done
node_major="$(node -p 'Number(process.versions.node.split(".")[0])')"
((node_major >= 24)) || {
  echo "Native 模式要求 Node.js 24 或更高版本，当前为 $(node --version)。" >&2
  exit 1
}

service_user="${service_user_arg:-${SUDO_USER:-$(id -un)}}"
[[ "${service_user}" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] ||
  { echo "服务用户名不合法。" >&2; exit 1; }
id -u "${service_user}" >/dev/null 2>&1 ||
  { echo "服务用户不存在：${service_user}" >&2; exit 1; }
service_group="$(id -gn "${service_user}")"
service_home=""
if command -v getent >/dev/null 2>&1; then
  service_home="$(getent passwd "${service_user}" | awk -F: '{print $6}')"
fi
if [[ -z "${service_home}" && "${service_user}" == "$(id -un)" ]]; then
  service_home="${HOME}"
fi
service_home="${service_home:-/var/lib/hibro-node}"
node_binary="$(command -v node)"
if [[ "${skip_systemd}" != "true" &&
      ("${node_binary}" == /root/* || "${node_binary}" == /home/*) ]]; then
  echo "Node.js 位于用户私有目录，systemd 无法可靠访问：${node_binary}" >&2
  echo "请先安装系统级 Node.js 24。" >&2
  exit 1
fi

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
  chmod 0640 "${temporary}"
  mv -f "${temporary}" "${env_file}"
}

prompt_value() {
  local prompt="$1"
  local default_value="$2"
  local value=""
  if [[ -t 0 ]]; then read -r -p "${prompt} [${default_value}]: " value; fi
  printf '%s' "${value:-${default_value}}"
}

existing_data_dir="$(read_env_value HIBRO_NODE_DATA_DIR)"
data_dir="${data_dir:-${existing_data_dir:-${service_home}/.hibro}}"
node_port="${port_arg:-$(read_env_value HIBRO_NODE_PORT)}"
project_root="${project_root_arg:-$(read_env_value HIBRO_DEFAULT_PROJECT_ROOT)}"
node_port="${node_port:-$(prompt_value "Node 本机访问端口" "7331")}"
project_root="${project_root:-$(prompt_value "Agent 初始项目目录" "$(pwd)")}"
[[ "${node_port}" =~ ^[0-9]+$ ]] &&
  ((10#${node_port} >= 1 && 10#${node_port} <= 65535)) ||
  { echo "Node 端口必须是 1-65535。" >&2; exit 1; }
project_root="$(cd -- "${project_root}" 2>/dev/null && pwd)" ||
  { echo "Agent 初始项目目录不存在。" >&2; exit 1; }
[[ "${project_root}" =~ ^[A-Za-z0-9_./-]+$ ]] ||
  { echo "Native 项目路径暂不支持空格或特殊字符。" >&2; exit 1; }

install -d -m 0755 "${install_dir}" "${install_dir}/releases"
install -d -o "${service_user}" -g "${service_group}" -m 0750 "${data_dir}"
if [[ "${skip_systemd}" == "true" ]]; then
  install -d -o "${service_user}" -g "${service_group}" -m 0750 "${config_dir}"
else
  install -d -o root -g "${service_group}" -m 0750 "${config_dir}"
fi

if [[ ! -f "${env_file}" ]]; then
  (
    umask 027
    {
      printf 'HIBRO_NODE_HOST=127.0.0.1\n'
      printf 'HIBRO_NODE_PORT=%s\n' "${node_port}"
      printf 'HIBRO_NODE_DATA_DIR=%s\n' "${data_dir}"
      printf 'HIBRO_DEFAULT_PROJECT_ROOT=%s\n' "${project_root}"
      printf 'HIBRO_IMPORT_SHELL_ENV=false\n'
      printf 'ANTHROPIC_API_KEY=%s\n' "${ANTHROPIC_API_KEY:-}"
      printf 'ANTHROPIC_AUTH_TOKEN=%s\n' "${ANTHROPIC_AUTH_TOKEN:-}"
      printf 'ANTHROPIC_BASE_URL=%s\n' "${ANTHROPIC_BASE_URL:-}"
      printf 'ANTHROPIC_MODEL=%s\n' "${ANTHROPIC_MODEL:-}"
    } >"${env_file}"
  )
else
  echo "沿用已有 ${env_file}；仅更新本次确认的运行路径与端口。"
fi
set_env_value HIBRO_NODE_HOST "127.0.0.1"
set_env_value HIBRO_NODE_PORT "${node_port}"
set_env_value HIBRO_NODE_DATA_DIR "${data_dir}"
set_env_value HIBRO_DEFAULT_PROJECT_ROOT "${project_root}"
set_env_value HIBRO_IMPORT_SHELL_ENV "false"
chmod 0640 "${env_file}"
if [[ "${skip_systemd}" != "true" ]]; then
  chown "root:${service_group}" "${env_file}"
fi

if [[ "${skip_engines}" != "true" ]]; then
  echo "正在安装 Claude Code、Codex 与 OpenClaw CLI……"
  npm install --global \
    "@anthropic-ai/claude-code@2.1.218" \
    "@openai/codex@0.145.0" \
    "openclaw@2026.7.1-2"
fi

echo "正在安装 Hibro Node 运行文件……"
release_id="$(date -u +%Y%m%d%H%M%S)-$$"
release_dir="${install_dir}/releases/${release_id}"
install -d -m 0755 "${release_dir}"
cp -R "${repo_dir}/src" "${repo_dir}/assets" "${release_dir}/"
install -m 0644 "${repo_dir}/package.json" "${release_dir}/package.json"
install -m 0644 "${repo_dir}/package-lock.json" "${release_dir}/package-lock.json"
(cd "${release_dir}" && npm ci --omit=dev)
chmod -R u=rwX,go=rX "${release_dir}"
ln -sfn "${release_dir}" "${install_dir}/current"

unit_file="${systemd_dir}/${service_name}.service"
install -d -m 0755 "${systemd_dir}"
sed \
  -e "s|@SERVICE_USER@|${service_user}|g" \
  -e "s|@SERVICE_GROUP@|${service_group}|g" \
  -e "s|@INSTALL_DIR@|${install_dir}|g" \
  -e "s|@ENV_FILE@|${env_file}|g" \
  -e "s|@NODE_BINARY@|${node_binary}|g" \
  -e "s|@DATA_DIR@|${data_dir}|g" \
  -e "s|@PROJECT_ROOT@|${project_root}|g" \
  "${repo_dir}/deploy/hibro-node.service.template" >"${unit_file}"
chmod 0644 "${unit_file}"

if [[ "${skip_systemd}" == "true" ]]; then
  echo "Native 安装验证完成（已跳过 systemd）：${install_dir}/current"
  exit 0
fi

systemctl daemon-reload
systemctl enable --now "${service_name}.service"
systemctl restart "${service_name}.service"

healthy="false"
for _ in {1..30}; do
  if "${node_binary}" -e \
    "fetch('http://127.0.0.1:${node_port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1; then
    healthy="true"
    break
  fi
  sleep 1
done
if [[ "${healthy}" != "true" ]]; then
  systemctl status "${service_name}.service" --no-pager >&2 || true
  journalctl -u "${service_name}.service" -n 100 --no-pager >&2 || true
  exit 1
fi

echo
echo "Hibro Node 已启动：http://127.0.0.1:${node_port}/console"
echo "服务用户：${service_user}"
echo "Node 可独立使用；引擎若未认证，请以该服务用户运行对应 CLI 的登录命令。"
