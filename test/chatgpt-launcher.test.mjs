import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  armLauncherDiagnostics,
  disableLauncherDiagnostics,
  readLauncherDiagnostics,
} from "../src/launcher-diagnostics.mjs";

const execFileAsync = promisify(execFile);
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const launcherPath = path.resolve(sourceDirectory, "../src/chatgpt-launcher.mjs");
const launcherWrapperPath = path.resolve(
  sourceDirectory,
  "../bin/codex-bridge-launcher",
);

test("Launcher 默认不加载诊断，配置文件存在时才记录", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "launcher-diagnostics-switch-"),
  );
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    HOME: temporaryDirectory,
    CODEX_HOME: path.join(temporaryDirectory, "codex-home"),
    CODEX_BRIDGE_STATE_DIR: path.join(temporaryDirectory, "state"),
    CODEX_BRIDGE_DIAGNOSTICS_DIR: path.join(temporaryDirectory, "trace"),
    CODEX_BRIDGE_LAUNCHER_DIAGNOSTICS: "",
    CODEX_BRIDGE_NODE_PATH: process.execPath,
    CODEX_BRIDGE_RESOURCE_PATH: "/usr/bin/true",
  };

  await execFileAsync(launcherWrapperPath, ["--version"], { env });
  const disabled = await readLauncherDiagnostics({ env });
  assert.equal(disabled.config, null);
  assert.deepEqual(disabled.records, []);

  await armLauncherDiagnostics({ env });
  await execFileAsync(launcherWrapperPath, ["--version"], { env });
  const enabled = await readLauncherDiagnostics({ env });
  assert.equal(enabled.config?.enabled, true);
  assert.equal(enabled.records.length, 1);
  assert.deepEqual(enabled.records[0].arguments, ["--version"]);

  await disableLauncherDiagnostics({ env });
  await execFileAsync(launcherWrapperPath, ["--version"], { env });
  const disabledAgain = await readLauncherDiagnostics({ env });
  assert.equal(disabledAgain.config, null);
  assert.equal(disabledAgain.records.length, 1);
});

test("Browser helper 的显式 listener 直接使用 Resources/codex", async () => {
  const { stderr } = await execFileAsync(
    process.execPath,
    [launcherPath, "app-server", "--listen", "/tmp/browser-helper.sock"],
    {
      env: {
        ...process.env,
        CODEX_BRIDGE_RESOURCE_PATH: "/usr/bin/true",
        CODEX_BRIDGE_SOCKET: "/tmp/connectable-shared-server.sock",
        CODEX_APP_TOOLS_PIPE_PATH: "",
      },
    },
  );

  assert.equal(stderr, "");
});

test(
  "旧版 Browser 形态在共享 socket 权限拒绝时改用 Resources/codex",
  { skip: process.platform !== "darwin" },
  async () => {
    const { stderr } = await execFileAsync(
      process.execPath,
      [launcherPath, "app-server"],
      {
        env: {
          ...process.env,
          CODEX_BRIDGE_RESOURCE_PATH: "/usr/bin/true",
          CODEX_BRIDGE_SOCKET: "/var/root/codex-app-server-bridge-test.sock",
        },
      },
    );

    assert.match(stderr, /无权连接共享 App Server/u);
  },
);

test("日常日志关联 launcher 和子进程，并解释显式 listener 跳过原因", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-runtime-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  const env = {
    ...process.env,
    CODEX_BRIDGE_STATE_DIR: directory,
    CODEX_BRIDGE_RUNTIME_LOG: "1",
    CODEX_BRIDGE_RESOURCE_PATH: "/usr/bin/true",
  };
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    launcherPath, "app-server", "--listen", "secret-endpoint",
  ], { env });
  assert.equal(stdout, "");
  assert.equal(stderr, "");
  const logsDirectory = path.join(directory, "runtime-logs");
  const names = await fs.readdir(logsDirectory);
  const text = await fs.readFile(path.join(logsDirectory, names[0]), "utf8");
  assert.ok(!text.includes("secret-endpoint"));
  const records = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(records.some((record) => record.reason === "explicit-listener"));
  const started = records.find((record) => record.event === "child.started");
  const exited = records.find((record) => record.event === "child.exited");
  assert.ok(started.pid > 0);
  assert.ok(started.ppid > 0);
  assert.ok(started.childPid > 0);
  assert.equal(exited.childPid, started.childPid);
  assert.equal(exited.code, 0);
});

test("关闭日常日志时 launcher 不创建日志目录", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "launcher-no-runtime-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await execFileAsync(process.execPath, [launcherPath, "--version"], {
    env: {
      ...process.env,
      CODEX_BRIDGE_STATE_DIR: directory,
      CODEX_BRIDGE_RUNTIME_LOG: "0",
      CODEX_BRIDGE_RESOURCE_PATH: "/usr/bin/true",
    },
  });
  await assert.rejects(fs.stat(path.join(directory, "runtime-logs")), { code: "ENOENT" });
});
