import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url).pathname;
const installerPath = join(repositoryRoot, "install.sh");

function makeRelease(
  root: string,
  version: string,
  validChecksum = true,
  failSetup = false,
) {
  const source = join(root, `source-${version}`);
  const assetDirectory = join(root, "assets", `v${version}`);
  mkdirSync(join(source, "scripts"), { recursive: true });
  mkdirSync(join(source, "deploy"), { recursive: true });
  mkdirSync(assetDirectory, { recursive: true });
  writeFileSync(join(source, "VERSION"), `${version}\n`);
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "@hibro/node", version }),
  );
  writeFileSync(join(source, "package-lock.json"), "{}\n");
  for (const name of ["Dockerfile", "compose.yaml"]) {
    writeFileSync(join(source, name), "\n");
  }
  writeFileSync(
    join(source, "deploy", "hibro-node.service.template"),
    "[Service]\n",
  );
  writeFileSync(join(source, "install.sh"), "#!/usr/bin/env bash\n");
  chmodSync(join(source, "install.sh"), 0o755);
  writeFileSync(
    join(source, "scripts", "package-release.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"',
      'output_dir="$1"',
      'mkdir -p -- "${output_dir}"',
      'tar -czf "${output_dir}/hibro-node.tar.gz" -C "${repo_dir}" VERSION package.json package-lock.json install.sh compose.yaml Dockerfile deploy scripts',
      'if command -v sha256sum >/dev/null 2>&1; then checksum="$(sha256sum "${output_dir}/hibro-node.tar.gz" | awk \'{print $1}\')"; else checksum="$(shasum -a 256 "${output_dir}/hibro-node.tar.gz" | awk \'{print $1}\')"; fi',
      'printf "%s  hibro-node.tar.gz\\n" "${checksum}" >"${output_dir}/hibro-node.tar.gz.sha256"',
      "",
    ].join("\n"),
  );
  for (const name of ["setup-docker.sh", "setup-native.sh"]) {
    writeFileSync(join(source, "scripts", name), "#!/usr/bin/env bash\n");
  }
  writeFileSync(
    join(source, "scripts", "setup.sh"),
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "printf '%s\\n' \"$PWD|$*\" >> \"${HIBRO_TEST_SETUP_LOG}\"",
      ...(failSetup
        ? [
            "mkdir -p \"${HIBRO_NATIVE_INSTALL_DIR}\"",
            "ln -sfn \"$PWD\" \"${HIBRO_NATIVE_INSTALL_DIR}/current\"",
            "exit 42",
          ]
        : []),
      "",
    ].join("\n"),
  );
  for (const name of [
    "package-release.sh",
    "setup.sh",
    "setup-docker.sh",
    "setup-native.sh",
  ]) {
    chmodSync(join(source, "scripts", name), 0o755);
  }

  const archive = join(assetDirectory, "hibro-node.tar.gz");
  const packed = spawnSync("tar", ["-czf", archive, "-C", source, "."], {
    encoding: "utf8",
  });
  assert.equal(packed.status, 0, packed.stderr);
  const checksum = createHash("sha256")
    .update(readFileSync(archive))
    .digest("hex");
  writeFileSync(
    `${archive}.sha256`,
    `${validChecksum ? checksum : "0".repeat(64)}  hibro-node.tar.gz\n`,
  );
  return join(root, "assets");
}

