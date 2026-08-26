import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  installationMessage,
  uninstallationMessage,
  writeOperationLog,
} from "../scripts/lib/operation-report.mjs";

test("操作明细写入用户状态目录的私有日志", async (context) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "operation-log-test-"));
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const receiptPath = path.join(homeDirectory, ".local", "state", "tool", "receipt.json");
  const now = new Date("2026-08-26T08:00:00.000Z");

  const logPath = await writeOperationLog({
    operation: "uninst",
    details: { ok: true, changed: true, technical: { files: ["one"] } },
    receiptPath,
    now,
  });
  const logged = JSON.parse(await fs.readFile(logPath, "utf8"));
  const metadata = await fs.stat(logPath);

  assert.equal(path.dirname(logPath), path.join(path.dirname(receiptPath), "logs"));
  assert.match(path.basename(logPath), /^2026-08-26T08-00-00-000Z-uninst-/u);
  assert.equal(metadata.mode & 0o077, 0);
  assert.deepEqual(logged.technical.files, ["one"]);
  assert.equal(logged.completedAt, now.toISOString());
});

test("终端摘要隐藏技术 JSON 并给出清晰下一步", () => {
  const logPath = "/Users/test/.local/state/tool/logs/detail.json";
  const installed = installationMessage({ logPath });
  const removed = uninstallationMessage({
    alreadyUninstalled: false,
    entrypointRestored: true,
    logPath,
  });
  const repeated = uninstallationMessage({
    alreadyUninstalled: true,
    entrypointRestored: false,
    logPath,
  });

  assert.match(installed, /安装完成/u);
  assert.match(installed, /codex-bridge status/u);
  assert.match(removed, /standalone/u);
  assert.match(repeated, /已经是未安装状态/u);
  for (const message of [installed, removed, repeated]) {
    assert.doesNotMatch(message, /"changedFiles"|\{\s*"ok"/u);
    assert.match(message, /详细记录/u);
  }
});
