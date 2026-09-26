#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { bridgeStatus } from "./bridge-state.mjs";
import { isComputerUseHelper } from "./computer-use-helper.mjs";
import { sharedRemoteInvocationArgs } from "./cli-invocation.mjs";
import {
  resourceCodexPath,
  runtimePaths,
  standaloneCodexPath,
  standaloneInstallDirectory,
  sysexits,
} from "./settings.mjs";

import { createRuntimeLogger, sanitizeArgs, errorFields } from "./runtime-log.mjs";

const log = createRuntimeLogger({ component: "cli-guard" });
const args = process.argv.slice(2);
log.event("invocation", { args: sanitizeArgs(args) });
const standaloneEntrypoint =
  process.env.CODEX_BRIDGE_STANDALONE_ENTRYPOINT === "1";
const topLevelCommands = new Set([
  "agents",
  "exec",
  "review",
  "login",
  "logout",
  "mcp",
  "plugin",
  "mcp-server",
  "app-server",
  "remote-control",
  "app",
  "completion",
  "update",
  "doctor",
  "sandbox",
  "debug",
  "apply",
  "resume",
  "queue",
  "archive",
  "delete",
  "migrate-rollouts",
  "unarchive",
  "fork",
  "cloud",
  "exec-server",
  "features",
  "help",
]);
const remoteCommands = new Set([
  "agents",
  "resume",
  "queue",
  "archive",
  "delete",
  "unarchive",
  "fork",
]);
const agentCommandsWithoutAppServer = new Set(["exec", "review"]);
const blockedServerCommands = new Set(["app-server", "remote-control"]);
const optionsWithValues = new Set([
  "-c",
  "--config",
  "--enable",
  "--disable",
  "--remote",
  "--remote-auth-token-env",
  "--sock",
  "-i",
  "--image",
  "-m",
  "--model",
  "--local-provider",
  "-p",
  "--profile",
  "-s",
  "--sandbox",
  "-C",
  "--cd",
  "--add-dir",
  "-a",
  "--ask-for-approval",
]);

function topLevelCommand(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") return null;
    if (optionsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) continue;
    return topLevelCommands.has(argument) ? argument : null;
  }
  return null;
}

function positionalArguments(argv) {
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (optionsWithValues.has(argument)) {
      index += 1;
      continue;
    }
    if (!argument.startsWith("-")) positional.push(argument);
  }
  return positional;
}

function forceProxySocket(argv, socket) {
  const forwarded = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--sock") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--sock=")) continue;
    forwarded.push(argument);
  }
  return [...forwarded, "--sock", socket];
}

function hasExplicitRemote(argv) {
  return argv.some(
    (argument) => argument === "--remote" || argument.startsWith("--remote="),
  );
}

async function run(executable, childArgs, env = process.env) {
  const child = spawn(executable, childArgs, { env, stdio: "inherit" });
  log.event("child.started", { childPid: child.pid, executable, args: sanitizeArgs(childArgs) });
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  log.event("child.exited", { childPid: child.pid, code: outcome.code, signal: outcome.signal, ...errorFields(outcome.error) });
  await log.flush();
  if (outcome.error) {
    process.stderr.write(`${outcome.error.message}\n`);
    process.exitCode = sysexits.unavailable;
    return;
  }
  const { code, signal } = outcome;
  if (signal) process.kill(process.pid, signal);
  process.exitCode = code ?? sysexits.software;
}

function standaloneEnvironment({ update = false } = {}) {
  const env = { ...process.env };
  delete env.CODEX_BRIDGE_STANDALONE_ENTRYPOINT;
  if (!update) return env;

  const installDirectory = standaloneInstallDirectory(env);
  const pathEntries = (env.PATH ?? "")
    .split(path.delimiter)
    .filter((entry) => entry !== "" && entry !== installDirectory);
  env.CODEX_INSTALL_DIR = installDirectory;
  env.PATH = [installDirectory, ...pathEntries].join(path.delimiter);
  return env;
}

