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

async function runGuard(args, env) {
  try {
    const result = await execFileAsync(process.execPath, [guardPath, ...args], { env });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
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
