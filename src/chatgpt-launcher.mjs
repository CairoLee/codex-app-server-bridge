#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  isAppServerRunInvocation,
  isExplicitAppServerListenerInvocation,
} from "./app-server-args.mjs";
import { ensureSharedServer } from "./server-manager.mjs";
import { isUnixSocketPermissionDenied } from "./socket-permission.mjs";
import { bridgeStdioToAppServer } from "./stdio-bridge.mjs";
import { resourceCodexPath, runtimePaths, sysexits } from "./settings.mjs";

import { createRuntimeLogger, sanitizeArgs, errorFields } from "./runtime-log.mjs";

const log = createRuntimeLogger({ component: "launcher" });
const args = process.argv.slice(2);
log.event("invocation", { args: sanitizeArgs(args) });

if (process.env.CODEX_BRIDGE_LAUNCHER_DIAGNOSTICS === "1") {
  const { recordLauncherInvocation } = await import(
    "./launcher-diagnostics.mjs"
  );
  await recordLauncherInvocation({ args }).catch(() => {});
}

async function passThrough(reason) {
  log.event("route", { action: "pass-through", reason });
  const child = spawn(resourceCodexPath(), args, {
    env: process.env,
    stdio: "inherit",
  });
  log.event("child.started", { childPid: child.pid, executable: resourceCodexPath(), args: sanitizeArgs(args) });
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  log.event("child.exited", { childPid: child.pid, code: outcome.code, signal: outcome.signal, ...errorFields(outcome.error) });
  await log.flush();
  if (outcome.error) {
    process.stderr.write(`无法启动 ChatGPT Resources/codex：${outcome.error.message}\n`);
    process.exitCode = sysexits.unavailable;
    return;
  }
  const { code, signal } = outcome;
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? sysexits.software;
}

let phase = "routing";
try {
  if (
    !isAppServerRunInvocation(args) ||
    isExplicitAppServerListenerInvocation(args)
  ) {
    await passThrough(isExplicitAppServerListenerInvocation(args) ? "explicit-listener" : "not-app-server-run");
  } else {
    const paths = runtimePaths(process.env);
    if (await isUnixSocketPermissionDenied(paths.socketPath)) {
      process.stderr.write(
        "当前运行环境无权连接共享 App Server，改用 ChatGPT Resources/codex。\n",
      );
      await passThrough("socket-permission-denied");
    } else if (!process.env.CODEX_APP_TOOLS_PIPE_PATH?.trim()) {
      // 桌面端在工具管道建立前也会启动辅助 App Server；该实例只服务
      // 当前 stdio 调用，不应创建或复用缺少桌面工具的共享服务。
      await passThrough("app-tools-pipe-absent");
    } else {
      const ownerPid = Number.parseInt(
        process.env.CODEX_BRIDGE_OWNER_PID || String(process.ppid),
        10,
      );
      log.event("route", { action: "shared-bridge", ownerPid });
      phase = "shared-server-startup";
      const status = await ensureSharedServer({ args, ownerPid, log });
      log.event("server.selected", { ownerPid, serverPid: status.state.serverPid, supervisorPid: status.state.supervisorPid, generation: status.state.generation, socketPath: status.state.socketPath });
      phase = "stdio-transfer";
      await bridgeStdioToAppServer(status.state.socketPath, { log });
    }
  }
} catch (error) {
  log.event("launcher.failed", { phase, ...errorFields(error) });
  process.stderr.write(`Codex App Server Bridge 启动失败：${error?.stack || error}\n`);
  process.exitCode = sysexits.software;
}

await log.close();
