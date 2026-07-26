#!/usr/bin/env bash
set -euo pipefail

# Hibro Node one-command installer/upgrader.
# A source checkout is installed locally; an installed copy downloads a verified release.

installer_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository="${HIBRO_INSTALL_REPOSITORY:-Bryanooo/hibro-node}"
if [[ "${EUID}" -eq 0 ]]; then
  default_source_root="/opt/hibro-node-source"
  default_state_dir="/var/lib/hibro-node-installer"
else
  default_data_home="${XDG_DATA_HOME:-${HOME}/.local/share}"
  default_source_root="${default_data_home}/hibro-node/source"
  default_state_dir="${default_data_home}/hibro-node/installer"
fi
source_root="${HIBRO_INSTALL_SOURCE_ROOT:-${default_source_root}}"
state_dir="${HIBRO_INSTALL_STATE_DIR:-${default_state_dir}}"
state_file="${state_dir}/hibro-node.env"
channel="stable"
source_mode="auto"
requested_version=""
mode=""
force="false"
allow_unverified_main="false"
action=""
setup_args=()
temp_dir=""
lock_dir=""

usage() {
  cat <<'EOF'
Hibro Node 一键安装与升级

用法：
  sudo bash install.sh
  sudo ./install.sh install [--mode docker|native] [--version vX.Y.Z] [部署选项]
  sudo ./install.sh update  [--version vX.Y.Z] [部署选项]
  sudo ./install.sh status

默认自动完成以下判断：
  - 在完整源码目录中执行时，直接安装当前源码，不访问 GitHub
  - 从已安装目录执行升级时，下载并校验 latest Release
  - 已安装则升级，未安装则安装
  - Linux 未检测到 Docker Compose 时使用 Native，否则使用 Docker

来源选项：
  --source auto|local|release
                           自动判断（默认）、当前源码或远程发布包
  --version TAG            安装指定 Release，默认 latest
  --channel stable|main    stable 使用带 SHA-256 的 Release
  --allow-unverified-main  允许 main 分支开发快照
  --force                  相同版本也重新部署

部署选项：
  --mode docker|native
  --env-file PATH
  --port PORT
  --project-root PATH
  --service-user USER      仅 Native

仅在使用远程发布包时才需要访问 GitHub；公开仓库不要求账号或 Git。
EOF
}

fail() {
  echo "错误：$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${temp_dir}" && -d "${temp_dir}" ]]; then
    rm -rf -- "${temp_dir}"
  fi
  if [[ -n "${lock_dir}" && -d "${lock_dir}" ]]; then
    rmdir -- "${lock_dir}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

read_state_value() {
  local key="$1"
  [[ -f "${state_file}" ]] || return 0
  awk -F= -v key="${key}" '
    $1 == key {
      sub(/^[^=]*=/, "")
      value = $0
    }
    END { if (value != "") print value }
  ' "${state_file}"
}

