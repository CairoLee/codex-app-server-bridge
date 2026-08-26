import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  operationLogsMessage,
  recentOperationLogs,
} from "../src/logs-support.mjs";

test("操作日志按时间倒序列出并忽略非 JSON 文件", async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "codex-bridge-logs-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "2026-08-26T08-00-inst.json"), "{}\n");
  await fs.writeFile(path.join(directory, "2026-08-26T09-00-uninst.json"), "{}\n");
  await fs.writeFile(path.join(directory, "notes.txt"), "ignore\n");

  const files = await recentOperationLogs(directory);

  assert.deepEqual(files.map((file) => path.basename(file)), [
    "2026-08-26T09-00-uninst.json",
    "2026-08-26T08-00-inst.json",
  ]);
});

test("没有日志时显示友好提示", () => {
  const message = operationLogsMessage({
    logsDirectory: "/Users/test/.local/state/codex-app-server-bridge/logs",
    files: [],
    displayPath: (value) => value,
  });

  assert.match(message, /暂时没有操作日志/u);
  assert.doesNotMatch(message, /\{\s*"/u);
});
