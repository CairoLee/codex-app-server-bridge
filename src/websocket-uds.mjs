import crypto from "node:crypto";
import net from "node:net";
import { EventEmitter } from "node:events";

const websocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const maximumHeaderBytes = 64 * 1024;
const defaultMaximumMessageBytes = 256 * 1024 * 1024;

function websocketAccept(key) {
  return crypto
    .createHash("sha1")
    .update(`${key}${websocketGuid}`)
    .digest("base64");
}

function parseHeaders(rawHeaders) {
  const lines = rawHeaders.split("\r\n");
  const statusLine = lines.shift() || "";
  const headers = new Map();
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers.set(name, headers.has(name) ? `${headers.get(name)}, ${value}` : value);
  }
  return { statusLine, headers };
}

function encodeClientFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const mask = crypto.randomBytes(4);
  let extendedLengthBytes = 0;
  if (body.length >= 126 && body.length <= 0xffff) extendedLengthBytes = 2;
  if (body.length > 0xffff) extendedLengthBytes = 8;
  const frame = Buffer.alloc(2 + extendedLengthBytes + 4 + body.length);
  frame[0] = 0x80 | opcode;
  if (extendedLengthBytes === 0) {
    frame[1] = 0x80 | body.length;
  } else if (extendedLengthBytes === 2) {
    frame[1] = 0x80 | 126;
    frame.writeUInt16BE(body.length, 2);
  } else {
    frame[1] = 0x80 | 127;
    frame.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const maskOffset = 2 + extendedLengthBytes;
  mask.copy(frame, maskOffset);
  for (let index = 0; index < body.length; index += 1) {
    frame[maskOffset + 4 + index] = body[index] ^ mask[index % 4];
  }
  return frame;
}

function closePayload(code, reason) {
  const reasonBytes = Buffer.from(reason || "", "utf8");
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return payload;
}

async function writeWithBackpressure(socket, buffer) {
  if (socket.destroyed) throw new Error("websocket socket is closed");
  if (socket.write(buffer)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off("drain", onDrain);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("websocket socket closed before drain"));
    };
    socket.once("drain", onDrain);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export class UnixWebSocket extends EventEmitter {
  constructor(socket, initialData, options = {}) {
    super();
    this.socket = socket;
    this.maximumMessageBytes =
      options.maximumMessageBytes || defaultMaximumMessageBytes;
    this.pending = initialData || Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragmentBuffers = [];
    this.fragmentBytes = 0;
    this.closeSent = false;
    this.closed = false;
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("error", (error) => this.#fail(error));
    socket.on("close", () => {
      if (!this.closed) {
        this.closed = true;
        this.emit("close");
      }
    });
    queueMicrotask(() => this.#parseFrames());
  }

  async sendText(text) {
    const payload = Buffer.from(text, "utf8");
    if (payload.length > this.maximumMessageBytes) {
      throw new Error(`outgoing websocket message exceeds ${this.maximumMessageBytes} bytes`);
    }
    await writeWithBackpressure(this.socket, encodeClientFrame(0x1, payload));
  }

  async close(code = 1000, reason = "") {
    if (this.closeSent || this.socket.destroyed) return;
    this.closeSent = true;
    await writeWithBackpressure(
      this.socket,
      encodeClientFrame(0x8, closePayload(code, reason)),
    ).catch(() => {});
    this.socket.end();
  }

  destroy(error) {
    this.socket.destroy(error);
  }

  #onData(chunk) {
    this.pending = Buffer.concat([this.pending, chunk]);
    this.#parseFrames();
  }

  #parseFrames() {
    try {
      while (this.pending.length >= 2) {
        const first = this.pending[0];
        const second = this.pending[1];
        const final = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        if (masked) throw new Error("server websocket frames must not be masked");
        let payloadLength = second & 0x7f;
        let offset = 2;
        if (payloadLength === 126) {
          if (this.pending.length < 4) return;
          payloadLength = this.pending.readUInt16BE(2);
          offset = 4;
        } else if (payloadLength === 127) {
          if (this.pending.length < 10) return;
          const length = this.pending.readBigUInt64BE(2);
          if (length > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error("websocket frame length exceeds safe integer range");
          }
          payloadLength = Number(length);
          offset = 10;
        }
        if (payloadLength > this.maximumMessageBytes) {
          throw new Error(`websocket frame exceeds ${this.maximumMessageBytes} bytes`);
        }
        if (this.pending.length < offset + payloadLength) return;
        const payload = this.pending.subarray(offset, offset + payloadLength);
        this.pending = this.pending.subarray(offset + payloadLength);
        this.#handleFrame({ final, opcode, payload });
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  #handleFrame({ final, opcode, payload }) {
    if (opcode >= 0x8) {
      if (!final || payload.length > 125) {
        throw new Error("invalid websocket control frame");
      }
      if (opcode === 0x8) {
        if (!this.closeSent) {
          this.closeSent = true;
          this.socket.write(encodeClientFrame(0x8, payload));
        }
        this.socket.end();
        return;
      }
      if (opcode === 0x9) {
        this.socket.write(encodeClientFrame(0xA, payload));
        return;
      }
      if (opcode === 0xA) return;
      throw new Error(`unsupported websocket control opcode ${opcode}`);
    }

    if (opcode === 0x0) {
      if (this.fragmentOpcode == null) {
        throw new Error("unexpected websocket continuation frame");
      }
      this.#appendFragment(payload);
      if (final) this.#finishFragments();
      return;
    }

    if (opcode !== 0x1 && opcode !== 0x2) {
      throw new Error(`unsupported websocket opcode ${opcode}`);
    }
    if (this.fragmentOpcode != null) {
      throw new Error("received a new data frame during a fragmented message");
    }
    if (final) {
      this.#emitMessage(opcode, payload);
      return;
    }
    this.fragmentOpcode = opcode;
    this.fragmentBuffers = [];
    this.fragmentBytes = 0;
    this.#appendFragment(payload);
  }

  #appendFragment(payload) {
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maximumMessageBytes) {
      throw new Error(`websocket message exceeds ${this.maximumMessageBytes} bytes`);
    }
    this.fragmentBuffers.push(payload);
  }

  #finishFragments() {
    const opcode = this.fragmentOpcode;
    const payload = Buffer.concat(this.fragmentBuffers, this.fragmentBytes);
    this.fragmentOpcode = null;
    this.fragmentBuffers = [];
    this.fragmentBytes = 0;
    this.#emitMessage(opcode, payload);
  }

  #emitMessage(opcode, payload) {
    if (opcode !== 0x1) {
      throw new Error("Codex App Server returned a binary websocket message");
    }
    this.emit("message", payload.toString("utf8"));
  }

  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    this.emit("error", error);
    this.socket.destroy();
  }
}

