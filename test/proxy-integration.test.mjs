import { resourceCodexPath } from "../src/settings.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { Duplex } from "node:stream";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { connectWebSocketStream } from "../src/websocket-uds.mjs";

const enabled = process.env.RUN_PROXY_INTEGRATION === "1";
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const guardPath = path.resolve(sourceDirectory, "../src/cli-guard.mjs");
const bundledNode = "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";
const resourceCodex = resourceCodexPath();
const execFileAsync = promisify(execFile);

function spawnProxy() {
  const executable = process.env.CODEX_BRIDGE_PROXY_EXECUTABLE?.trim();
  if (executable) {
    return spawn(executable, ["app-server", "proxy"], {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
  return spawn(bundledNode, [guardPath, "app-server", "proxy"], {
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function request(websocket, payload, timeoutMs = 5_000) {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`请求 ${payload.method} 超时`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      websocket.off("message", onMessage);
      websocket.off("error", onError);
      websocket.off("close", onClose);
    };
    const onMessage = (message) => {
      const parsed = JSON.parse(message);
      if (parsed.id !== payload.id) return;
      cleanup();
      if (parsed.error) reject(new Error(JSON.stringify(parsed.error)));
      else resolve(parsed.result);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("proxy 在响应前关闭"));
    };
    websocket.on("message", onMessage);
    websocket.once("error", onError);
    websocket.once("close", onClose);
    websocket.sendText(JSON.stringify(payload)).catch(onError);
  });
}

test(
  "Remote SSH proxy 连接桌面端共享 App Server 并读取会话列表",
  { skip: !enabled, timeout: 30_000 },
  async (context) => {
    const child = spawnProxy();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    context.after(() => {
      if (child.exitCode == null) child.kill("SIGTERM");
    });

    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
    const websocket = await connectWebSocketStream(stream, { timeoutMs: 5_000 });
    const initialize = await request(websocket, {
      id: "proxy-initialize",
      method: "initialize",
      params: {
        clientInfo: {
          name: "codex_app_server_bridge_proxy_test",
          title: "Codex App Server Bridge Proxy Test",
          version: "1.0.0",
        },
        capabilities: { experimentalApi: true, requestAttestation: false },
      },
    });
    const versionOutput = (await execFileAsync(resourceCodex, ["--version"])).stdout;
    const expectedVersion = versionOutput.match(/codex-cli\s+(\S+)/u)?.[1];
    assert.ok(expectedVersion, versionOutput);
    assert.match(initialize.userAgent, /Codex Desktop\//u, stderr);
    assert.ok(initialize.userAgent.includes(expectedVersion), stderr);
    await websocket.sendText(JSON.stringify({ method: "initialized", params: {} }));
    const threads = await request(websocket, {
      id: "proxy-thread-list",
      method: "thread/list",
      params: { limit: 10, sortKey: "updated_at", useStateDbOnly: true },
    });
    assert.ok(Array.isArray(threads.data), stderr);
    assert.ok(threads.data.length > 0, stderr);
    await websocket.close();
    const [exitCode] = await once(child, "exit");
    assert.equal(exitCode, 0, stderr);
  },
);
