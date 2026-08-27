import fs from "node:fs/promises";
import path from "node:path";
import {
  readJson,
  removeIfExists,
  writeJsonAtomic,
} from "./atomic-file.mjs";
import { stateDirectory } from "./settings.mjs";

const defaultDurationMs = 6 * 60 * 60 * 1_000;
const defaultMaxRecords = 64;
const sensitiveEnvironmentName =
  /(AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)/iu;
const diagnosticEnvironmentName =
  /^(APP_SANDBOX|BROWSER|CHATGPT|CODEX|ELECTRON|MCP|NODE|SANDBOX|TMPDIR)/iu;
const safeArgumentToken =
  /^(?:-?[a-z][a-z0-9-]*|--[a-z][a-z0-9-]*|[0-9]+)$/iu;
const valueTakingArguments = new Set([
  "--listen",
  "--remote",
  "--sock",
  "--socket",
]);

export function launcherDiagnosticsPaths(env = process.env) {
  const configured = env.CODEX_BRIDGE_DIAGNOSTICS_DIR?.trim();
  const uid = process.getuid?.() ?? "user";
  const directory =
    configured || path.join("/tmp", `codex-app-server-bridge-diagnostics-${uid}`);
  return {
    directory,
    configPath: path.join(stateDirectory(env), "launcher-diagnostics.json"),
    legacyMarkerPath: path.join(directory, "launcher-trace-enabled.json"),
    tracePath: path.join(directory, "launcher-invocations.jsonl"),
  };
}

export function sanitizeLauncherArguments(args) {
  const sanitized = [];
  let redactNext = false;
  let redactConfig = false;
  for (const argument of args) {
    if (redactNext) {
      sanitized.push("<redacted>");
      redactNext = false;
      continue;
    }
    if (redactConfig) {
      const separator = argument.indexOf("=");
      sanitized.push(
        separator > 0
          ? `${argument.slice(0, separator)}=<redacted>`
          : "<redacted>",
      );
      redactConfig = false;
      continue;
    }
    if (argument === "-c" || argument === "--config") {
      sanitized.push(argument);
      redactConfig = true;
      continue;
    }
    if (valueTakingArguments.has(argument)) {
      sanitized.push(argument);
      redactNext = true;
      continue;
    }
    const equals = argument.indexOf("=");
    if (equals > 0) {
      sanitized.push(`${argument.slice(0, equals)}=<redacted>`);
      continue;
    }
    sanitized.push(safeArgumentToken.test(argument) ? argument : "<redacted>");
  }
  return sanitized;
}

export function diagnosticEnvironmentNames(env) {
  return Object.keys(env)
    .filter(
      (name) =>
        diagnosticEnvironmentName.test(name) &&
        !sensitiveEnvironmentName.test(name),
    )
    .sort();
}

function validatePrivateDirectory(metadata) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("diagnostic path is not a regular directory");
  }
  const uid = process.getuid?.();
  if (uid != null && metadata.uid !== uid) {
    throw new Error("diagnostic directory belongs to another user");
  }
}

async function privateDirectoryExists(directory) {
  try {
    const metadata = await fs.lstat(directory);
    validatePrivateDirectory(metadata);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  validatePrivateDirectory(await fs.lstat(directory));
  await fs.chmod(directory, 0o700);
}

async function traceRecordCount(tracePath) {
  try {
    const content = await fs.readFile(tracePath, "utf8");
    return content.split("\n").filter(Boolean).length;
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
}

export async function armLauncherDiagnostics({
  env = process.env,
  now = new Date(),
  durationMs = defaultDurationMs,
  maxRecords = defaultMaxRecords,
} = {}) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("diagnostic duration must be positive");
  }
  if (!Number.isInteger(maxRecords) || maxRecords <= 0) {
    throw new Error("diagnostic record limit must be a positive integer");
  }
  const paths = launcherDiagnosticsPaths(env);
  await ensurePrivateDirectory(path.dirname(paths.configPath));
  await ensurePrivateDirectory(paths.directory);
  await removeIfExists(paths.tracePath);
  await removeIfExists(paths.legacyMarkerPath);
  const config = {
    schemaVersion: 1,
    enabled: true,
    armedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + durationMs).toISOString(),
    maxRecords,
  };
  await writeJsonAtomic(paths.configPath, config);
  return { ...paths, config };
}

export async function disableLauncherDiagnostics({ env = process.env } = {}) {
  const paths = launcherDiagnosticsPaths(env);
  await removeIfExists(paths.configPath);
  if (await privateDirectoryExists(paths.directory)) {
    await removeIfExists(paths.legacyMarkerPath);
  }
  return paths;
}

export async function clearLauncherDiagnostics({ env = process.env } = {}) {
  const paths = await disableLauncherDiagnostics({ env });
  if (!(await privateDirectoryExists(paths.directory))) return paths;
  await removeIfExists(paths.tracePath);
  return paths;
}

export async function readLauncherDiagnostics({ env = process.env } = {}) {
  const paths = launcherDiagnosticsPaths(env);
  const config = await readJson(paths.configPath);
  if (!(await privateDirectoryExists(paths.directory))) {
    return { ...paths, config, records: [] };
  }
  let records = [];
  try {
    records = (await fs.readFile(paths.tracePath, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { ...paths, config, records };
}

export async function recordLauncherInvocation({
  env = process.env,
  args = process.argv.slice(2),
  now = new Date(),
  pid = process.pid,
  ppid = process.ppid,
  cwd = process.cwd(),
  execPath = process.execPath,
} = {}) {
  const paths = launcherDiagnosticsPaths(env);
  const config = await readJson(paths.configPath);
  if (config?.enabled !== true) {
    if (config != null) await removeIfExists(paths.configPath);
    return { recorded: false, reason: "disabled" };
  }
  const expiresAt = Date.parse(config.expiresAt);
  if (!Number.isFinite(expiresAt) || now.getTime() > expiresAt) {
    await removeIfExists(paths.configPath);
    return { recorded: false, reason: "expired" };
  }
  if (!Number.isInteger(config.maxRecords) || config.maxRecords <= 0) {
    await removeIfExists(paths.configPath);
    return { recorded: false, reason: "invalid configuration" };
  }
  if (!(await privateDirectoryExists(paths.directory))) {
    await ensurePrivateDirectory(paths.directory);
  }
  const count = await traceRecordCount(paths.tracePath);
  if (count >= config.maxRecords) {
    await removeIfExists(paths.configPath);
    return { recorded: false, reason: "record limit reached" };
  }
  await ensurePrivateDirectory(paths.directory);
  const ownerPid = Number.parseInt(env.CODEX_BRIDGE_OWNER_PID || "", 10);
  const entry = {
    schemaVersion: 1,
    recordedAt: now.toISOString(),
    pid,
    ppid,
    parentMatchesConfiguredOwner:
      Number.isInteger(ownerPid) && ownerPid > 0 ? ownerPid === ppid : null,
    executableName: path.basename(execPath),
    cwdName: path.basename(cwd) || path.parse(cwd).root,
    arguments: sanitizeLauncherArguments(args),
    environmentNames: diagnosticEnvironmentNames(env),
  };
  await fs.appendFile(paths.tracePath, `${JSON.stringify(entry)}\n`, {
    encoding: "utf8",
    flag: "a",
    mode: 0o600,
  });
  await fs.chmod(paths.tracePath, 0o600);
  return { recorded: true, entry, tracePath: paths.tracePath };
}