while (($# > 0)); do
  case "$1" in
    install|update|status)
      [[ -z "${action}" ]] || fail "只能指定一个 action。"
      action="$1"
      shift
      ;;
    --mode)
      [[ $# -ge 2 ]] || fail "--mode 缺少参数。"
      mode="$2"
      shift 2
      ;;
    --version)
      [[ $# -ge 2 ]] || fail "--version 缺少参数。"
      requested_version="$2"
      shift 2
      ;;
    --source)
      [[ $# -ge 2 ]] || fail "--source 缺少参数。"
      source_mode="$2"
      shift 2
      ;;
    --channel)
      [[ $# -ge 2 ]] || fail "--channel 缺少参数。"
      channel="$2"
      shift 2
      ;;
    --allow-unverified-main)
      allow_unverified_main="true"
      shift
      ;;
    --force)
      force="true"
      shift
      ;;
    --env-file|--port|--project-root|--service-user)
      [[ $# -ge 2 ]] || fail "$1 缺少参数。"
      setup_args+=("$1" "$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1"
      ;;
  esac
done

[[ "${repository}" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] ||
  fail "仓库名格式不合法。"
[[ "${channel}" == "stable" || "${channel}" == "main" ]] ||
  fail "--channel 只支持 stable 或 main。"
[[ "${source_mode}" == "auto" || "${source_mode}" == "local" ||
   "${source_mode}" == "release" ]] ||
  fail "--source 只支持 auto、local 或 release。"
if [[ -n "${mode}" ]]; then
  [[ "${mode}" == "docker" || "${mode}" == "native" ]] ||
    fail "--mode 只支持 docker 或 native。"
fi
if [[ -n "${requested_version}" ]]; then
  [[ "${requested_version}" =~ ^v?[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] ||
    fail "--version 必须是 vX.Y.Z 格式。"
fi

if [[ -z "${action}" ]]; then
  [[ -f "${state_file}" ]] && action="update" || action="install"
fi
if [[ "${action}" == "status" ]]; then
  if [[ ! -f "${state_file}" ]]; then
    echo "Hibro Node 尚未通过安装器安装。"
    exit 0
  fi
  echo "Hibro Node 安装状态"
  echo "  版本：$(read_state_value VERSION)"
  echo "  模式：$(read_state_value MODE)"
  echo "  来源：$(read_state_value SOURCE)"
  echo "  源码：$(read_state_value RELEASE_DIR)"
  echo "  安装时间：$(read_state_value INSTALLED_AT)"
  exit 0
fi

if [[ "${EUID}" -ne 0 &&
      ("${source_root}" == /opt/* || "${state_dir}" == /var/lib/*) ]]; then
  fail "默认安装目录需要管理员权限，请使用 sudo。"
fi
for command_name in tar awk grep mktemp install; do
  command -v "${command_name}" >/dev/null 2>&1 ||
    fail "缺少安装工具：${command_name}"
done
if [[ "${action}" == "install" && -f "${state_file}" &&
      "${force}" != "true" ]]; then
  fail "检测到已有安装，请使用 update 或 --force。"
fi
if [[ "${action}" == "update" && ! -f "${state_file}" ]]; then
  fail "没有找到既有安装，请先执行 install。"
fi
if [[ -z "${mode}" ]]; then
  mode="$(read_state_value MODE)"
  if [[ -z "${mode}" ]]; then
    if command -v docker >/dev/null 2>&1 &&
       docker compose version >/dev/null 2>&1; then
      mode="docker"
    elif [[ "$(uname -s)" == "Linux" ]]; then
      mode="native"
    else
      mode="docker"
    fi
    echo "已自动选择 ${mode} 部署模式。"
  fi
fi

mkdir -p -- "${source_root}/releases" "${state_dir}"
chmod 0755 "${source_root}" "${source_root}/releases"
chmod 0700 "${state_dir}"
lock_dir="${state_dir}/hibro-node.lock"
mkdir -- "${lock_dir}" 2>/dev/null ||
  fail "另一个 Hibro Node 安装或升级正在执行。"

temp_dir="$(mktemp -d "${TMPDIR:-/tmp}/hibro-node-install.XXXXXX")"
archive_path="${temp_dir}/hibro-node.tar.gz"
checksum_path="${temp_dir}/hibro-node.tar.gz.sha256"

download() {
  local url="$1"
  local destination="$2"
  case "${url}" in
    https://*)
      curl --fail --location --silent --show-error \
        --proto '=https' --tlsv1.2 --output "${destination}" "${url}"
      ;;
    file://*)
      [[ "${HIBRO_INSTALL_ALLOW_FILE_URL:-false}" == "true" ]] ||
        fail "仅测试环境允许 file:// 下载。"
      curl --fail --location --silent --show-error \
        --output "${destination}" "${url}"
      ;;
    *)
      fail "只允许通过 HTTPS 下载发布包。"
      ;;
  esac
}

is_local_source="true"
for local_required_path in \
  VERSION package.json package-lock.json install.sh compose.yaml Dockerfile \
  scripts/hibro scripts/package-release.sh scripts/setup.sh scripts/setup-docker.sh \
  scripts/setup-native.sh deploy/hibro-node.service.template; do
  if [[ ! -f "${installer_dir}/${local_required_path}" ]]; then
    is_local_source="false"
    break
  fi
done
if [[ "${is_local_source}" == "true" ]] &&
   ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"@hibro/node"' \
     "${installer_dir}/package.json"; then
  is_local_source="false"
fi

if [[ "${source_mode}" == "auto" && "${is_local_source}" == "true" ]]; then
  installed_release="$(read_state_value RELEASE_DIR)"
  if [[ -n "${installed_release}" && -d "${installed_release}" &&
        "$(cd -- "${installed_release}" && pwd -P)" == "${installer_dir}" ]]; then
    source_mode="release"
  else
    source_mode="local"
  fi
elif [[ "${source_mode}" == "auto" ]]; then
  source_mode="release"
fi
if [[ "${source_mode}" == "local" && "${is_local_source}" != "true" ]]; then
  fail "当前目录不是完整的 Hibro Node 源码，请改用 --source release。"
fi

if [[ "${source_mode}" == "local" ]]; then
  command -v node >/dev/null 2>&1 ||
    fail "安装当前源码需要 Node.js，请先安装 Node.js 24 或更高版本。"
  echo "检测到完整源码，正在生成安全的本地安装包（不会包含 .git 或 .env）……"
  local_release_dir="${temp_dir}/local-release"
  bash "${installer_dir}/scripts/package-release.sh" "${local_release_dir}"
  cp -- "${local_release_dir}/hibro-node.tar.gz" "${archive_path}"
  cp -- "${local_release_dir}/hibro-node.tar.gz.sha256" "${checksum_path}"
  effective_channel="local"
else
  command -v curl >/dev/null 2>&1 || fail "下载发布包需要 curl。"
  effective_channel="${channel}"
  if [[ "${channel}" == "main" &&
        "${allow_unverified_main}" != "true" ]]; then
    fail "main 没有发布校验和；开发联调请显式添加 --allow-unverified-main。"
  fi
fi

if [[ "${source_mode}" == "release" && "${channel}" == "stable" ]]; then
  if [[ -n "${requested_version}" ]]; then
    tag="${requested_version}"
    [[ "${tag}" == v* ]] || tag="v${tag}"
    asset_base="${HIBRO_INSTALL_RELEASE_BASE_URL:-https://github.com/${repository}/releases/download}/${tag}"
  else
    tag="latest"
    asset_base="${HIBRO_INSTALL_LATEST_ASSET_BASE_URL:-https://github.com/${repository}/releases/latest/download}"
  fi
  echo "正在下载 Hibro Node ${tag} 发布包……"
  download "${asset_base%/}/hibro-node.tar.gz" "${archive_path}"
  download "${asset_base%/}/hibro-node.tar.gz.sha256" "${checksum_path}"
elif [[ "${source_mode}" == "release" ]]; then
  archive_url="${HIBRO_INSTALL_MAIN_ARCHIVE_URL:-https://codeload.github.com/${repository}/tar.gz/refs/heads/main}"
  echo "警告：正在下载未签名的 main 分支快照。" >&2
  download "${archive_url}" "${archive_path}"
fi

if [[ -f "${checksum_path}" ]]; then
  expected_checksum="$(awk 'NR == 1 { print $1 }' "${checksum_path}")"
  [[ "${expected_checksum}" =~ ^[A-Fa-f0-9]{64}$ ]] ||
    fail "发布包校验文件格式不正确。"
  if command -v sha256sum >/dev/null 2>&1; then
    actual_checksum="$(sha256sum "${archive_path}" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual_checksum="$(shasum -a 256 "${archive_path}" | awk '{print $1}')"
  else
    fail "缺少 sha256sum 或 shasum。"
  fi
  [[ "${actual_checksum}" == "${expected_checksum}" ]] ||
    fail "发布包 SHA-256 不匹配，已停止安装。"
fi

archive_entries="${temp_dir}/archive-entries.txt"
tar -tzf "${archive_path}" >"${archive_entries}" ||
  fail "发布包不是有效的 tar.gz 文件。"
if awk '
  /^\// { bad = 1 }
  {
    count = split($0, parts, "/")
    for (i = 1; i <= count; i++) if (parts[i] == "..") bad = 1
  }
  END { exit bad ? 0 : 1 }
' "${archive_entries}"; then
  fail "发布包包含不安全路径。"
fi

unpack_dir="${temp_dir}/unpacked"
mkdir -p -- "${unpack_dir}"
tar -xzf "${archive_path}" -C "${unpack_dir}"
candidate_dir="${unpack_dir}"
if [[ ! -f "${candidate_dir}/package.json" ]]; then
  candidate_count=0
  for possible_dir in "${unpack_dir}"/*; do
    if [[ -d "${possible_dir}" && -f "${possible_dir}/package.json" ]]; then
      candidate_dir="${possible_dir}"
      candidate_count=$((candidate_count + 1))
    fi
  done
  [[ "${candidate_count}" -eq 1 ]] || fail "发布包目录结构不正确。"
fi

for required_path in \
  VERSION package.json package-lock.json install.sh compose.yaml Dockerfile \
  scripts/hibro scripts/setup.sh scripts/setup-docker.sh scripts/setup-native.sh \
  deploy/hibro-node.service.template; do
  [[ -f "${candidate_dir}/${required_path}" ]] ||
    fail "发布包缺少必要文件：${required_path}"
done
grep -Eq '"name"[[:space:]]*:[[:space:]]*"@hibro/node"' \
  "${candidate_dir}/package.json" || fail "package.json 不是 Hibro Node。"
for script in install.sh scripts/setup.sh scripts/setup-docker.sh scripts/setup-native.sh; do
  bash -n "${candidate_dir}/${script}"
done

package_version="$(tr -d '[:space:]' <"${candidate_dir}/VERSION")"
[[ "${package_version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] ||
  fail "VERSION 文件格式不正确。"
if [[ -n "${requested_version}" ]]; then
  [[ "${package_version}" == "${requested_version#v}" ]] ||
    fail "请求版本与发布包版本不一致。"
fi
current_version="$(read_state_value VERSION)"
if [[ "${source_mode}" == "release" && "${channel}" == "stable" &&
      "${current_version}" == "${package_version}" &&
      "${force}" != "true" ]]; then
  echo "当前已经是 Hibro Node ${package_version}。"
  exit 0
fi

release_suffix="$(date -u +%Y%m%d%H%M%S)-$$"
release_dir="${source_root}/releases/${package_version}-${effective_channel}-${release_suffix}"
mkdir -p -- "${release_dir}"
cp -R "${candidate_dir}/." "${release_dir}/"
chmod +x "${release_dir}/install.sh" "${release_dir}/scripts/"*.sh

previous_release=""
previous_native_runtime=""
docker_rollback_image=""
if [[ -L "${source_root}/current" ]]; then
  previous_release="$(readlink "${source_root}/current")"
fi
ln -sfn "${release_dir}" "${source_root}/current"
if [[ "${mode}" == "native" ]]; then
  native_install_dir="${HIBRO_NATIVE_INSTALL_DIR:-/opt/hibro-node}"
  if [[ -L "${native_install_dir}/current" ]]; then
    previous_native_runtime="$(readlink "${native_install_dir}/current")"
  fi
elif command -v docker >/dev/null 2>&1 &&
     docker image inspect hibro-node:local >/dev/null 2>&1; then
  docker_rollback_image="hibro-node:rollback-${release_suffix}"
  docker image tag hibro-node:local "${docker_rollback_image}"
fi

has_env_file="false"
for ((i = 0; i < ${#setup_args[@]}; i++)); do
  [[ "${setup_args[$i]}" == "--env-file" ]] && has_env_file="true"
done
if [[ "${mode}" == "docker" && "${has_env_file}" != "true" ]]; then
  setup_args+=("--env-file" "${HIBRO_INSTALL_DOCKER_ENV_FILE:-${state_dir}/runtime.env}")
fi

echo "源码检查通过，正在执行 ${mode} 部署……"
if ! "${release_dir}/scripts/setup.sh" --mode "${mode}" "${setup_args[@]}"; then
  if [[ -n "${previous_release}" ]]; then
    ln -sfn "${previous_release}" "${source_root}/current"
    echo "部署失败，源码已恢复到上一版本；运行数据未删除。" >&2
  else
    rm -f -- "${source_root}/current"
    echo "首次部署失败，未写入安装状态；运行数据未删除。" >&2
  fi
  if [[ "${mode}" == "native" && -n "${previous_native_runtime}" ]]; then
    ln -sfn "${previous_native_runtime}" "${HIBRO_NATIVE_INSTALL_DIR:-/opt/hibro-node}/current"
    if [[ "${HIBRO_NATIVE_SKIP_SYSTEMD:-false}" != "true" ]]; then
      systemctl restart "${HIBRO_NATIVE_SERVICE_NAME:-hibro-node}.service" || true
    fi
  elif [[ "${mode}" == "docker" && -n "${docker_rollback_image}" ]]; then
    docker image tag "${docker_rollback_image}" hibro-node:local
    rollback_compose_dir="${previous_release:-${release_dir}}"
    rollback_env_file="${HIBRO_INSTALL_DOCKER_ENV_FILE:-${state_dir}/runtime.env}"
    for ((i = 0; i < ${#setup_args[@]}; i++)); do
      if [[ "${setup_args[$i]}" == "--env-file" ]]; then
        rollback_env_file="${setup_args[$((i + 1))]}"
        break
      fi
    done
    docker compose \
      --project-name "${HIBRO_SETUP_PROJECT_NAME:-hibro-node}" \
      --project-directory "${rollback_compose_dir}" \
      --env-file "${rollback_env_file}" \
      up -d --no-build hibro-node ||
      echo "警告：旧镜像已恢复，但容器重启失败，请立即检查。" >&2
  fi
  rm -rf -- "${release_dir}"
  exit 1
fi
if [[ -n "${docker_rollback_image}" ]]; then
  docker image rm "${docker_rollback_image}" >/dev/null 2>&1 || true
fi

if [[ -n "${HIBRO_INSTALL_CLI_PATH:-}" ]]; then
  cli_path="${HIBRO_INSTALL_CLI_PATH}"
elif [[ "${EUID}" -eq 0 ]]; then
  cli_path="/usr/local/bin/hibro"
else
  cli_path="${HOME}/.local/bin/hibro"
fi
[[ "${cli_path}" == /* && "${cli_path}" != *$'\n'* &&
   "${cli_path}" != *$'\r'* ]] || fail "CLI 安装路径必须是合法的绝对路径。"
install -d -m 0755 "$(dirname -- "${cli_path}")"
install -m 0755 "${release_dir}/scripts/hibro" "${cli_path}"

installed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
state_temp="${state_file}.tmp.$$"
(
  umask 077
  {
    printf 'VERSION=%s\n' "${package_version}"
    printf 'MODE=%s\n' "${mode}"
    printf 'SOURCE=%s\n' "${source_mode}"
    printf 'CHANNEL=%s\n' "${channel}"
    printf 'REPOSITORY=%s\n' "${repository}"
    printf 'RELEASE_DIR=%s\n' "${release_dir}"
    printf 'CLI_PATH=%s\n' "${cli_path}"
    printf 'PREVIOUS_RELEASE_DIR=%s\n' "${previous_release}"
    printf 'INSTALLED_AT=%s\n' "${installed_at}"
  } >"${state_temp}"
)
mv -f "${state_temp}" "${state_file}"

echo
echo "Hibro Node ${package_version} 已安装完成。"
echo "运维命令：hibro node status"
if [[ "${EUID}" -ne 0 && ":${PATH}:" != *":$(dirname -- "${cli_path}"):"* ]]; then
  echo "提示：请把 $(dirname -- "${cli_path}") 加入 PATH。"
fi
echo "以后升级：sudo bash ${source_root}/current/install.sh"
