import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Readable, Writable } from "node:stream";
import test from "node:test";
import { bridgeStdioToAppServer } from "../src/stdio-bridge.mjs";

class FakeWebSocket extends EventEmitter {
  sent = [];
  destroyedWith = null;

  async sendText(text) {
    this.sent.push(text);
  }

  async close() {
    this.emit("close");
  }

  destroy(error) {
    this.destroyedWith = error;
    if (error) setImmediate(() => this.emit("error", error));
  }
}

async function capturedOutput() {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { text += chunk; });
  return { output, text: () => text };
}

test("保留多行、CRLF、末行和服务端消息原文", async () => {
  const websocket = new FakeWebSocket();
  const { output, text } = await capturedOutput();
  const input = new PassThrough();
  const bridge = bridgeStdioToAppServer("unused", {
    input,
    output,
    connect: async () => websocket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  input.write("first\r\n\r\nsecond\n");
  websocket.emit("message", '{"method":"warning","params":{"text":"原文"}}');
  input.end("last\r");

  await bridge;

  assert.deepEqual(websocket.sent, ["first", "second", "last"]);
  assert.equal(text(), '{"method":"warning","params":{"text":"原文"}}\n');
});

test("对端关闭时销毁仍打开的真实 stdin 流并结束 bridge", async () => {
  const websocket = new FakeWebSocket();
  const input = new PassThrough();
  const { output } = await capturedOutput();
  const events = [];
  const bridge = bridgeStdioToAppServer("unused", {
    input,
    output,
    log: { event: (name, fields) => events.push({ name, fields }) },
    connect: async () => websocket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.destroyed, false);

  websocket.emit("close");
  await bridge;

  assert.equal(input.destroyed, true);
  assert.equal(input.readable, false);
  assert.equal(events.find((event) => event.name === "bridge.closed").fields.reason, "peer-close");
});

test("协议错误时结束真实 stdin 并向上抛出", async () => {
  const websocket = new FakeWebSocket();
  const input = new PassThrough();
  const { output } = await capturedOutput();
  const bridge = bridgeStdioToAppServer("unused", {
    input,
    output,
    connect: async () => websocket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const protocolError = new Error("bad websocket frame");

  websocket.emit("error", protocolError);

  await assert.rejects(bridge, protocolError);
  assert.equal(input.destroyed, true);
  assert.equal(websocket.destroyedWith, protocolError);
});

test("close 后下一轮到达的 websocket error 有监听器安全消费", async () => {
  const websocket = new FakeWebSocket();
  const input = new PassThrough();
  const { output } = await capturedOutput();
  const bridge = bridgeStdioToAppServer("unused", {
    input,
    output,
    connect: async () => websocket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  const lateError = new Error("late socket error");
  websocket.once("close", () => setImmediate(() => websocket.emit("error", lateError)));

  websocket.emit("close");

  await bridge;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(input.destroyed, true);
  assert.equal(websocket.listenerCount("error"), 1);
});

test("stdout EPIPE 会销毁 stdin 并向上抛出", async () => {
  const websocket = new FakeWebSocket();
  const input = new PassThrough();
  const outputError = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
  const events = [];
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback(outputError);
    },
  });
  const bridge = bridgeStdioToAppServer("unused", {
    input,
    output,
    log: { event: (name, fields) => events.push({ name, fields }) },
    connect: async () => websocket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  websocket.emit("message", "server response");

  await assert.rejects(bridge, outputError);
  assert.equal(input.destroyed, true);
  assert.equal(websocket.destroyedWith, outputError);
  assert.equal(events.find((event) => event.name === "bridge.closed").fields.reason, "error");
});

test("对端关闭后仍排空已收到的消息，并传播挂起写入的 EPIPE", async () => {
  const websocket = new FakeWebSocket();
  const input = new PassThrough();
  const outputError = Object.assign(new Error("broken pipe"), { code: "EPIPE" });
  let completeWrite;
  const output = new Writable({
    highWaterMark: 1024,
    write(_chunk, _encoding, callback) {
      completeWrite = callback;
    },
  });
  const originalWrite = output.write.bind(output);
  output.write = (...args) => {
    const accepted = originalWrite(...args);
    assert.equal(accepted, true);
    return accepted;
  };
  const bridge = bridgeStdioToAppServer("unused", {
    input,
    output,
    connect: async () => websocket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  websocket.emit("message", "server response");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof completeWrite, "function");

  websocket.emit("close");
  setImmediate(() => completeWrite(outputError));

  await assert.rejects(bridge, outputError);
  assert.equal(input.destroyed, true);
  assert.equal(websocket.destroyedWith, outputError);
});

test("stdout backpressure 排空后正常完成", async () => {
  const websocket = new FakeWebSocket();
  const input = new PassThrough();
  let text = "";
  let completeWrite;
  const output = new Writable({
    highWaterMark: 1,
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      completeWrite = callback;
    },
  });
  const bridge = bridgeStdioToAppServer("unused", {
    input,
    output,
    connect: async () => websocket,
  });
  await new Promise((resolve) => setImmediate(resolve));
  let settled = false;
  bridge.then(() => { settled = true; }, () => { settled = true; });
  websocket.emit("message", "response");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  assert.equal(typeof completeWrite, "function");
  const drained = new Promise((resolve) => output.once("drain", resolve));
  completeWrite();
  await drained;
  input.end();

  await bridge;

  assert.equal(text, "response\n");
});

test("stdin 正常 EOF 后发送末行并关闭 websocket", async () => {
  const websocket = new FakeWebSocket();
  const input = Readable.from(["final message"]);
  const { output } = await capturedOutput();
  const events = [];

  await bridgeStdioToAppServer("unused", {
    input,
    output,
    log: { event: (name, fields) => events.push({ name, fields }) },
    connect: async () => websocket,
  });

  assert.deepEqual(websocket.sent, ["final message"]);
  assert.equal(events.find((event) => event.name === "bridge.closed").fields.reason, "stdin-eof");
});

test("长输入逐条发送时清理每次终止竞速监听", async () => {
  const websocket = new FakeWebSocket();
  const input = Readable.from(["line\n".repeat(2_000)]);
  const { output } = await capturedOutput();

  await bridgeStdioToAppServer("unused", {
    input,
    output,
    connect: async () => websocket,
  });

  assert.equal(websocket.sent.length, 2_000);
  assert.equal(websocket.listenerCount("terminal"), 0);
});

test("RPC 诊断关联失败响应且保持双向协议原文不变", async () => {
  const websocket = new FakeWebSocket();
  const request = '{ "id":"private-request", "method":"plugin/read", "params":{"pluginName":"private@market"} }';
  const response = '{ "id":"private-request", "error":{"code":-32600,"message":"invalid remote plugin id: private@market"} }';
  websocket.sendText = async (text) => {
    websocket.sent.push(text);
    websocket.emit("message", response);
  };
  const events = [];
  const { output, text } = await capturedOutput();
  await bridgeStdioToAppServer("unused", {
    input: Readable.from([`${request}\n`]), output,
    connect: async () => websocket,
    log: { event: (event, fields) => events.push({ event, ...fields }) },
  });
  assert.deepEqual(websocket.sent, [request]);
  assert.equal(text(), `${response}\n`);
  const failed = events.find((e) => e.event === "rpc.failed");
  assert.equal(failed.method, "plugin/read");
  assert.equal(failed.kind, "invalid-plugin-id");
  assert.equal(failed.connectionId, events.find((e) => e.event === "bridge.connected").connectionId);
  assert.doesNotMatch(JSON.stringify(events), /private-request|private@market/u);
});

test("发送失败时诊断不将收到的请求误记为已经发送", async () => {
  const websocket = new FakeWebSocket();
  const sendError = new Error("send failed");
  websocket.sendText = async () => { throw sendError; };
  const events = [];
  const { output } = await capturedOutput();
  await assert.rejects(bridgeStdioToAppServer("unused", {
    input: Readable.from(['{"id":1,"method":"config/read"}\n']), output,
    connect: async () => websocket,
    log: { event: (event, fields) => events.push({ event, ...fields }) },
  }), sendError);
  const interrupted = events.find((e) => e.event === "rpc.interrupted");
  assert.equal(interrupted.sample[0].forwarding, "observed");
  assert.equal(interrupted.reason, "error");
});
