import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  armLauncherDiagnostics,
  clearLauncherDiagnostics,
  diagnosticEnvironmentNames,
  disableLauncherDiagnostics,
  readLauncherDiagnostics,
  recordLauncherInvocation,
  sanitizeLauncherArguments,
} from "../src/launcher-diagnostics.mjs";

async function diagnosticEnvironment(context) {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "launcher-diagnostics-test-"),
  );
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return {
    CODEX_BRIDGE_DIAGNOSTICS_DIR: path.join(directory, "trace"),
    CODEX_BRIDGE_STATE_DIR: path.join(directory, "state"),
  };
}

test("启动参数只保留调用形态并脱敏配置和值参数", () => {
  assert.deepEqual(
    sanitizeLauncherArguments([
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--listen",
      "unix:///private/path.sock",
      "--analytics-default-enabled",
      "--label=private-value",
      "/Users/test/private-file",
    ]),
    [
      "-c",
      "features.code_mode_host=<redacted>",
      "app-server",
      "--listen",
      "<redacted>",
      "--analytics-default-enabled",
      "--label=<redacted>",
      "<redacted>",
    ],
  );
});

test("环境记录只包含诊断相关且不疑似敏感的变量名称", () => {
  assert.deepEqual(
    diagnosticEnvironmentNames({
      CODEX_CLI_PATH: "/private/launcher",
      CODEX_API_KEY: "secret",
      BROWSER_SESSION_TOKEN: "secret",
      ELECTRON_RUN_AS_NODE: "1",
      PATH: "/bin",
    }),
    ["CODEX_CLI_PATH", "ELECTRON_RUN_AS_NODE"],
  );
});

test("显式启用后生成私有、有界且脱敏的调用记录", async (context) => {
  const env = await diagnosticEnvironment(context);
  const armedAt = new Date("2026-08-27T10:00:00.000Z");
  const armed = await armLauncherDiagnostics({
    env,
    now: armedAt,
    durationMs: 60_000,
    maxRecords: 1,
  });
  const configMode = (await fs.stat(armed.configPath)).mode & 0o077;
  const first = await recordLauncherInvocation({
    env: {
      ...env,
      CODEX_BRIDGE_OWNER_PID: "42",
      CODEX_CLI_PATH: "/private/launcher",
      CODEX_API_KEY: "secret",
    },
    args: ["-c", "private.setting=secret", "app-server"],
    now: new Date("2026-08-27T10:00:10.000Z"),
    pid: 100,
    ppid: 42,
    cwd: "/Users/test/project-name",
    execPath: "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node",
  });
  const second = await recordLauncherInvocation({
    env,
    args: ["app-server"],
    now: new Date("2026-08-27T10:00:20.000Z"),
  });
  const read = await readLauncherDiagnostics({ env });
  const directoryMode = (await fs.stat(armed.directory)).mode & 0o077;
  const traceMode = (await fs.stat(armed.tracePath)).mode & 0o077;

  assert.equal(first.recorded, true);
  assert.equal(second.recorded, false);
  assert.equal(second.reason, "record limit reached");
  assert.equal(directoryMode, 0);
  assert.equal(configMode, 0);
  assert.equal(traceMode, 0);
  assert.equal(read.config, null);
  assert.equal(read.records.length, 1);
  assert.deepEqual(read.records[0].arguments, [
    "-c",
    "private.setting=<redacted>",
    "app-server",
  ]);
  assert.equal(read.records[0].parentMatchesConfiguredOwner, true);
  assert.equal(read.records[0].cwdName, "project-name");
  assert.ok(read.records[0].environmentNames.includes("CODEX_CLI_PATH"));
  assert.ok(!read.records[0].environmentNames.includes("CODEX_API_KEY"));
  assert.doesNotMatch(await fs.readFile(armed.tracePath, "utf8"), /secret/u);
});

test("默认关闭，过期后自动移除配置开关", async (context) => {
  const env = await diagnosticEnvironment(context);
  const unarmed = await recordLauncherInvocation({ env });
  const armed = await armLauncherDiagnostics({
    env,
    now: new Date("2026-08-27T10:00:00.000Z"),
    durationMs: 1_000,
  });
  const expired = await recordLauncherInvocation({
    env,
    now: new Date("2026-08-27T10:00:02.000Z"),
  });
  const read = await readLauncherDiagnostics({ env });

  assert.equal(unarmed.reason, "disabled");
  assert.equal(expired.reason, "expired");
  assert.equal(read.config, null);
  assert.deepEqual(read.records, []);
  await assert.rejects(fs.access(armed.configPath));
});

test("关闭开关保留记录，清理命令再删除记录", async (context) => {
  const env = await diagnosticEnvironment(context);
  const armed = await armLauncherDiagnostics({ env });
  await recordLauncherInvocation({ env, args: ["app-server"] });

  const disabled = await disableLauncherDiagnostics({ env });
  const preserved = await readLauncherDiagnostics({ env });
  assert.equal(preserved.config, null);
  assert.equal(preserved.records.length, 1);
  assert.equal(disabled.directory, env.CODEX_BRIDGE_DIAGNOSTICS_DIR);

  await clearLauncherDiagnostics({ env });
  const cleared = await readLauncherDiagnostics({ env });
  assert.deepEqual(cleared.records, []);
  await assert.rejects(fs.access(armed.tracePath));
});

test("拒绝使用指向其他位置的诊断目录 symlink", async (context) => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "launcher-diagnostics-symlink-test-"),
  );
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const actual = path.join(root, "actual");
  const link = path.join(root, "link");
  const env = {
    CODEX_BRIDGE_DIAGNOSTICS_DIR: link,
    CODEX_BRIDGE_STATE_DIR: path.join(root, "state"),
  };
  await fs.mkdir(actual);
  await fs.symlink(actual, link);

  await assert.rejects(
    armLauncherDiagnostics({
      env,
    }),
    /not a regular directory/u,
  );
  await assert.rejects(
    readLauncherDiagnostics({
      env,
    }),
    /not a regular directory/u,
  );
});