function printUnavailable(reason) {
  log.event("route", { action: "blocked", reason: "shared-server-unavailable", detail: reason.startsWith("shared server state is ") ? "shared server is not ready" : reason.split(":")[0] });
  process.stderr.write(
    [
      "Codex 已配置为只使用 ChatGPT Desktop 的共享 App Server。",
      `当前不可用：${reason}。`,
      "请先启动或重新启动 ChatGPT Desktop，然后重试。",
      `状态检查：codex-bridge status`,
      `如确实要绕过此保护，请显式使用：codex-standalone`,
      "",
    ].join("\n"),
  );
}

try {
  const command = topLevelCommand(args);
  const positional = positionalArguments(args);
  const isAppServerProxy = command === "app-server" && positional[1] === "proxy";
  if (standaloneEntrypoint || command === "update") {
    log.event("route", { action: "standalone", reason: standaloneEntrypoint ? "explicit-standalone" : "update" });
    await run(
      standaloneCodexPath(),
      args,
      standaloneEnvironment({ update: command === "update" }),
    );
  } else if (isAppServerProxy) {
    log.event("route", { action: "shared-proxy" });
    const status = await bridgeStatus();
    if (!status.ok) {
      printUnavailable(status.reason);
      process.exitCode = sysexits.unavailable;
    } else {
      await run(
        resourceCodexPath(),
        forceProxySocket(args, runtimePaths().socketPath),
      );
    }
  } else if (command === "app-server" && await isComputerUseHelper(args)) {
    log.event("route", { action: "pass-through", reason: "verified-computer-use-stdio" });
    await run(resourceCodexPath(), args);
  } else if (blockedServerCommands.has(command)) {
    log.event("route", { action: "blocked", reason: "second-server", command });
    process.stderr.write(
      `已阻止 \`codex ${command}\`，以免创建第二个 App Server。\n` +
        "如确实需要，请显式使用 codex-standalone。\n",
    );
    process.exitCode = sysexits.unavailable;
  } else if (
    command === "help" ||
    args.includes("--help") ||
    args.includes("-h") ||
    args.includes("--version") ||
    args.includes("-V")
  ) {
    log.event("route", { action: "pass-through", reason: "help-or-version" });
    await run(resourceCodexPath(), args);
  } else {
    const needsBridge =
      command == null || remoteCommands.has(command) || agentCommandsWithoutAppServer.has(command);
    if (!needsBridge) {
      log.event("route", { action: "pass-through", reason: "command-without-bridge", command });
      await run(resourceCodexPath(), args);
    } else if (hasExplicitRemote(args)) {
      log.event("route", { action: "blocked", reason: "explicit-remote" });
      process.stderr.write(
        "普通 codex 命令不允许覆盖共享 App Server 地址；请使用 codex-standalone 显式连接其他端点。\n",
      );
      process.exitCode = sysexits.config;
    } else {
      const status = await bridgeStatus();
      if (!status.ok) {
        printUnavailable(status.reason);
        process.exitCode = sysexits.unavailable;
      } else if (agentCommandsWithoutAppServer.has(command)) {
        log.event("route", { action: "pass-through", reason: "agent-command-after-health-check", serverPid: status.state?.serverPid });
        await run(resourceCodexPath(), args);
      } else {
        log.event("route", { action: "shared-remote", serverPid: status.state?.serverPid, generation: status.state?.generation });
        await run(
          resourceCodexPath(),
          sharedRemoteInvocationArgs({
            args,
            command,
            cwd: process.cwd(),
            socketPath: runtimePaths().socketPath,
          }),
        );
      }
    }
  }
} catch (error) {
  log.event("guard.failed", errorFields(error));
  process.stderr.write(`${error.message}\n`);
  process.exitCode = sysexits.software;
} finally {
  await log.close();
}
