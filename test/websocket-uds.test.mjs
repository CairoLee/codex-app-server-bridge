import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { once } from "node:events";
import { connectUnixWebSocket } from "../src/websocket-uds.mjs";

const guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function serverFrame({ opcode = 1, final = true, payload }) {
  const body = Buffer.from(payload);
  const extended = body.length < 126 ? 0 : body.length <= 0xffff ? 2 : 8;
  const frame = Buffer.alloc(2 + extended + body.length);
  frame[0] = (final ? 0x80 : 0) | opcode;
  if (extended === 0) frame[1] = body.length;
  if (extended === 2) {
    frame[1] = 126;
    frame.writeUInt16BE(body.length, 2);
  }
  if (extended === 8) {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(body.length), 2);
  }
  body.copy(frame, 2 + extended);
  return frame;
}

function decodeClientFrame(buffer) {
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  assert.equal((buffer[1] & 0x80) !== 0, true);
  const mask = buffer.subarray(offset, offset + 4);
  const payload = buffer.subarray(offset + 4, offset + 4 + length);
  const decoded = Buffer.alloc(payload.length);
  for (let index = 0; index < payload.length; index += 1) {
    decoded[index] = payload[index] ^ mask[index % 4];
  }
  return { opcode: buffer[0] & 0x0f, text: decoded.toString("utf8") };
}

test("通过 Unix socket 完成无扩展 WebSocket 握手和分片消息传输", async (context) => {
  const temporaryDirectory = await fs.mkdtemp("/tmp/ws-uds-test-");
  const socketPath = path.join(temporaryDirectory, "server.sock");
  const server = net.createServer();
  context.after(async () => {
    server.close();
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });
  server.listen(socketPath);
  await once(server, "listening");

  server.once("connection", (socket) => {
    let handshake = Buffer.alloc(0);
    const onHandshake = (chunk) => {
      handshake = Buffer.concat([handshake, chunk]);
      const separator = handshake.indexOf("\r\n\r\n");
      if (separator < 0) return;
      socket.off("data", onHandshake);
      const headers = handshake.subarray(0, separator).toString("latin1");
      assert.match(headers, /GET \/rpc HTTP\/1\.1/u);
      assert.doesNotMatch(headers, /Sec-WebSocket-Extensions/iu);
      const key = headers.match(/^Sec-WebSocket-Key:\s*(.+)$/imu)?.[1].trim();
      const accept = crypto.createHash("sha1").update(`${key}${guid}`).digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Connection: Upgrade",
          "Upgrade: websocket",
          `Sec-WebSocket-Accept: ${accept}`,
          "",
          "",
        ].join("\r\n"),
      );
      socket.once("data", (frame) => {
        assert.deepEqual(decodeClientFrame(frame), { opcode: 1, text: "request" });
        socket.write(serverFrame({ final: false, opcode: 1, payload: "res" }));
        socket.write(serverFrame({ final: true, opcode: 0, payload: "ponse" }));
      });
    };
    socket.on("data", onHandshake);
  });

  const websocket = await connectUnixWebSocket(socketPath);
  const message = once(websocket, "message");
  await websocket.sendText("request");
  assert.deepEqual(await message, ["response"]);
  await websocket.close();
});
