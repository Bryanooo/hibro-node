#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "${script_dir}/.." && pwd)"
output_dir="${1:-${repo_dir}/release}"
version="$(tr -d '[:space:]' <"${repo_dir}/VERSION")"
package_version="$(
  node -e "process.stdout.write(require(process.argv[1]).version)" \
    "${repo_dir}/package.json"
)"

[[ "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] ||
  { echo "VERSION 格式不正确。" >&2; exit 1; }
[[ "${package_version}" == "${version}" ]] ||
  { echo "VERSION 与 package.json 版本不一致。" >&2; exit 1; }

mkdir -p -- "${output_dir}"
output_dir="$(cd -- "${output_dir}" && pwd)"
archive_path="${output_dir}/hibro-node.tar.gz"
checksum_path="${output_dir}/hibro-node.tar.gz.sha256"
rm -f -- "${archive_path}" "${checksum_path}"

(
  cd "${repo_dir}"
  tar -czf "${archive_path}" \
    .env.example Dockerfile README.md VERSION compose.yaml \
    docker-entrypoint.sh package.json package-lock.json tsconfig.json \
    install.sh assets deploy docs scripts src test
)

if command -v sha256sum >/dev/null 2>&1; then
  checksum="$(sha256sum "${archive_path}" | awk '{print $1}')"
else
  checksum="$(shasum -a 256 "${archive_path}" | awk '{print $1}')"
fi
printf '%s  hibro-node.tar.gz\n' "${checksum}" >"${checksum_path}"

echo "已生成 Hibro Node v${version} 发布文件："
echo "  ${archive_path}"
echo "  ${checksum_path}"
