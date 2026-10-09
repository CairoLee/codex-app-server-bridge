import { resourceCodexPath } from "../src/settings.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const enabled = process.env.RUN_RESOURCE_INTEGRATION === "1";
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const launcherPath = path.resolve(sourceDirectory, "../src/chatgpt-launcher.mjs");
const statusPath = path.resolve(sourceDirectory, "../src/status.mjs");
const resourceCodex = resourceCodexPath();
const bundledNode =
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";

function testEnvironment(overrides) {
  const env = { ...process.env, ...overrides };
  // 测试客户端必须独立决定身份，不继承桌面端预设的 originator。
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  return env;
}

async function waitForExit(pid, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function readFirstLine(stream, timeoutMs = 30_000) {
  stream.setEncoding("utf8");
  return await new Promise((resolve, reject) => {
    let pending = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("timed out waiting for launcher output"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      stream.off("data", onData);
      stream.off("error", onError);
    };
    const onData = (chunk) => {
      pending += chunk;
      const newline = pending.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(pending.slice(0, newline));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    stream.on("data", onData);
    stream.once("error", onError);
  });
}

function createJsonResponseReader(stream) {
  const lines = readline.createInterface({ input: stream });
  const iterator = lines[Symbol.asyncIterator]();
  return {
    async read(id, timeoutMs = 30_000) {
      for (;;) {
        let timer;
        try {
          const result = await Promise.race([
            iterator.next(),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`timed out waiting for response ${id}`)),
                timeoutMs,
              );
            }),
          ]);
          if (result.done) throw new Error(`launcher closed before response ${id}`);
          const message = JSON.parse(result.value);
          if (message.id === id) return message;
        } finally {
          if (timer != null) clearTimeout(timer);
        }
      }
    },
    close() {
      lines.close();
    },
  };
}

test(
  "真实 Resources/codex 完成 supervisor、Unix socket 和 stdio 桥接",
  { skip: !enabled, timeout: 60_000 },
  async (context) => {
    const temporaryDirectory = await fs.mkdtemp("/tmp/codex-app-server-bridge-integration-");
    const stateDirectory = path.join(temporaryDirectory, "state");
    const codexHome = path.join(temporaryDirectory, "home");
    const appToolsPipe = path.join(temporaryDirectory, "app-tools.sock");
    await fs.mkdir(codexHome, { recursive: true });
    const appToolsServer = net.createServer((socket) => socket.end());
    appToolsServer.listen(appToolsPipe);
    await once(appToolsServer, "listening");
    let supervisorPid = null;
    let serverPid = null;
    context.after(async () => {
      if (supervisorPid) {
        try {
          process.kill(supervisorPid, "SIGTERM");
        } catch {}
        await waitForExit(supervisorPid);
      }
      if (serverPid) {
        try {
          process.kill(serverPid, "SIGTERM");
        } catch {}
        await waitForExit(serverPid);
      }
      appToolsServer.close();
      await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const env = testEnvironment({
      CODEX_HOME: codexHome,
      CODEX_APP_TOOLS_PIPE_PATH: appToolsPipe,
      CODEX_BRIDGE_STATE_DIR: stateDirectory,
      CODEX_BRIDGE_SOCKET: path.join(stateDirectory, "app-server.sock"),
      CODEX_BRIDGE_RESOURCE_PATH: resourceCodex,
      CODEX_BRIDGE_NODE_PATH: bundledNode,
      CODEX_BRIDGE_OWNER_PID: String(process.pid),
    });
    const launcher = spawn(bundledNode, [
      launcherPath,
      "-c",
      "features.code_mode_host=true",
      "app-server",
      "--analytics-default-enabled",
      "-c",
      'mcp_servers.codex_app={command="/bin/false",enabled=false}',
    ], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    context.after(() => launcher.stdin.end());
    let stderr = "";
    launcher.stderr.setEncoding("utf8");
    launcher.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    launcher.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "integration_test",
            title: "Integration Test",
            version: "1.0.0",
          },
        },
      })}\n`,
    );
    const response = JSON.parse(await readFirstLine(launcher.stdout));
    assert.equal(response.id, 1, stderr);
    assert.match(response.result.userAgent, /^integration_test\/\d/u);
    launcher.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );
    launcher.stdin.end();
    const [launcherCode] = await once(launcher, "exit");
    assert.equal(launcherCode, 0, stderr);

    const state = JSON.parse(
      await fs.readFile(path.join(stateDirectory, "state.json"), "utf8"),
    );
    supervisorPid = state.supervisorPid;
    serverPid = state.serverPid;
    assert.equal(state.status, "ready");
    assert.equal(state.ownerPid, process.pid);
    assert.equal(
      state.supervisorPath,
      path.resolve(sourceDirectory, "../src/supervisor.mjs"),
    );
    assert.equal(state.resourceCodexPath, resourceCodex);

    const status = spawn(bundledNode, [statusPath, "--json"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    status.stdout.setEncoding("utf8");
    let statusOutput = "";
    status.stdout.on("data", (chunk) => {
      statusOutput += chunk;
    });
    const [statusCode] = await once(status, "exit");
    const statusJson = JSON.parse(statusOutput);
    assert.equal(statusJson.ok, true);
    assert.equal(statusJson.serverPid, serverPid);
    assert.equal(statusCode, 0);
    assert.equal(statusJson.appServerVersion, response.result.userAgent);
  },
);

test(
  "Browser 显式 listener 直通真实 Resources/codex",
  { skip: !enabled || process.platform !== "darwin", timeout: 30_000 },
  async (context) => {
    const temporaryDirectory = await fs.mkdtemp(
      "/tmp/codex-app-server-browser-listener-",
    );
    const sharedSocketPath = path.join(temporaryDirectory, "shared.sock");
    let sharedSocketConnections = 0;
    const sharedSocketServer = net.createServer((socket) => {
      sharedSocketConnections += 1;
      socket.end();
    });
    sharedSocketServer.listen(sharedSocketPath);
    await once(sharedSocketServer, "listening");
    context.after(async () => {
      sharedSocketServer.close();
      await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const launcher = spawn(
      bundledNode,
      [
        launcherPath,
        "app-server",
        "--listen",
        "stdio://",
        "--analytics-default-enabled",
      ],
      {
        env: testEnvironment({
          CODEX_HOME: temporaryDirectory,
          CODEX_APP_TOOLS_PIPE_PATH: "",
          CODEX_BRIDGE_RESOURCE_PATH: resourceCodex,
          CODEX_BRIDGE_NODE_PATH: bundledNode,
          CODEX_BRIDGE_SOCKET: sharedSocketPath,
        }),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    context.after(() => launcher.stdin.end());
    let stderr = "";
    launcher.stderr.setEncoding("utf8");
    launcher.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const responses = createJsonResponseReader(launcher.stdout);
    context.after(() => responses.close());

    launcher.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "browser_listener_integration_test",
            title: "Browser Listener Integration Test",
            version: "1.0.0",
          },
        },
      })}\n`,
    );
    const initialize = await responses.read(1);
    assert.match(initialize.result.userAgent, /^browser_listener_integration_test\/\d/u, stderr);
    launcher.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );

    launcher.stdin.write(
      `${JSON.stringify({
        method: "configRequirements/read",
        id: 2,
        params: {},
      })}\n`,
    );
    const requirements = await responses.read(2);
    assert.ok(requirements.result, stderr);

    launcher.stdin.end();
    const [launcherCode] = await once(launcher, "exit");
    assert.equal(launcherCode, 0, stderr);
    assert.equal(sharedSocketConnections, 0);
  },
);

