import { spawn } from "node:child_process";
import { readJson, removeIfExists, writeJsonAtomic } from "./atomic-file.mjs";
import { withUnixSocketTransport } from "./app-server-args.mjs";
import { isProcessAlive } from "./process-utils.mjs";
import { probeAppServer } from "./websocket-uds.mjs";

import { createRuntimeLogger, sanitizeArgs, errorFields } from "./runtime-log.mjs";

const launchConfigPath = process.argv[2];
if (!launchConfigPath) throw new Error("supervisor launch config path is required");
const config = await readJson(launchConfigPath);
if (config == null) throw new Error(`missing supervisor config ${launchConfigPath}`);

const log = createRuntimeLogger({ component: "supervisor", directory: config.runtimeLogDirectory });
log.event("supervisor.started", { ownerPid: config.ownerPid, generation: config.generation });
let child = null;
let stopping = false;
let monitor = null;

async function publish(status, extra = {}) {
  await writeJsonAtomic(config.statePath, {
    magic: config.magic,
    generation: config.generation,
    launchKey: config.launchKey,
    status,
    ownerPid: config.ownerPid,
    supervisorPid: process.pid,
    supervisorPath: config.supervisorPath,
    serverPid: child?.pid || null,
    socketPath: config.socketPath,
    appToolsPipePath: config.appToolsPipePath,
    resourceCodexPath: config.resourceCodexPath,
    resourceIdentity: config.resourceIdentity,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
}

async function waitForReady(timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (child?.exitCode != null) {
      throw new Error(`resource App Server exited with code ${child.exitCode}`);
    }
    try {
      return await probeAppServer(config.socketPath, { timeoutMs: 1_000 });
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`resource App Server was not ready: ${lastError?.message || "timeout"}`);
}

async function cleanupState(preserveState = false) {
  const state = await readJson(config.statePath).catch(() => null);
  if (state?.generation === config.generation) {
    if (!preserveState) await removeIfExists(config.statePath);
    await removeIfExists(config.socketPath);
  }
  await removeIfExists(launchConfigPath);
}

async function stop(exitCode = 0, preserveState = false) {
  if (stopping) return;
  stopping = true;
  log.event("supervisor.stopping", { exitCode, preserveState, childPid: child?.pid });
  if (monitor) clearInterval(monitor);
  if (child && child.exitCode == null && child.signalCode == null) {
    child.kill("SIGTERM");
    const exited = await Promise.race([
      new Promise((resolve) => child.once("exit", () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    if (!exited && child.exitCode == null) child.kill("SIGKILL");
  }
  await cleanupState(preserveState).catch(() => {});
  await log.close();
  process.exit(exitCode);
}

process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));

try {
  await publish("starting");
  await removeIfExists(config.socketPath);
  child = spawn(
    config.resourceCodexPath,
    withUnixSocketTransport(config.args, config.socketPath),
    {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  log.capture("app-server.stdout", child.stdout);
  log.capture("app-server.stderr", child.stderr);
  child.on("error", (error) => {
    log.event("child.error", errorFields(error));
  });
  log.event("child.started", { childPid: child.pid, executable: config.resourceCodexPath, args: sanitizeArgs(withUnixSocketTransport(config.args, config.socketPath)), generation: config.generation });
  if (!child.pid) throw new Error("failed to spawn resource App Server");
  child.once("exit", (code, signal) => {
    log.event("child.exited", { childPid: child.pid, code, signal });
    if (!stopping) {
      void publish("failed", {
        error: `resource App Server exited unexpectedly: code=${code} signal=${signal}`,
      }).finally(() => stop(1, true));
    }
  });
  const serverInfo = await waitForReady();
  await publish("ready", { serverInfo });
  log.event("server.ready", { serverPid: child.pid, generation: config.generation, socketPath: config.socketPath });
  monitor = setInterval(() => {
    if (!isProcessAlive(config.ownerPid)) {
      log.event("owner.exited", { ownerPid: config.ownerPid });
      void stop(0);
    }
  }, 500);
  monitor.unref();
} catch (error) {
  log.event("server.failed", errorFields(error));
  await publish("failed", { error: error?.stack || String(error) }).catch(() => {});
  await stop(1, true);
}
