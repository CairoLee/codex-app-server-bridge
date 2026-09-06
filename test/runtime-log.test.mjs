import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import {
  createRuntimeLogger,
  errorFields,
  sanitizeArgs,
} from "../src/runtime-log.mjs";

async function temporaryDirectory(context) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-log-test-"));
  context.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("批量写入结构化事件，并以安全权限创建文件", async (context) => {
  const directory = await temporaryDirectory(context);
  const current = new Date(2026, 8, 6, 12, 0);
  const logger = createRuntimeLogger({ directory, component: "guard", now: () => current });
  logger.event("invoked", { args: sanitizeArgs(["exec", "--model", "secret", "prompt"]) });
  logger.event("bridged", { childPid: 42 });
  await logger.close();

  const file = path.join(directory, "2026-09-06.jsonl");
  const records = (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].args, ["exec", "--model", "<redacted>", "<redacted>"]);
  assert.equal(records[1].childPid, 42);
  assert.equal(records[1].pid, process.pid);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("启动准备尚未完成时立即 flush 也会写完队列", async (context) => {
  const directory = path.join(await temporaryDirectory(context), "new-directory");
  const current = new Date(2026, 8, 6, 12, 0);
  const logger = createRuntimeLogger({ directory, component: "immediate", now: () => current });
  logger.event("queued-during-prepare");
  await logger.flush();
  const records = (await fs.readFile(path.join(directory, "2026-09-06.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(records[0].event, "queued-during-prepare");
  await logger.close();
});

test("保留今天及前两天，日期切换后写入新文件", async (context) => {
  const directory = await temporaryDirectory(context);
  await fs.writeFile(path.join(directory, "2026-09-04.jsonl"), "old\n");
  await fs.writeFile(path.join(directory, "2026-09-05.jsonl"), "keep\n");
  await fs.writeFile(path.join(directory, "notes.jsonl"), "untouched\n");
  let current = new Date(2026, 8, 6, 23, 59);
  const logger = createRuntimeLogger({ directory, component: "proxy", now: () => current });
  logger.event("before");
  current = new Date(2026, 8, 7, 0, 1);
  logger.event("after");
  await logger.close();

  const entries = await fs.readdir(directory);
  assert.ok(!entries.includes("2026-09-04.jsonl"));
  assert.ok(entries.includes("2026-09-05.jsonl"));
  assert.ok(entries.includes("notes.jsonl"));
  assert.ok(entries.includes("2026-09-06.jsonl"));
  assert.ok(entries.includes("2026-09-07.jsonl"));
});

test("跨午夜即使没有事件也执行保留清理", async (context) => {
  const directory = await temporaryDirectory(context);
  await fs.writeFile(path.join(directory, "2026-09-04.jsonl"), "old\n");
  let current = new Date(2026, 8, 6, 23, 59, 59, 980);
  const logger = createRuntimeLogger({ directory, component: "idle", now: () => current });
  await logger.flush();
  current = new Date(2026, 8, 7, 0, 0, 0, 100);
  await new Promise((resolve) => setTimeout(resolve, 100));
  await logger.flush();
  await assert.rejects(fs.stat(path.join(directory, "2026-09-04.jsonl")), { code: "ENOENT" });
  await logger.close();
});

test("参数和错误脱敏不泄露自由文本或错误消息", () => {
  assert.deepEqual(
    sanitizeArgs([
      "app-server",
      "--token=abc",
      "--config",
      "features.experimental=true",
      "--cwd=/private/project",
      "hello world",
    ]),
    [
      "app-server",
      "--token=<redacted>",
      "--config",
      "features.experimental=true",
      "--cwd=<redacted>",
      "<redacted>",
    ],
  );
  const error = Object.assign(new Error("token=must-not-appear"), { code: "EFAIL" });
  assert.deepEqual(errorFields(error), { name: "Error", code: "EFAIL" });
  assert.deepEqual(sanitizeArgs(["hello secret prompt"]), ["<redacted>"]);
  assert.deepEqual(
    sanitizeArgs(["exec", "-csecret", "--", "private", "--token=abc"]),
    ["exec", "-c<redacted>", "--", "<redacted>", "<redacted>"],
  );
});

test("capture 有界记录输出且持续消费流", async (context) => {
  const directory = await temporaryDirectory(context);
  const logger = createRuntimeLogger({ directory, component: "child" });
  logger.capture("stderr", Readable.from(["x".repeat(5000), "done"]));
  await new Promise((resolve) => setImmediate(resolve));
  await logger.close();
  const files = await fs.readdir(directory);
  const records = (await fs.readFile(path.join(directory, files[0]), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(records[0].chunk.length, 4096);
  assert.equal(records[0].truncated, true);
  assert.equal(records[1].chunk, "done");
});

test("目录不可写或路径无效时日志失败不影响业务", async (context) => {
  const root = await temporaryDirectory(context);
  const file = path.join(root, "not-a-directory");
  await fs.writeFile(file, "occupied");
  const logger = createRuntimeLogger({ directory: file, component: "guard" });
  assert.doesNotThrow(() => logger.event("still-running"));
  await assert.doesNotReject(() => logger.close());
});

test("环境变量可关闭落盘但 capture 仍消费流", async (context) => {
  const root = await temporaryDirectory(context);
  const directory = path.join(root, "disabled");
  let chunks = 0;
  const readable = Readable.from(["one", "two"]);
  readable.on("data", () => { chunks += 1; });
  const logger = createRuntimeLogger({
    directory,
    component: "disabled",
    env: { CODEX_BRIDGE_RUNTIME_LOG: "0" },
  });
  logger.capture("stdout", readable);
  logger.event("ignored");
  await new Promise((resolve) => readable.on("end", resolve));
  await logger.close();
  assert.equal(chunks, 2);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("突发事件保持有界并汇总被丢弃数量", async (context) => {
  const directory = await temporaryDirectory(context);
  const current = new Date(2026, 8, 6, 12, 0);
  const logger = createRuntimeLogger({ directory, component: "burst", now: () => current });
  for (let index = 0; index < 1100; index += 1) logger.event("item", { index });
  await logger.close();
  const records = (await fs.readFile(path.join(directory, "2026-09-06.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(records.length, 1025);
  assert.equal(records.at(-1).event, "runtime_log_dropped");
  assert.equal(records.at(-1).count, 76);
});

test("不可序列化字段按丢弃事件汇总且不影响调用方", async (context) => {
  const directory = await temporaryDirectory(context);
  const current = new Date(2026, 8, 6, 12, 0);
  const logger = createRuntimeLogger({ directory, component: "serialize", now: () => current });
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => logger.event("invalid", { circular }));
  logger.event("valid");
  await logger.close();
  const records = (await fs.readFile(path.join(directory, "2026-09-06.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map(({ event }) => event), ["valid", "runtime_log_dropped"]);
  assert.equal(records[1].count, 1);
});

test("capture 每秒最多逐块记录 32 条并汇总其余输出", async (context) => {
  const directory = await temporaryDirectory(context);
  const current = new Date(2026, 8, 6, 12, 0);
  const logger = createRuntimeLogger({ directory, component: "capture", now: () => current });
  logger.capture("stdout", Readable.from(Array.from({ length: 40 }, () => "x")));
  await new Promise((resolve) => setImmediate(resolve));
  await logger.close();
  const records = (await fs.readFile(path.join(directory, "2026-09-06.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  assert.equal(records.filter(({ event }) => event === "process_output").length, 32);
  assert.equal(records.at(-1).event, "process_output_suppressed");
  assert.equal(records.at(-1).count, 8);
});
