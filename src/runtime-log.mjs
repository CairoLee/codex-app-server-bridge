import fs from "node:fs/promises";
import path from "node:path";
import { runtimePaths } from "./settings.mjs";

const FLUSH_DELAY_MS = 25;
const MAX_QUEUE_LENGTH = 1024;
const MAX_CAPTURE_CHARS = 4096;
const MAX_RECORD_BYTES = 60 * 1024;
const MAX_APPEND_BYTES = 64 * 1024;
const LOG_NAME = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u;
const REDACTED = "<redacted>";
const KNOWN_COMMANDS = new Set([
  "agents", "exec", "review", "login", "logout", "mcp", "plugin",
  "mcp-server", "app-server", "remote-control", "app", "completion",
  "update", "doctor", "sandbox", "debug", "apply", "resume", "queue",
  "archive", "delete", "migrate-rollouts", "unarchive", "fork", "cloud",
  "exec-server", "features", "help", "proxy",
]);

function localDateKey(date) {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function retentionCutoff(date) {
  const cutoff = new Date(date);
  cutoff.setHours(0, 0, 0, 0);
  cutoff.setDate(cutoff.getDate() - 2);
  return localDateKey(cutoff);
}

function isSensitiveFlag(flag) {
  return /(?:token|password|passwd|secret|api[_-]?key|private[_-]?key|credential)/iu.test(
    flag,
  );
}

function isSafeConfig(value) {
  return /^features\.[a-z0-9_.-]+=true$/iu.test(value);
}

/**
 * Keep CLI structure useful for diagnosis without retaining prompts, paths, or
 * credentials. Config values are hidden except feature enablement switches.
 */
export function sanitizeArgs(args) {
  const result = [];
  let commandSeen = false;
  let previousFlag;
  let afterSeparator = false;

  for (const rawArgument of args ?? []) {
    const argument = String(rawArgument);
    if (afterSeparator) {
      result.push(REDACTED);
      continue;
    }
    if (argument === "--") {
      result.push(argument);
      afterSeparator = true;
      previousFlag = undefined;
      continue;
    }
    if (argument.startsWith("-") && argument !== "-") {
      const equals = argument.indexOf("=");
      if (equals !== -1) {
        const flag = argument.slice(0, equals);
        const value = argument.slice(equals + 1);
        result.push(
          `${flag}=${!isSensitiveFlag(flag) && isSafeConfig(value) ? value : REDACTED}`,
        );
        previousFlag = undefined;
      } else {
        // A value attached to a short option is indistinguishable from secret
        // input, so retain only the option letter.
        result.push(/^-[^-].+/u.test(argument) ? `${argument.slice(0, 2)}${REDACTED}` : argument);
        previousFlag = argument;
      }
      continue;
    }

    if (!commandSeen && previousFlag == null && KNOWN_COMMANDS.has(argument)) {
      result.push(argument);
      commandSeen = true;
    } else if (
      previousFlag != null &&
      !isSensitiveFlag(previousFlag) &&
      isSafeConfig(argument)
    ) {
      result.push(argument);
    } else {
      result.push(REDACTED);
    }
    previousFlag = undefined;
  }
  return result;
}

export function errorFields(error) {
  if (error == null || typeof error !== "object") return {};
  const fields = {};
  if (typeof error.name === "string") fields.name = error.name;
  if (typeof error.code === "string" || typeof error.code === "number") {
    fields.code = error.code;
  }
  return fields;
}

export function createRuntimeLogger({
  env = process.env,
  component,
  directory = path.join(runtimePaths(env).stateDir, "runtime-logs"),
  now = () => new Date(),
} = {}) {
  const enabled = env.CODEX_BRIDGE_RUNTIME_LOG !== "0";
  let queue = [];
  let dropped = 0;
  let flushTimer;
  let rotationTimer;
  let closed = false;
  let writePromise;
  let initializationPromise = Promise.resolve();
  let prepareRequested = false;
  let preparedDate;
  const captures = new Set();

  async function prepare(date) {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    await fs.chmod(directory, 0o700);
    const cutoff = retentionCutoff(date);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    await Promise.all(
      entries.map(async (entry) => {
        const match = entry.isFile() && LOG_NAME.exec(entry.name);
        if (match && match[1] < cutoff) {
          await fs.unlink(path.join(directory, entry.name)).catch(() => {});
        }
      }),
    );
    preparedDate = localDateKey(date);
  }

  async function appendBatch(batch) {
    const groups = new Map();
    for (const item of batch) {
      const records = groups.get(item.date) ?? [];
      records.push(item.line);
      groups.set(item.date, records);
    }
    for (const [date, records] of groups) {
      const file = path.join(directory, `${date}.jsonl`);
      const handle = await fs.open(file, "a", 0o600);
      try {
        await handle.chmod(0o600);
        let payload = "";
        let payloadBytes = 0;
        for (const record of records) {
          const line = `${record}\n`;
          const lineBytes = Buffer.byteLength(line);
          if (payloadBytes > 0 && payloadBytes + lineBytes > MAX_APPEND_BYTES) {
            await handle.write(payload, null, "utf8");
            payload = "";
            payloadBytes = 0;
          }
          payload += line;
          payloadBytes += lineBytes;
        }
        if (payloadBytes > 0) await handle.write(payload, null, "utf8");
      } finally {
        await handle.close();
      }
    }
  }

  async function writeQueued() {
    await initializationPromise;
    while (queue.length > 0 || dropped > 0 || prepareRequested) {
      const batch = queue;
      queue = [];
      if (dropped > 0) {
        const date = now();
        batch.push({
          date: localDateKey(date),
          line: JSON.stringify({
            time: date.toISOString(), component, pid: process.pid, ppid: process.ppid,
            event: "runtime_log_dropped", count: dropped,
          }),
        });
        dropped = 0;
      }
      const date = now();
      const needsPrepare = prepareRequested || preparedDate !== localDateKey(date);
      prepareRequested = false;
      if (needsPrepare) await prepare(date);
      if (batch.length > 0) await appendBatch(batch);
    }
  }

  function drain(forcePrepare = false) {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = undefined;
    if (forcePrepare) prepareRequested = true;
    if (!writePromise) {
      writePromise = writeQueued()
        .catch(() => {})
        .finally(() => {
          writePromise = undefined;
          if (queue.length > 0 || dropped > 0 || prepareRequested) scheduleFlush();
        });
    }
    return writePromise;
  }

  function scheduleFlush() {
    if (flushTimer || closed) return;
    flushTimer = setTimeout(drain, FLUSH_DELAY_MS);
    flushTimer.unref?.();
  }

  function scheduleRotation() {
    if (closed) return;
    const date = now();
    const next = new Date(date);
    next.setHours(24, 0, 0, 50);
    rotationTimer = setTimeout(() => {
      rotationTimer = undefined;
      drain(true);
      scheduleRotation();
    }, Math.min(2_147_483_647, Math.max(50, next.getTime() - date.getTime())));
    rotationTimer.unref?.();
  }

  function event(name, fields = {}) {
    if (closed || !enabled) return;
    const date = now();
    const record = {
      time: date.toISOString(),
      component,
      pid: process.pid,
      ppid: process.ppid,
      event: name,
      ...fields,
    };
    if (queue.length >= MAX_QUEUE_LENGTH) {
      dropped += 1;
      return;
    }
    try {
      const line = JSON.stringify(record);
      if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
        dropped += 1;
        scheduleFlush();
        return;
      }
      queue.push({ date: localDateKey(date), line });
    } catch {
      // Diagnostics must never change application behavior. Circular objects,
      // BigInts, and custom serializers are therefore treated as dropped logs.
      dropped += 1;
      scheduleFlush();
      return;
    }
    scheduleFlush();
  }

  function capture(streamName, readable) {
    if (!readable?.on) return () => {};
    let windowStarted = now().getTime();
    let chunksThisWindow = 0;
    let suppressed = 0;
    const reportSuppressed = () => {
      if (suppressed > 0) {
        event("process_output_suppressed", { stream: streamName, count: suppressed });
        suppressed = 0;
      }
    };
    const onData = (chunk) => {
      if (!enabled) return;
      const timestamp = now().getTime();
      if (timestamp - windowStarted >= 1000) {
        reportSuppressed();
        windowStarted = timestamp;
        chunksThisWindow = 0;
      }
      if (chunksThisWindow >= 32) {
        suppressed += 1;
        return;
      }
      chunksThisWindow += 1;
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      event("process_output", {
        stream: streamName,
        chunk: text.slice(0, MAX_CAPTURE_CHARS),
        truncated: text.length > MAX_CAPTURE_CHARS,
      });
    };
    readable.on("data", onData);
    const release = () => {
      readable.off?.("data", onData);
      reportSuppressed();
      captures.delete(release);
    };
    captures.add(release);
    return release;
  }

  // Output capture deliberately records raw, bounded process output. Callers
  // must only attach streams whose contents are suitable for local diagnostics.
  if (enabled) {
    scheduleRotation();
    initializationPromise = prepare(now()).catch(() => {});
  }

  async function flush() {
    do {
      await drain();
    } while (queue.length > 0 || dropped > 0 || prepareRequested || writePromise);
  }

  return {
    enabled,
    event,
    capture,
    flush,
    async close() {
      if (closed) return await (writePromise ?? initializationPromise);
      if (rotationTimer) clearTimeout(rotationTimer);
      for (const release of [...captures]) release();
      closed = true;
      return await flush();
    },
  };
}
