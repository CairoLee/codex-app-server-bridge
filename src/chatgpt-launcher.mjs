#!/usr/bin/env node
import { spawn } from "node:child_process";
import { isAppServerRunInvocation } from "./app-server-args.mjs";
import { ensureSharedServer } from "./server-manager.mjs";
import { bridgeStdioToAppServer } from "./stdio-bridge.mjs";
import { resourceCodexPath, sysexits } from "./settings.mjs";

const args = process.argv.slice(2);

async function passThrough() {
  const child = spawn(resourceCodexPath(), args, {
    env: process.env,
    stdio: "inherit",
  });
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (outcome.error) {
    process.stderr.write(`无法启动 ChatGPT Resources/codex：${outcome.error.message}\n`);
    process.exitCode = sysexits.unavailable;
    return;
  }
  const { code, signal } = outcome;
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? sysexits.software;
}

try {
  if (!isAppServerRunInvocation(args)) {
    await passThrough();
  } else {
    const ownerPid = Number.parseInt(
      process.env.CODEX_BRIDGE_OWNER_PID || String(process.ppid),
      10,
    );
    const status = await ensureSharedServer({ args, ownerPid });
    await bridgeStdioToAppServer(status.state.socketPath);
  }
} catch (error) {
  process.stderr.write(`Codex App Server Bridge 启动失败：${error?.stack || error}\n`);
  process.exitCode = sysexits.software;
}
