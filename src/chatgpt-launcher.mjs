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

const args = process.argv.slice(2);

if (process.env.CODEX_BRIDGE_LAUNCHER_DIAGNOSTICS === "1") {
  const { recordLauncherInvocation } = await import(
    "./launcher-diagnostics.mjs"
  );
  await recordLauncherInvocation({ args }).catch(() => {});
}

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
  if (
    !isAppServerRunInvocation(args) ||
    isExplicitAppServerListenerInvocation(args)
  ) {
    await passThrough();
  } else {
    const paths = runtimePaths(process.env);
    if (await isUnixSocketPermissionDenied(paths.socketPath)) {
      process.stderr.write(
        "当前运行环境无权连接共享 App Server，改用 ChatGPT Resources/codex。\n",
      );
      await passThrough();
    } else {
      const ownerPid = Number.parseInt(
        process.env.CODEX_BRIDGE_OWNER_PID || String(process.ppid),
        10,
      );
      const status = await ensureSharedServer({ args, ownerPid });
      await bridgeStdioToAppServer(status.state.socketPath);
    }
  }
} catch (error) {
  process.stderr.write(`Codex App Server Bridge 启动失败：${error?.stack || error}\n`);
  process.exitCode = sysexits.software;
}
