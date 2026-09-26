import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const guardPath = path.resolve(sourceDirectory, "../src/cli-guard.mjs");
const standaloneWrapperPath = path.resolve(
  sourceDirectory,
  "../bin/codex-standalone",
);

async function runGuard(args, env) {
  try {
    const result = await execFileAsync(process.execPath, [guardPath, ...args], { env });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

async function writeFakeCodex(directory) {
  const executable = path.join(directory, "fake-codex");
  await fs.writeFile(
    executable,
    [
      "#!/bin/sh",
      'printf \'args=%s\\n\' "$*"',
      'printf \'install=%s\\n\' "${CODEX_INSTALL_DIR-}"',
      'printf \'path=%s\\n\' "$PATH"',
      'printf \'entrypoint=%s\\n\' "${CODEX_BRIDGE_STANDALONE_ENTRYPOINT-unset}"',
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o755 },
  );
  return executable;
}

test("共享 App Server 不存在时阻止普通 Codex 启动", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "guard-test-"));
  try {
    const result = await runGuard(["hello"], {
      ...process.env,
      CODEX_BRIDGE_STATE_DIR: temporaryDirectory,
      CODEX_BRIDGE_RESOURCE_PATH: "/nonexistent/resource-codex",
    });
    assert.equal(result.code, 69);
    assert.match(result.stderr, /只使用 ChatGPT Desktop/u);
    assert.match(result.stderr, /codex-standalone/u);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("阻止从受保护入口直接启动第二个 App Server", async () => {
  const result = await runGuard(["app-server"], process.env);
  assert.equal(result.code, 69);
  assert.match(result.stderr, /已阻止/u);
});

test("普通调用者不能借 Computer Use 的 stdio 参数绕过限制", async () => {
  const result = await runGuard(["app-server", "--listen", "stdio://"], process.env);
  assert.equal(result.code, 69);
  assert.match(result.stderr, /已阻止/u);
});

test("Remote SSH proxy 在共享 App Server 不存在时失败关闭", async () => {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "proxy-guard-test-"));
  try {
    const result = await runGuard(["app-server", "proxy"], {
      ...process.env,
      CODEX_BRIDGE_STATE_DIR: temporaryDirectory,
      CODEX_BRIDGE_RESOURCE_PATH: "/nonexistent/resource-codex",
    });
    assert.equal(result.code, 69);
    assert.match(result.stderr, /请先启动或重新启动 ChatGPT Desktop/u);
    assert.doesNotMatch(result.stderr, /已阻止/u);
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test("codex update 使用 standalone 探测并隔离安装入口", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "update-routing-test-"),
  );
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const standalonePath = await writeFakeCodex(temporaryDirectory);
  const installRoot = path.join(temporaryDirectory, "bridge");
  const standaloneInstallDirectory = path.join(installRoot, "standalone-bin");

  const result = await runGuard(["--config", "foo=bar", "update"], {
    ...process.env,
    CODEX_BRIDGE_INSTALL_ROOT: installRoot,
    CODEX_BRIDGE_RESOURCE_PATH: "/nonexistent/resource-codex",
    CODEX_INSTALL_DIR: "/protected/bridge/bin",
    CODEX_STANDALONE_PATH: standalonePath,
    PATH: "/usr/bin:/bin",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /args=--config foo=bar update/u);
  const outputLines = result.stdout.trim().split("\n");
  assert.ok(outputLines.includes(`install=${standaloneInstallDirectory}`));
  assert.equal(
    outputLines.find((line) => line.startsWith("path="))?.split(path.delimiter)[0],
    `path=${standaloneInstallDirectory}`,
  );
  assert.match(result.stdout, /entrypoint=unset/u);
});

test("codex-standalone update 也不覆盖 bridge 入口", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "standalone-update-routing-test-"),
  );
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const standalonePath = await writeFakeCodex(temporaryDirectory);
  const installRoot = path.join(temporaryDirectory, "bridge");
  const standaloneInstallDirectory = path.join(installRoot, "standalone-bin");

  const result = await execFileAsync(standaloneWrapperPath, ["update"], {
    env: {
      ...process.env,
      CODEX_BRIDGE_INSTALL_ROOT: installRoot,
      CODEX_BRIDGE_NODE_PATH: process.execPath,
      CODEX_INSTALL_DIR: "/protected/bridge/bin",
      CODEX_STANDALONE_PATH: standalonePath,
      PATH: "/usr/bin:/bin",
    },
  });

  assert.match(result.stdout, /args=update/u);
  const outputLines = result.stdout.trim().split("\n");
  assert.ok(outputLines.includes(`install=${standaloneInstallDirectory}`));
  assert.equal(
    outputLines.find((line) => line.startsWith("path="))?.split(path.delimiter)[0],
    `path=${standaloneInstallDirectory}`,
  );
  assert.match(result.stdout, /entrypoint=unset/u);
});