async function upgradeWebSocket(socket, options, startImmediately) {
  const requestPath = options.requestPath || "/rpc";
  const timeoutMs = options.timeoutMs || 5_000;
  const key = crypto.randomBytes(16).toString("base64");
  const expectedAccept = websocketAccept(key);
  return await new Promise((resolve, reject) => {
    let settled = false;
    let pending = Buffer.alloc(0);
    const timer = setTimeout(() => finish(new Error("timed out opening websocket")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const finish = (error, websocket) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        resolve(websocket);
      }
    };
    const onConnect = () => {
      const request = [
        `GET ${requestPath} HTTP/1.1`,
        "Host: localhost",
        "Connection: Upgrade",
        "Upgrade: websocket",
        "Sec-WebSocket-Version: 13",
        `Sec-WebSocket-Key: ${key}`,
        "",
        "",
      ].join("\r\n");
      socket.write(request);
    };
    const onData = (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > maximumHeaderBytes) {
        finish(new Error("websocket upgrade headers exceed size limit"));
        return;
      }
      const separator = pending.indexOf("\r\n\r\n");
      if (separator < 0) return;
      const rawHeaders = pending.subarray(0, separator).toString("latin1");
      const remaining = pending.subarray(separator + 4);
      const { statusLine, headers } = parseHeaders(rawHeaders);
      if (!/^HTTP\/1\.[01] 101\b/.test(statusLine)) {
        finish(new Error(`websocket upgrade failed: ${statusLine}`));
        return;
      }
      if (headers.get("sec-websocket-accept") !== expectedAccept) {
        finish(new Error("websocket upgrade returned an invalid accept key"));
        return;
      }
      if (headers.has("sec-websocket-extensions")) {
        finish(new Error("websocket server unexpectedly enabled extensions"));
        return;
      }
      finish(null, new UnixWebSocket(socket, remaining, options));
    };
    const onError = (error) => finish(error);
    const onClose = () => finish(new Error("socket closed during websocket upgrade"));
    if (startImmediately) queueMicrotask(onConnect);
    else socket.once("connect", onConnect);
    socket.on("data", onData);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

export async function connectWebSocketStream(stream, options = {}) {
  return await upgradeWebSocket(stream, options, true);
}

export async function connectUnixWebSocket(socketPath, options = {}) {
  const socket = net.createConnection(socketPath);
  return await upgradeWebSocket(socket, options, false);
}

export async function probeAppServer(socketPath, options = {}) {
  const websocket = await connectUnixWebSocket(socketPath, options);
  const requestId = `probe-${crypto.randomUUID()}`;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      websocket.destroy();
      reject(new Error("timed out initializing Codex App Server"));
    }, options.timeoutMs || 5_000);
    const cleanup = () => {
      clearTimeout(timer);
      websocket.off("message", onMessage);
      websocket.off("error", onError);
      websocket.off("close", onClose);
    };
    const onMessage = async (message) => {
      let parsed;
      try {
        parsed = JSON.parse(message);
      } catch {
        return;
      }
      if (parsed?.id !== requestId) return;
      if (parsed.error != null || typeof parsed.result?.userAgent !== "string") {
        onError(new Error(
          parsed.error != null
            ? `Codex App Server initialize failed (code ${parsed.error.code ?? "unknown"})`
            : "Codex App Server initialize returned no userAgent",
        ));
        websocket.destroy();
        return;
      }
      cleanup();
      await websocket
        .sendText(JSON.stringify({ method: "initialized", params: {} }))
        .catch(() => {});
      await websocket.close().catch(() => {});
      resolve(parsed.result);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("Codex App Server closed during initialize"));
    };
    websocket.on("message", onMessage);
    websocket.once("error", onError);
    websocket.once("close", onClose);
    websocket
      .sendText(
        JSON.stringify({
          method: "initialize",
          id: requestId,
          params: {
            clientInfo: {
              // App Server 将此探测身份视为 non-originating client，避免健康
              // 检查抢先设置进程级 originator 或覆盖真实客户端的 User-Agent。
              name: "codex_app_server_daemon",
              title: "Codex App Server Bridge Probe",
              version: "1.0.0",
            },
          },
        }),
      )
      .catch(onError);
  });
}
