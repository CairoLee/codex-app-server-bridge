import { once } from "node:events";
import { connectUnixWebSocket } from "./websocket-uds.mjs";

async function writeStdout(text) {
  if (process.stdout.write(`${text}\n`)) return;
  await once(process.stdout, "drain");
}

export async function bridgeStdioToAppServer(socketPath) {
  const websocket = await connectUnixWebSocket(socketPath, { timeoutMs: 5_000 });
  let incoming = Promise.resolve();
  let failed = null;
  websocket.on("message", (message) => {
    incoming = incoming.then(() => writeStdout(message));
    incoming.catch((error) => {
      failed = error;
      websocket.destroy(error);
    });
  });
  const closed = new Promise((resolve, reject) => {
    websocket.once("close", resolve);
    websocket.once("error", reject);
  });

  process.stdin.setEncoding("utf8");
  let pending = "";
  try {
    for await (const chunk of process.stdin) {
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline).replace(/\r$/u, "");
        pending = pending.slice(newline + 1);
        if (line.length > 0) await websocket.sendText(line);
      }
      if (failed) throw failed;
    }
    if (pending.length > 0) await websocket.sendText(pending.replace(/\r$/u, ""));
    await websocket.close();
    await Promise.race([
      closed.catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    await incoming;
  } catch (error) {
    websocket.destroy(error);
    throw error;
  }
}
