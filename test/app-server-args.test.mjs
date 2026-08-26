import test from "node:test";
import assert from "node:assert/strict";
import {
  isAppServerRunInvocation,
  withUnixSocketTransport,
} from "../src/app-server-args.mjs";

test("识别桌面端 App Server 主进程启动", () => {
  assert.equal(
    isAppServerRunInvocation([
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
      "-c",
      "mcp_servers.codex_app={enabled=true}",
    ]),
    true,
  );
  assert.equal(isAppServerRunInvocation(["app-server", "daemon", "version"]), false);
  assert.equal(isAppServerRunInvocation(["--version"]), false);
});

test("Unix socket 传输替换 stdio 或已有 listen 参数", () => {
  assert.deepEqual(
    withUnixSocketTransport(
      ["app-server", "--stdio", "-c", "x=true", "--listen=stdio://"],
      "/tmp/shared.sock",
    ),
    ["app-server", "-c", "x=true", "--listen", "unix:///tmp/shared.sock"],
  );
});
