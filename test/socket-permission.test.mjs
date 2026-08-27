import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  isPermissionDeniedError,
  isUnixSocketPermissionDenied,
} from "../src/socket-permission.mjs";

class FakeSocket extends EventEmitter {
  destroyed = false;

  destroy() {
    this.destroyed = true;
  }
}

function connectionThatEmits(event, value) {
  return () => {
    const socket = new FakeSocket();
    queueMicrotask(() => socket.emit(event, value));
    return socket;
  };
}

test("识别直接或嵌套的 Unix socket 权限错误", () => {
  assert.equal(isPermissionDeniedError({ code: "EPERM" }), true);
  assert.equal(
    isPermissionDeniedError({ cause: { code: "EACCES" } }),
    true,
  );
  assert.equal(isPermissionDeniedError({ code: "ENOENT" }), false);
});

test("受限运行环境无法连接共享 socket 时请求回退", async () => {
  assert.equal(
    await isUnixSocketPermissionDenied("/unused", {
      createConnection: connectionThatEmits("error", { code: "EPERM" }),
    }),
    true,
  );
});

test("socket 可连接或尚未创建时保持共享 App Server 路径", async () => {
  assert.equal(
    await isUnixSocketPermissionDenied("/unused", {
      createConnection: connectionThatEmits("connect"),
    }),
    false,
  );
  assert.equal(
    await isUnixSocketPermissionDenied("/unused", {
      createConnection: connectionThatEmits("error", { code: "ENOENT" }),
    }),
    false,
  );
});