test(
  "Browser 权限回退使用真实 Resources/codex 读取安全配置",
  { skip: !enabled || process.platform !== "darwin", timeout: 30_000 },
  async (context) => {
    const temporaryDirectory = await fs.mkdtemp(
      "/tmp/codex-app-server-browser-fallback-",
    );
    context.after(async () => {
      await fs.rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    });

    const launcher = spawn(
      bundledNode,
      [launcherPath, "app-server", "--analytics-default-enabled"],
      {
        env: testEnvironment({
          CODEX_HOME: temporaryDirectory,
          CODEX_BRIDGE_RESOURCE_PATH: resourceCodex,
          CODEX_BRIDGE_NODE_PATH: bundledNode,
          CODEX_BRIDGE_SOCKET:
            "/var/root/codex-app-server-bridge-browser-test.sock",
        }),
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    context.after(() => launcher.stdin.end());
    let stderr = "";
    launcher.stderr.setEncoding("utf8");
    launcher.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const responses = createJsonResponseReader(launcher.stdout);
    context.after(() => responses.close());

    launcher.stdin.write(
      `${JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "browser_fallback_integration_test",
            title: "Browser Fallback Integration Test",
            version: "1.0.0",
          },
        },
      })}\n`,
    );
    const initialize = await responses.read(1);
    assert.match(initialize.result.userAgent, /^browser_fallback_integration_test\/\d/u, stderr);
    launcher.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`,
    );

    launcher.stdin.write(
      `${JSON.stringify({
        method: "config/read",
        id: 2,
        params: { cwd: temporaryDirectory, includeLayers: false },
      })}\n`,
    );
    const config = await responses.read(2);
    assert.ok(config.result?.config, stderr);

    launcher.stdin.write(
      `${JSON.stringify({
        method: "configRequirements/read",
        id: 3,
        params: {},
      })}\n`,
    );
    const requirements = await responses.read(3);
    assert.ok(requirements.result, stderr);

    launcher.stdin.end();
    const [launcherCode] = await once(launcher, "exit");
    assert.equal(launcherCode, 0, stderr);
    assert.match(stderr, /无权连接共享 App Server/u);
  },
);
