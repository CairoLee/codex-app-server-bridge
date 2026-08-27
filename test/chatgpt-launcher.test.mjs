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
