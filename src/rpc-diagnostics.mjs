import { createHmac, randomBytes, randomUUID } from "node:crypto";

const METHODS = new Set([
  "initialize", "config/read", "configRequirements/read", "config/value/write",
  "config/batchWrite", "thread/start", "thread/resume", "thread/fork", "thread/read",
  "thread/list", "thread/turns/list", "thread/items/list", "thread/archive",
  "turn/start", "turn/steer", "turn/interrupt", "plugin/list", "plugin/read",
  "plugin/installed", "skills/list", "mcpServerStatus/list", "fs/getMetadata",
  "fs/readFile", "account/read", "getAuthStatus", "account/rateLimits/read", "model/list",
]);
const WARNINGS = new Set(["configWarning", "deprecationNotice", "warning", "error"]);
const MAX_MESSAGE_CHARS = 256 * 1024;
const MAX_PENDING = 256;
const MAX_EVENTS_PER_MINUTE = 32;
const SLOW_MS = 5_000;
const PENDING_MS = 30_000;
const EXPIRE_MS = 10 * 60_000;

function object(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function errorKind(message) {
  if (typeof message !== "string") return "other";
  if (/code_mode_tool_description_first.*ignored|unknown feature key.*code_mode_tool_description_first/u.test(message)) return "unsupported-feature";
  if (/guardianv2.*thread_context.*deprecated/u.test(message)) return "deprecated-guardian-context";
  if (/invalid remote plugin id/iu.test(message)) return "invalid-plugin-id";
  if (/access denied|permission denied|forbidden/iu.test(message)) return "access-denied";
  if (/requires an environmentId/u.test(message)) return "environment-id-required";
  if (/thread not loaded/iu.test(message)) return "thread-not-loaded";
  if (/No such file or directory|ENOENT/u.test(message)) return "not-found";
  if (/timed out|timeout/iu.test(message)) return "timeout";
  return "other";
}

/** 仅旁路观察，不改变协议内容；外部文本经白名单或连接级匿名化处理。 */
export function createRpcDiagnostics({ log, now = () => performance.now(), schedule = true } = {}) {
  const noop = () => {};
  if (!log || log.enabled === false) return { observe: noop, forwarded: noop, sweep: noop, close: noop };
  const connectionId = randomUUID();
  const salt = randomBytes(32);
  const pending = new Map();
  let sequence = 0;
  let closed = false;
  let windowStart = now();
  let emitted = 0;
  let stats = {};
  let warnings = {};
  let failures = {};
  const count = (key, amount = 1) => { stats[key] = (stats[key] ?? 0) + amount; };
  const safe = (fn) => (...args) => {
    if (closed) return;
    try { return fn(...args); } catch { count("observerFailures"); }
  };
  const emit = (event, fields, limited = true) => {
    if (limited && emitted >= MAX_EVENTS_PER_MINUTE) { count("suppressedEvents"); return; }
    if (limited) emitted += 1;
    try { log.event(event, { connectionId, ...fields }); } catch { count("loggerFailures"); }
  };
  const reference = (value) => typeof value === "string" && value.length <= 256
    ? createHmac("sha256", salt).update(value).digest("hex").slice(0, 16) : undefined;
  const key = (direction, id) => {
    if ((typeof id === "string" && id.length <= 256) || Number.isSafeInteger(id)) {
      return JSON.stringify([direction, id]);
    }
    return null;
  };
  const metadata = (method, params) => {
    if (!object(params)) return {};
    const fields = {};
    const threadRef = reference(params.threadId);
    if (threadRef) fields.threadRef = threadRef;
    if (method.startsWith("fs/")) fields.environmentIdPresent = typeof params.environmentId === "string" && params.environmentId.length > 0;
    if (method === "config/read" || method === "thread/start") fields.cwdPresent = typeof params.cwd === "string" && params.cwd.length > 0;
    if (method === "plugin/read") {
      const name = params.pluginName;
      fields.pluginNameKind = typeof name !== "string" ? "missing" : name.startsWith("plugin_connector_")
        ? "remote-id" : name.includes("@") ? "qualified-name" : /^[a-z0-9-]+$/u.test(name) ? "name" : "other";
      const pluginRef = reference(name);
      if (pluginRef) fields.pluginRef = pluginRef;
      const local = params.marketplacePath != null;
      const remote = params.remoteMarketplaceName != null;
      fields.marketplaceSource = local && remote ? "both" : local ? "local" : remote ? "remote" : "missing";
    }
    return fields;
  };
  const summary = () => {
    if (Object.keys(stats).length || Object.keys(warnings).length) {
      emit("rpc.summary", { ...stats, warnings, failures, pendingCount: pending.size }, false);
    }
    stats = {};
    warnings = {};
    failures = {};
  };
  const sweep = safe(() => {
    const time = now();
    if (time - windowStart >= 60_000) {
      summary();
      windowStart = time;
      emitted = 0;
    }
    for (const [id, request] of pending) {
      const ageMs = Math.max(0, Math.round(time - request.startedAt));
      if (ageMs >= EXPIRE_MS) {
        pending.delete(id);
        count("expiredTracking");
      } else if (ageMs >= PENDING_MS && !request.reportedPending) {
        request.reportedPending = true;
        const { startedAt, reportedPending, ...fields } = request;
        emit("rpc.pending", { ...fields, ageMs });
      }
    }
  });
  const observe = safe((direction, text) => {
    if (direction !== "client" && direction !== "server") return;
    sweep();
    if (typeof text !== "string") return;
    if (text.length > MAX_MESSAGE_CHARS) {
      count("oversizedMessages");
      // 大响应可能已完成某个请求，重置观察状态，避免随后误报仍在等待。
      count("coverageLostRequests", pending.size);
      pending.clear();
      return;
    }
    let message;
    try { message = JSON.parse(text); } catch { count("invalidJson"); return; }
    if (!object(message)) { count("unsupportedEnvelopes"); return; }
    if (typeof message.method === "string") {
      if (message.id != null) {
        count("requests");
        const id = key(direction, message.id);
        if (id == null) { count("untrackedIds"); return; }
        if (pending.has(id)) { pending.delete(id); count("reusedIds"); }
        if (pending.size >= MAX_PENDING) {
          pending.delete(pending.keys().next().value);
          count("evictedTracking");
        }
        const method = METHODS.has(message.method) ? message.method : "other";
        const request = {
          requestRef: `${direction === "client" ? "c" : "s"}${++sequence}`,
          direction, method, forwarding: "observed",
          ...metadata(method, message.params), startedAt: now(),
        };
        pending.set(id, request);
        return request;
      } else if (WARNINGS.has(message.method)) {
        const kind = errorKind(message.params?.summary ?? message.params?.message);
        const label = `${message.method}:${kind}`;
        warnings[label] = (warnings[label] ?? 0) + 1;
      }
      return;
    }
    if (message.id == null || !("result" in message || "error" in message)) return;
    const requestDirection = direction === "server" ? "client" : "server";
    const id = key(requestDirection, message.id);
    const request = pending.get(id);
    pending.delete(id);
    count("responses");
    if (!request) count("unmatchedResponses");
    const durationMs = request ? Math.max(0, Math.round(now() - request.startedAt)) : undefined;
    const { startedAt, reportedPending, forwarding, ...fields } = request ?? { direction: requestDirection, method: "unknown" };
    if (object(message.error)) {
      const code = Number.isSafeInteger(message.error.code) ? message.error.code : undefined;
      const status = message.error.data?.statusCode;
      const kind = errorKind(message.error.message);
      const label = `${fields.method}:${kind}`;
      failures[label] = (failures[label] ?? 0) + 1;
      count("failedResponses");
      emit("rpc.failed", {
        ...fields, durationMs, code, kind,
        ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { statusCode: status } : {}),
      });
    } else if (durationMs >= SLOW_MS) {
      emit("rpc.slow", { ...fields, durationMs });
    }
  });
  const timer = schedule ? setInterval(sweep, 5_000) : null;
  timer?.unref?.();
  return {
    connectionId, observe, sweep,
    // 先登记再发送才能关联同步返回；发送完成后单独标记，不把已观察当作已发送。
    forwarded: safe((request) => {
      if (request?.forwarding === "observed") request.forwarding = "submitted";
    }),
    close: safe((reason) => {
      if (timer) clearInterval(timer);
      if (pending.size) {
        const sample = [...pending.values()].slice(0, 8).map(({ startedAt, reportedPending, ...fields }) => ({
          ...fields, ageMs: Math.max(0, Math.round(now() - startedAt)),
        }));
        emit("rpc.interrupted", {
          reason: ["stdin-eof", "peer-close", "error"].includes(reason) ? reason : "unknown",
          pendingCount: pending.size, sample,
        }, false);
      }
      summary();
      pending.clear();
      closed = true;
    }),
  };
}
