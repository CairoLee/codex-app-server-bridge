import { EventEmitter } from "node:events";
import { connectUnixWebSocket } from "./websocket-uds.mjs";
import { createRpcDiagnostics } from "./rpc-diagnostics.mjs";

const consumeLateSocketError = () => {};

async function writeStdout(text, output) {
  await new Promise((resolve, reject) => {
    try {
      output.write(`${text}\n`, (error) => {
        if (error) reject(error);
        else resolve();
      });
    } catch (error) {
      reject(error);
    }
  });
}

function raceWithTerminal(operation, events, getTerminalState) {
  const currentState = getTerminalState();
  if (currentState != null) {
    return Promise.resolve({ type: "terminal", state: currentState });
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => events.off("terminal", onTerminal);
    const onTerminal = (state) => {
      cleanup();
      resolve({ type: "terminal", state });
    };
    events.once("terminal", onTerminal);
    Promise.resolve().then(() => operation()).then(
      (value) => {
        cleanup();
        resolve({ type: "operation", value });
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function sendWhileOpen(websocket, text, events, getTerminalState) {
  const outcome = await raceWithTerminal(
    () => websocket.sendText(text),
    events,
    getTerminalState,
  );
  if (outcome.type === "terminal" && outcome.state.type === "error") {
    throw outcome.state.error;
  }
  return outcome.type === "operation";
}

function stopInput(input, iterator) {
  if (typeof input.destroy === "function" && !input.destroyed) input.destroy();
  try {
    Promise.resolve(iterator.return?.()).catch(() => {});
  } catch {
    // bridge 正在退出，迭代器清理失败不应阻止退出。
  }
}

export async function bridgeStdioToAppServer(
  socketPath,
  {
    log,
    input = process.stdin,
    output = process.stdout,
    connect = connectUnixWebSocket,
  } = {},
) {
  const startedAt = Date.now();
  const counts = { sentMessages: 0, receivedMessages: 0, skippedEmptyLines: 0 };
  const websocket = await connect(socketPath, { timeoutMs: 5_000 });
  const diagnostics = createRpcDiagnostics({ log });
  log?.event("bridge.connected", { connectionId: diagnostics.connectionId });

  let terminalState = null;
  let firstFailure = null;
  let terminalSignaled = false;
  let endReason = "error";
  let stdinEnded = false;
  const terminalEvents = new EventEmitter();
  const finish = (state) => {
    if (state.type === "error") {
      firstFailure ??= state.error;
      terminalState = { type: "error", error: firstFailure };
      endReason = "error";
    } else if (terminalState == null) {
      terminalState = state;
      endReason = stdinEnded ? "stdin-eof" : "peer-close";
    }
    if (!terminalSignaled) {
      terminalSignaled = true;
      terminalEvents.emit("terminal", terminalState);
    }
  };
  const onWebSocketClose = () => finish({ type: "close" });
  const onWebSocketError = (error) => finish({ type: "error", error });
  const onOutputError = (error) => {
    finish({ type: "error", error });
    websocket.destroy(error);
  };
  websocket.once("close", onWebSocketClose);
  websocket.on("error", onWebSocketError);
  output.on("error", onOutputError);

  let incoming = Promise.resolve();
  const onWebSocketMessage = (message) => {
    counts.receivedMessages += 1;
    const observation = diagnostics.observe("server", message);
    incoming = incoming.then(async () => {
      await writeStdout(message, output);
      diagnostics.forwarded(observation);
    });
    incoming.catch((error) => {
      finish({ type: "error", error });
      websocket.destroy(error);
    });
  };
  websocket.on("message", onWebSocketMessage);

  input.setEncoding?.("utf8");
  const iterator = input[Symbol.asyncIterator]();
  let inputStopped = false;
  const cancelInput = () => {
    if (inputStopped) return;
    inputStopped = true;
    stopInput(input, iterator);
  };
  let pending = "";
  try {
    for (;;) {
      const next = await raceWithTerminal(
        () => iterator.next(),
        terminalEvents,
        () => terminalState,
      );
      if (next.type === "terminal") {
        cancelInput();
        if (next.state.type === "error") throw next.state.error;
        break;
      }
      if (next.value.done) {
        stdinEnded = true;
        endReason = "stdin-eof";
        break;
      }

      pending += next.value.value;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        if (line.length > 0) {
          const observation = diagnostics.observe("client", line);
          if (!(await sendWhileOpen(websocket, line, terminalEvents, () => terminalState))) break;
          diagnostics.forwarded(observation);
          counts.sentMessages += 1;
        } else {
          counts.skippedEmptyLines += 1;
        }
        if (terminalState != null) break;
      }
      if (terminalState?.type === "error") throw terminalState.error;
      if (terminalState?.type === "close") {
        cancelInput();
        break;
      }
    }

    if (terminalState == null && pending.length > 0) {
      const observation = diagnostics.observe("client", pending.replace(/\r$/u, ""));
      if (await sendWhileOpen(
        websocket,
        pending.replace(/\r$/u, ""),
        terminalEvents,
        () => terminalState,
      )) {
        diagnostics.forwarded(observation);
        counts.sentMessages += 1;
      }
    }

    if (terminalState == null) {
      await websocket.close();
      await raceWithTerminal(
        () => new Promise((resolve) => setTimeout(resolve, 1_000)),
        terminalEvents,
        () => terminalState,
      );
    }
    await incoming;
  } catch (error) {
    firstFailure ??= error;
    endReason = "error";
    websocket.destroy(error);
  } finally {
    if (!stdinEnded) cancelInput();
    output.off("error", onOutputError);
    websocket.off("close", onWebSocketClose);
    websocket.off("message", onWebSocketMessage);
    websocket.off("error", onWebSocketError);
    websocket.on("error", consumeLateSocketError);
    diagnostics.close(endReason);
    log?.event("bridge.closed", { ...counts, durationMs: Date.now() - startedAt, reason: endReason, connectionId: diagnostics.connectionId });
  }
  if (firstFailure) throw firstFailure;
}
