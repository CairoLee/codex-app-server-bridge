import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const commandPath = path.resolve(sourceDirectory, "../bin/codex-bridge");

test("统一命令显示面向用户的子命令帮助", async () => {
  const { stdout } = await execFileAsync("/bin/zsh", [commandPath, "help"]);

  assert.match(stdout, /Codex App Server Bridge/u);
  for (const subcommand of ["status", "inst", "uninst", "logs"]) {
    assert.match(stdout, new RegExp(`\\b${subcommand}\\b`, "u"));
  }
});

test("统一命令拒绝未知子命令并提示帮助", async () => {
  await assert.rejects(
    execFileAsync("/bin/zsh", [commandPath, "unknown"]),
    (error) => {
      assert.equal(error.code, 78);
      assert.match(error.stderr, /codex-bridge help/u);
      return true;
    },
  );
});
