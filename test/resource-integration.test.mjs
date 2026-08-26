import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const enabled = process.env.RUN_RESOURCE_INTEGRATION === "1";
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const launcherPath = path.resolve(sourceDirectory, "../src/chatgpt-launcher.mjs");
const statusPath = path.resolve(sourceDirectory, "../src/status.mjs");
const resourceCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
const bundledNode =
  "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node";

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

test(
  "真实 Resources/codex 完成 supervisor、Unix socket 和 stdio 桥接",
  { skip: !enabled, timeout: 60_000 },
  async (context) => {
    const temporaryDirectory = await fs.mkdtemp("/tmp/chatgpt-codex-primary-integration-");
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
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    });

    const env = {
      ...process.env,
      CODEX_HOME: codexHome,
      CODEX_APP_TOOLS_PIPE_PATH: appToolsPipe,
      CHATGPT_CODEX_PRIMARY_STATE_DIR: stateDirectory,
      CHATGPT_CODEX_PRIMARY_SOCKET: path.join(stateDirectory, "app-server.sock"),
      CHATGPT_CODEX_RESOURCE_PATH: resourceCodex,
      CHATGPT_CODEX_NODE_PATH: bundledNode,
      CHATGPT_CODEX_OWNER_PID: String(process.pid),
    };
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
    assert.match(response.result.userAgent, /Codex Desktop\/\d/u);
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
    assert.equal(state.resourceCodexPath, resourceCodex);

    const status = spawn(bundledNode, [statusPath], {
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
  },
);
