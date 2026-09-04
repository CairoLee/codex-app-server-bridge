#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { bridgeStatus } from "./bridge-state.mjs";
import { sharedRemoteInvocationArgs } from "./cli-invocation.mjs";
import {
  resourceCodexPath,
  runtimePaths,
  standaloneCodexPath,
  standaloneInstallDirectory,
  sysexits,
} from "./settings.mjs";

const args = process.argv.slice(2);
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
  const outcome = await new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
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

const command = topLevelCommand(args);
const positional = positionalArguments(args);
const isAppServerProxy = command === "app-server" && positional[1] === "proxy";
if (standaloneEntrypoint || command === "update") {
  await run(
    standaloneCodexPath(),
    args,
    standaloneEnvironment({ update: command === "update" }),
  );
} else if (isAppServerProxy) {
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
} else if (blockedServerCommands.has(command)) {
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
  await run(resourceCodexPath(), args);
} else {
  const needsBridge =
    command == null || remoteCommands.has(command) || agentCommandsWithoutAppServer.has(command);
  if (!needsBridge) {
    await run(resourceCodexPath(), args);
  } else if (hasExplicitRemote(args)) {
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
      await run(resourceCodexPath(), args);
    } else {
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
