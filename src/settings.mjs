import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));

export const projectRoot = path.resolve(sourceDirectory, "..");

export function codexHome(env = process.env) {
  const configured = env.CODEX_HOME?.trim();
  return configured || path.join(os.homedir(), ".codex");
}

export function stateDirectory(env = process.env) {
  const configured = env.CODEX_BRIDGE_STATE_DIR?.trim();
  return configured || path.join(codexHome(env), "codex-app-server-bridge");
}

export function socketPath(env = process.env) {
  const configured = env.CODEX_BRIDGE_SOCKET?.trim();
  return configured || path.join(stateDirectory(env), "app-server.sock");
}

export function resourceCodexPath(env = process.env) {
  const configured = env.CODEX_BRIDGE_RESOURCE_PATH?.trim();
  return configured || "/Applications/ChatGPT.app/Contents/Resources/codex";
}

export function bundledNodePath(env = process.env) {
  const configured = env.CODEX_BRIDGE_NODE_PATH?.trim();
  return (
    configured ||
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
  );
}

export function standaloneCodexPath(env = process.env) {
  const configured = env.CODEX_STANDALONE_PATH?.trim();
  return (
    configured ||
    path.join(codexHome(env), "packages", "standalone", "current", "bin", "codex")
  );
}

export function runtimePaths(env = process.env) {
  const stateDir = stateDirectory(env);
  return {
    stateDir,
    socketPath: socketPath(env),
    statePath: path.join(stateDir, "state.json"),
    lockDirectory: path.join(stateDir, "startup.lock"),
    supervisorLogPath: path.join(stateDir, "supervisor.log"),
    appServerLogPath: path.join(stateDir, "app-server.log"),
  };
}

export const stateMagic = "codex-app-server-bridge-v1";

export const sysexits = {
  unavailable: 69,
  software: 70,
  config: 78,
};
