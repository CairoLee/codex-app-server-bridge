import test from "node:test";
import assert from "node:assert/strict";
import { isComputerUseHelper } from "../src/computer-use-helper.mjs";

const args = ["app-server", "--listen", "stdio://"];
const executable = "/Users/test/.codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService";
function options(overrides = {}) {
  return {
    platform: "darwin", parentPid: 123, homeDirectory: "/Users/test",
    getParentExecutable: async () => executable,
    verifyExecutable: async (file) => assert.equal(file, executable),
    ...overrides,
  };
}

test("精确 stdio 请求通过父进程路径和签名核验才放行", async () => {
  let reads = 0;
  let verified = false;
  assert.equal(await isComputerUseHelper(args, options({
    getParentExecutable: async (pid) => { assert.equal(pid, 123); reads++; return executable; },
    verifyExecutable: async (file) => { assert.equal(file, executable); verified = true; },
  })), true);
  assert.equal(reads, 2);
  assert.equal(verified, true);
});

test("其他 listener、额外配置、proxy 和普通 app-server 不进入身份检查", async () => {
  for (const input of [
    ["app-server"], ["app-server", "proxy"],
    ["app-server", "--listen", "unix:///tmp/other.sock"],
    ["app-server", "--listen", "ws://127.0.0.1:9999"],
    [...args, "-c", "features.foo=true"],
    ["app-server", "--listen=stdio://"],
  ]) {
    assert.equal(await isComputerUseHelper(input, options({
      getParentExecutable: async () => assert.fail("不应检查父进程"),
    })), false);
  }
});

test("来源不匹配、签名失败、进程消失和无法读取时保持拒绝", async () => {
  for (const overrides of [
    { getParentExecutable: async () => "/usr/bin/zsh" },
    { getParentExecutable: async () => `${executable} --spoof` },
    { verifyExecutable: async () => { throw new Error("signature mismatch"); } },
    { getParentExecutable: async () => { throw new Error("EPERM"); } },
    { platform: "linux" }, { parentPid: 0 },
  ]) assert.equal(await isComputerUseHelper(args, options(overrides)), false);
  let reads = 0;
  assert.equal(await isComputerUseHelper(args, options({
    getParentExecutable: async () => ++reads === 1 ? executable : "",
  })), false);
});
