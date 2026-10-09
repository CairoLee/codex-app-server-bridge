import assert from "node:assert/strict";
import test from "node:test";
import { createRpcDiagnostics } from "../src/rpc-diagnostics.mjs";

function fixture() {
  let time = 0;
  const events = [];
  const diagnostics = createRpcDiagnostics({
    log: { event: (event, fields) => events.push({ event, ...structuredClone(fields) }) },
    now: () => time,
    schedule: false,
  });
  return {
    events, diagnostics,
    at(value) { time = value; },
    client(message) { diagnostics.observe("client", JSON.stringify(message)); },
    server(message) { diagnostics.observe("server", JSON.stringify(message)); },
  };
}

test("失败响应关联原请求并仅记录插件参数形态和安全错误分类", () => {
  const f = fixture();
  f.client({ id: "secret-request-id", method: "plugin/read", params: {
    pluginName: "private-plugin@private-marketplace", marketplacePath: "/private/secret-path",
    remoteMarketplaceName: "secret-marketplace", threadId: "secret-thread-id",
    token: "secret-token", config: { password: "secret-password" }, input: "secret-prompt",
  } });
  f.at(125);
  f.server({ id: "secret-request-id", error: {
    code: -32600, message: "invalid remote plugin id: secret-token",
    data: { statusCode: 403, body: "secret-body" },
  } });
  f.diagnostics.close("stdin-eof");
  const failure = f.events.find((e) => e.event === "rpc.failed");
  assert.equal(failure.method, "plugin/read");
  assert.equal(failure.requestRef, "c1");
  assert.equal(failure.durationMs, 125);
  assert.equal(failure.code, -32600);
  assert.equal(failure.statusCode, 403);
  assert.equal(failure.kind, "invalid-plugin-id");
  assert.equal(failure.pluginNameKind, "qualified-name");
  assert.equal(failure.marketplaceSource, "both");
  assert.match(failure.threadRef, /^[0-9a-f]{16}$/u);
  assert.doesNotMatch(JSON.stringify(f.events), /secret-|private-plugin|private-marketplace|\/private\//u);
});

test("匿名会话标记在同连接内稳定，跨连接不同", () => {
  const refs = [];
  for (let index = 0; index < 2; index += 1) {
    const f = fixture();
    for (const id of [1, 2]) {
      f.client({ id, method: "thread/read", params: { threadId: "same-thread" } });
      f.server({ id, error: { code: -32600, message: "thread access denied" } });
    }
    assert.equal(f.events[0].threadRef, f.events[1].threadRef);
    refs.push(f.events[0].threadRef);
    f.diagnostics.close("stdin-eof");
  }
  assert.notEqual(refs[0], refs[1]);
});

test("双向请求同 ID 以及数字与字符串 ID 不串线", () => {
  const f = fixture();
  f.client({ id: 1, method: "config/read", params: { cwd: "/private/cwd" } });
  f.server({ id: 1, method: "private/custom-secret-method", params: {} });
  f.client({ id: "1", method: "fs/readFile", params: {} });
  f.client({ id: 1, error: { code: -1, message: "client-secret" } });
  f.server({ id: "1", error: { code: -32600, message: "fs/readFile requires an environmentId" } });
  f.server({ id: 1, error: { code: -32000, message: "No such file or directory /private/cwd" } });
  assert.deepEqual(f.events.map((e) => [e.direction, e.method, e.kind]), [
    ["server", "other", "other"],
    ["client", "fs/readFile", "environment-id-required"],
    ["client", "config/read", "not-found"],
  ]);
  assert.equal(f.events[1].environmentIdPresent, false);
  assert.equal(f.events[2].cwdPresent, true);
  assert.doesNotMatch(JSON.stringify(f.events), /private|client-secret/u);
  f.diagnostics.close("stdin-eof");
});

test("长时间待决只提示一次，后续慢响应保持同一关联标记", () => {
  const f = fixture();
  f.client({ id: 42, method: "configRequirements/read" });
  f.at(30_000);
  f.diagnostics.sweep();
  f.at(35_000);
  f.diagnostics.sweep();
  f.at(40_000);
  f.server({ id: 42, result: { secret: "not-logged" } });
  f.diagnostics.close("stdin-eof");
  const pending = f.events.filter((e) => e.event === "rpc.pending");
  const slow = f.events.find((e) => e.event === "rpc.slow");
  assert.equal(pending.length, 1);
  assert.equal(pending[0].ageMs, 30_000);
  assert.equal(slow.durationMs, 40_000);
  assert.equal(slow.requestRef, pending[0].requestRef);
  assert.ok(!f.events.some((e) => e.event === "rpc.failed" || e.event === "rpc.interrupted"));
});

test("断线只报告未收到响应的请求，样本最多八条", () => {
  const f = fixture();
  for (let id = 0; id < 12; id += 1) f.client({ id, method: "thread/read" });
  f.server({ id: 0, result: {} });
  f.at(1_000);
  f.diagnostics.close("peer-close");
  const event = f.events.find((e) => e.event === "rpc.interrupted");
  assert.equal(event.pendingCount, 11);
  assert.equal(event.sample.length, 8);
  assert.equal(event.sample[0].requestRef, "c2");
  assert.equal(event.sample[0].ageMs, 1_000);
  assert.equal(event.reason, "peer-close");
  const count = f.events.length;
  f.diagnostics.close("error");
  f.client({ id: 44, method: "thread/read" });
  assert.equal(f.events.length, count);
});

test("待决记录区分已观察和已提交传输的请求", () => {
  const f = fixture();
  const first = f.diagnostics.observe("client", JSON.stringify({ id: 1, method: "config/read" }));
  f.client({ id: 2, method: "plugin/read" });
  f.diagnostics.forwarded(first);
  f.diagnostics.close("error");
  const sample = f.events.find((e) => e.event === "rpc.interrupted").sample;
  assert.deepEqual(sample.map((r) => [r.method, r.forwarding]), [
    ["config/read", "submitted"], ["plugin/read", "observed"],
  ]);
});

test("观察状态有容量和存活时间限制，淘汰不冒充请求失败", () => {
  const f = fixture();
  for (let id = 0; id < 300; id += 1) f.client({ id, method: "thread/read" });
  f.at(600_000);
  f.diagnostics.sweep();
  f.diagnostics.close("stdin-eof");
  const summaries = f.events.filter((e) => e.event === "rpc.summary");
  assert.equal(summaries[0].evictedTracking, 44);
  assert.equal(summaries[0].pendingCount, 256);
  assert.equal(summaries[1].expiredTracking, 256);
  assert.equal(summaries[1].pendingCount, 0);
  assert.ok(!f.events.some((e) => e.event === "rpc.failed" || e.event === "rpc.interrupted"));
});

test("错误风暴限速但保留分类总数，重复告警按分钟汇总", () => {
  const f = fixture();
  for (let id = 0; id < 100; id += 1) {
    f.client({ id, method: "thread/read" });
    f.server({ id, error: { code: -1, message: "thread access denied" } });
    f.server({ method: "configWarning", params: { summary: "session-flags: features.code_mode_tool_description_first is ignored. secret-text" } });
  }
  f.at(60_000);
  f.diagnostics.sweep();
  assert.equal(f.events.filter((e) => e.event === "rpc.failed").length, 32);
  const summary = f.events.find((e) => e.event === "rpc.summary");
  assert.equal(summary.failedResponses, 100);
  assert.equal(summary.suppressedEvents, 68);
  assert.equal(summary.failures["thread/read:access-denied"], 100);
  assert.equal(summary.warnings["configWarning:unsupported-feature"], 100);
  assert.doesNotMatch(JSON.stringify(f.events), /secret-text/u);
  f.diagnostics.close("stdin-eof");
});

test("超大消息丢失观察覆盖时重置待决状态，不制造超时或断线误报", () => {
  const f = fixture();
  f.client({ id: 1, method: "fs/readFile" });
  const large = JSON.stringify({ id: 1, result: { text: "s".repeat(300_000) } });
  f.diagnostics.observe("server", large);
  f.at(31_000);
  f.diagnostics.sweep();
  f.diagnostics.observe("server", "invalid-private-json");
  f.diagnostics.observe("server", "[]");
  f.diagnostics.close("peer-close");
  assert.deepEqual(f.events.map((e) => e.event), ["rpc.summary"]);
  assert.equal(f.events[0].coverageLostRequests, 1);
  assert.equal(f.events[0].oversizedMessages, 1);
  assert.equal(f.events[0].invalidJson, 1);
  assert.equal(f.events[0].unsupportedEnvelopes, 1);
  assert.doesNotMatch(JSON.stringify(f.events), /private-json|ssssss/u);
});

test("未知错误正文及非数字错误码不落盘，未关联响应明确标为 unknown", () => {
  const f = fixture();
  f.server({ id: "secret-orphan-id", error: {
    code: "secret-code", message: "secret-error", data: { statusCode: "secret-status" },
  } });
  assert.equal(f.events[0].method, "unknown");
  assert.equal(f.events[0].kind, "other");
  assert.equal(f.events[0].code, undefined);
  assert.equal(f.events[0].statusCode, undefined);
  assert.doesNotMatch(JSON.stringify(f.events), /secret-/u);
  f.diagnostics.close("error");
});

test("日志关闭时不解析消息或创建观察状态，日志异常不影响调用", () => {
  const off = createRpcDiagnostics({ log: { enabled: false }, now: () => { throw Error("should not run"); } });
  assert.doesNotThrow(() => {
    off.observe("client", "anything"); off.sweep(); off.close("error");
  });
  const bad = createRpcDiagnostics({ log: { event() { throw Error("disk failure"); } }, schedule: false });
  assert.doesNotThrow(() => {
    bad.observe("client", JSON.stringify({ id: 1, method: "thread/read" }));
    bad.observe("server", JSON.stringify({ id: 1, error: { code: -1, message: "error" } }));
    bad.close("error");
  });
});
