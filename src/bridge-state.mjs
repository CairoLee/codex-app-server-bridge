import fs from "node:fs/promises";
import { isProcessAlive } from "./process-utils.mjs";
import { probeAppServer } from "./websocket-uds.mjs";
import { readJson } from "./atomic-file.mjs";
import {
  resourceCodexPath,
  runtimePaths,
  stateMagic,
} from "./settings.mjs";

export async function readBridgeState(env = process.env) {
  return await readJson(runtimePaths(env).statePath);
}

export async function bridgeStatus(env = process.env, options = {}) {
  const paths = runtimePaths(env);
  const state = await readBridgeState(env).catch((error) => ({ readError: error }));
  if (state?.readError) {
    return { ok: false, reason: `state file is unreadable: ${state.readError.message}` };
  }
  if (state == null) return { ok: false, reason: "state file is missing" };
  if (state.magic !== stateMagic) {
    return { ok: false, reason: "state file belongs to an unknown manager", state };
  }
  if (state.status !== "ready") {
    return { ok: false, reason: `shared server state is ${state.status}`, state };
  }
  if (!isProcessAlive(state.ownerPid)) {
    return { ok: false, reason: "ChatGPT owner process is not running", state };
  }
  if (!isProcessAlive(state.supervisorPid)) {
    return { ok: false, reason: "shared server supervisor is not running", state };
  }
  if (!isProcessAlive(state.serverPid)) {
    return { ok: false, reason: "shared App Server process is not running", state };
  }
  if (state.resourceCodexPath !== resourceCodexPath(env)) {
    return { ok: false, reason: "shared server uses a different resource Codex path", state };
  }
  if (state.socketPath !== paths.socketPath) {
    return { ok: false, reason: "shared server uses a different socket", state };
  }
  if (state.appToolsPipePath) {
    try {
      const pipe = await fs.lstat(state.appToolsPipePath);
      if (!pipe.isSocket()) {
        return { ok: false, reason: "ChatGPT App Tools pipe is not a socket", state };
      }
    } catch {
      return { ok: false, reason: "ChatGPT App Tools pipe is unavailable", state };
    }
  }
  try {
    const serverInfo = await probeAppServer(paths.socketPath, {
      timeoutMs: options.timeoutMs || 2_500,
    });
    return { ok: true, state, serverInfo };
  } catch (error) {
    return { ok: false, reason: `App Server probe failed: ${error.message}`, state };
  }
}