test("Node one-command install uses a complete local checkout without GitHub", () => {
  const root = mkdtempSync(join(tmpdir(), "hibro-node-local-"));
  makeRelease(root, "4.0.0");
  const source = join(root, "source-4.0.0");
  writeFileSync(join(source, "install.sh"), readFileSync(installerPath));
  chmodSync(join(source, "install.sh"), 0o755);

  const result = spawnSync("bash", [join(source, "install.sh"), "--mode", "docker"], {
    encoding: "utf8",
    env: {
      ...process.env,
      HIBRO_INSTALL_SOURCE_ROOT: join(root, "installed-source"),
      HIBRO_INSTALL_STATE_DIR: join(root, "installer-state"),
      HIBRO_INSTALL_LATEST_ASSET_BASE_URL: "https://127.0.0.1:1/unreachable",
      HIBRO_INSTALL_DOCKER_ENV_FILE: join(root, "runtime.env"),
      HIBRO_TEST_SETUP_LOG: join(root, "setup.log"),
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /检测到完整源码/);
  assert.match(result.stdout, /4\.0\.0 已安装完成/);
  assert.match(
    readFileSync(join(root, "installer-state", "hibro-node.env"), "utf8"),
    /SOURCE=local/,
  );
});

function runInstaller(
  root: string,
  assetDirectory: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  return spawnSync("bash", [installerPath, "--source", "release", ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      HIBRO_INSTALL_SOURCE_ROOT: join(root, "installed-source"),
      HIBRO_INSTALL_STATE_DIR: join(root, "installer-state"),
      HIBRO_INSTALL_DOCKER_ENV_FILE: join(root, "hibro-node.env"),
      HIBRO_INSTALL_RELEASE_BASE_URL: `file://${assetDirectory}`,
      HIBRO_INSTALL_ALLOW_FILE_URL: "true",
      HIBRO_TEST_SETUP_LOG: join(root, "setup.log"),
      ...extraEnv,
    },
  });
}

test("Node remote installer installs and upgrades verified releases", () => {
  const root = mkdtempSync(join(tmpdir(), "hibro-node-installer-"));
  const firstAssets = makeRelease(root, "1.0.0");
  const install = runInstaller(root, firstAssets, [
    "install",
    "--mode",
    "docker",
    "--version",
    "v1.0.0",
    "--project-root",
    root,
  ]);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /1\.0\.0 已安装完成/);

  const secondAssets = makeRelease(root, "1.1.0");
  const update = runInstaller(root, secondAssets, [
    "update",
    "--version",
    "v1.1.0",
  ]);
  assert.equal(update.status, 0, update.stderr);
  assert.match(update.stdout, /1\.1\.0 已安装完成/);
  assert.equal(
    readFileSync(join(root, "installed-source", "current", "VERSION"), "utf8"),
    "1.1.0\n",
  );
  assert.match(
    readFileSync(join(root, "installer-state", "hibro-node.env"), "utf8"),
    /VERSION=1\.1\.0/,
  );
  assert.match(readFileSync(join(root, "setup.log"), "utf8"), /--mode docker/);
});

test("Node remote installer rejects an invalid release checksum", () => {
  const root = mkdtempSync(join(tmpdir(), "hibro-node-checksum-"));
  const assets = makeRelease(root, "2.0.0", false);
  const result = runInstaller(root, assets, [
    "install",
    "--mode",
    "docker",
    "--version",
    "v2.0.0",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SHA-256 不匹配/);
});

test("failed Native update restores the previous Node source and runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "hibro-node-rollback-"));
  const firstAssets = makeRelease(root, "3.0.0");
  const nativeRoot = join(root, "native");
  const nativePrevious = join(nativeRoot, "releases", "3.0.0");
  mkdirSync(nativePrevious, { recursive: true });
  writeFileSync(join(nativePrevious, "VERSION"), "3.0.0\n");
  const install = runInstaller(
    root,
    firstAssets,
    ["install", "--mode", "native", "--version", "v3.0.0"],
    {
      HIBRO_NATIVE_INSTALL_DIR: nativeRoot,
      HIBRO_NATIVE_SKIP_SYSTEMD: "true",
    },
  );
  assert.equal(install.status, 0, install.stderr);
  spawnSync("ln", ["-sfn", nativePrevious, join(nativeRoot, "current")]);

  const failingAssets = makeRelease(root, "3.1.0", true, true);
  const update = runInstaller(
    root,
    failingAssets,
    ["update", "--mode", "native", "--version", "v3.1.0"],
    {
      HIBRO_NATIVE_INSTALL_DIR: nativeRoot,
      HIBRO_NATIVE_SKIP_SYSTEMD: "true",
    },
  );
  assert.notEqual(update.status, 0);
  assert.equal(
    readFileSync(join(root, "installed-source", "current", "VERSION"), "utf8"),
    "3.0.0\n",
  );
  assert.equal(
    readFileSync(join(nativeRoot, "current", "VERSION"), "utf8"),
    "3.0.0\n",
  );
});
