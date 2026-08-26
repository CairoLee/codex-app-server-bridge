import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { acquireDirectoryLock } from "./lock.mjs";
import { readJson, removeIfExists, writeJsonAtomic } from "./atomic-file.mjs";
import {
  isProcessAlive,
  signalVerifiedProcess,
  waitForProcessExit,
} from "./process-utils.mjs";
import { bridgeStatus } from "./bridge-state.mjs";
import {
  bundledNodePath,
  resourceCodexPath,
  runtimePaths,
  stateMagic,
} from "./settings.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const supervisorPath = path.join(sourceDirectory, "supervisor.mjs");

function launchKey({ args, appToolsPipePath, resourceIdentity }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({ args, appToolsPipePath, resourceIdentity }))
    .digest("hex");
}

async function fileIdentity(filePath) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error(`${filePath} is not a file`);
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedMs: stat.mtimeMs,
  };
}

async function stopExistingManagedServer(state, paths) {
  if (state?.magic !== stateMagic) {
    if (state != null) {
      throw new Error("refusing to replace an unknown shared-server state file");
    }
    return;
  }
  if (isProcessAlive(state.supervisorPid)) {
    await signalVerifiedProcess(state.supervisorPid, supervisorPath, "SIGTERM");
    await waitForProcessExit(state.supervisorPid, 8_000);
  }
  if (isProcessAlive(state.serverPid)) {
    await signalVerifiedProcess(state.serverPid, `unix://${paths.socketPath}`, "SIGTERM");
    if (!(await waitForProcessExit(state.serverPid, 5_000))) {
      await signalVerifiedProcess(state.serverPid, `unix://${paths.socketPath}`, "SIGKILL");
      await waitForProcessExit(state.serverPid, 2_000);
    }
  }
  await removeIfExists(paths.statePath);
  await removeIfExists(paths.socketPath);
}

async function waitForGeneration(env, generation, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastReason = "shared server did not publish state";
  while (Date.now() < deadline) {
    const state = await readJson(runtimePaths(env).statePath).catch(() => null);
    if (state?.generation === generation && state.status === "failed") {
      throw new Error(state.error || "shared App Server failed to start");
    }
    if (state?.generation === generation && state.status === "ready") {
      const status = await bridgeStatus(env, { timeoutMs: 2_500 });
      if (status.ok) return status;
      lastReason = status.reason;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out starting shared App Server: ${lastReason}`);
}

export async function ensureSharedServer({ args, env = process.env, ownerPid }) {
  const paths = runtimePaths(env);
  const resourcePath = resourceCodexPath(env);
  const resourceIdentity = await fileIdentity(resourcePath);
  const appToolsPipePath = env.CODEX_APP_TOOLS_PIPE_PATH?.trim() || null;
  if (!appToolsPipePath) {
    throw new Error("CODEX_APP_TOOLS_PIPE_PATH is missing from ChatGPT Desktop");
  }
  const expectedLaunchKey = launchKey({ args, appToolsPipePath, resourceIdentity });
  await fs.mkdir(paths.stateDir, { recursive: true, mode: 0o700 });
  const release = await acquireDirectoryLock(paths.lockDirectory);
  try {
    const existing = await readJson(paths.statePath).catch(() => null);
    if (
      existing?.magic === stateMagic &&
      existing.launchKey === expectedLaunchKey &&
      existing.ownerPid === ownerPid
    ) {
      const status = await bridgeStatus(env);
      if (status.ok) return status;
    }

    await stopExistingManagedServer(existing, paths);
    const generation = crypto.randomUUID();
    const launchConfigPath = path.join(paths.stateDir, `launch-${generation}.json`);
    await writeJsonAtomic(launchConfigPath, {
      magic: stateMagic,
      generation,
      launchKey: expectedLaunchKey,
      ownerPid,
      args,
      appToolsPipePath,
      resourceCodexPath: resourcePath,
      resourceIdentity,
      socketPath: paths.socketPath,
      statePath: paths.statePath,
      appServerLogPath: paths.appServerLogPath,
    });
    const supervisor = spawn(bundledNodePath(env), [supervisorPath, launchConfigPath], {
      detached: true,
      env,
      stdio: "ignore",
    });
    if (!supervisor.pid) throw new Error("failed to start shared-server supervisor");
    supervisor.unref();
    return await waitForGeneration(env, generation);
  } finally {
    await release();
  }
}
