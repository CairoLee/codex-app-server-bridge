import test from "node:test";
import assert from "node:assert/strict";
import { sharedRemoteInvocationArgs } from "../src/cli-invocation.mjs";

const socketPath = "/Users/test/.codex/codex-app-server-bridge/app-server.sock";
const cwd = "/Users/test/Project With Spaces";

function remoteArgs(args, command = null) {
  return sharedRemoteInvocationArgs({ args, command, cwd, socketPath });
}

test("新建 Remote TUI 显式传递调用端工作目录", () => {
  assert.deepEqual(remoteArgs([]), [
    "--remote",
    `unix://${socketPath}`,
    "--cd",
    cwd,
  ]);
  assert.deepEqual(remoteArgs(["修复当前问题"]), [
    "--remote",
    `unix://${socketPath}`,
    "--cd",
    cwd,
    "修复当前问题",
  ]);
});

test("新建 Remote TUI 保留用户显式指定的工作目录", () => {
  for (const args of [
    ["-C", "/Users/test/other"],
    ["--cd", "/Users/test/other"],
    ["-C=/Users/test/other"],
    ["--cd=/Users/test/other"],
  ]) {
    assert.deepEqual(remoteArgs(args), [
      "--remote",
      `unix://${socketPath}`,
      ...args,
    ]);
  }
});

test("双横线后的文本不被误判为工作目录参数", () => {
  assert.deepEqual(remoteArgs(["--", "-C", "只是提示文本"]), [
    "--remote",
    `unix://${socketPath}`,
    "--cd",
    cwd,
    "--",
    "-C",
    "只是提示文本",
  ]);
});

test("恢复和分叉命令保留 Codex 原生目录选择语义", () => {
  for (const command of ["resume", "fork"]) {
    const args = [command, "--last"];
    assert.deepEqual(remoteArgs(args, command), [
      "--remote",
      `unix://${socketPath}`,
      ...args,
    ]);
  }
});
