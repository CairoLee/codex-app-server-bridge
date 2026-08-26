import test from "node:test";
import assert from "node:assert/strict";
import {
  friendlyFailureReason,
  healthyStatusMessage,
  unhealthyStatusMessage,
} from "../src/status-presentation.mjs";

const healthyStatus = {
  ok: true,
  state: {
    ownerPid: 101,
    supervisorPid: 102,
    serverPid: 103,
    socketPath: "/Users/test/.codex/codex-app-server-bridge/app-server.sock",
    resourceCodexPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
  },
  serverInfo: {
    userAgent: "Codex Desktop/0.150.0-alpha.8 (Mac OS; arm64)",
  },
};

test("默认状态只显示用户关心的健康结论", () => {
  const message = healthyStatusMessage(healthyStatus);

  assert.match(message, /运行正常/u);
  assert.match(message, /同一组会话/u);
  assert.match(message, /0\.150\.0-alpha\.8/u);
  assert.doesNotMatch(message, /PID|Socket|resourceCodexPath|\{\s*"ok"/u);
});

test("verbose 状态补充排障信息", () => {
  const message = healthyStatusMessage(healthyStatus, { verbose: true });

  assert.match(message, /ChatGPT Desktop PID：101/u);
  assert.match(message, /App Server PID：103/u);
  assert.match(message, /Socket：/u);
  assert.match(message, /\/Applications\/ChatGPT\.app\/Contents\/Resources\/codex/u);
});

test("不可用原因转换成用户可理解的提示", () => {
  assert.equal(
    friendlyFailureReason("state file is missing"),
    "尚未发现共享服务。请确认已经完成安装，并启动 ChatGPT Desktop。",
  );
  assert.equal(
    friendlyFailureReason("App Server probe failed: timeout"),
    "共享 Codex App Server 暂时无法连接。",
  );

  const normal = unhealthyStatusMessage({ ok: false, reason: "App Server probe failed: timeout" });
  const verbose = unhealthyStatusMessage(
    { ok: false, reason: "App Server probe failed: timeout" },
    { verbose: true },
  );
  assert.match(normal, /完全退出并重新启动/u);
  assert.doesNotMatch(normal, /probe failed/u);
  assert.match(verbose, /内部原因：App Server probe failed: timeout/u);
});
