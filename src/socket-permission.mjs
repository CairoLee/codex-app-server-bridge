import net from "node:net";

const permissionDeniedCodes = new Set(["EACCES", "EPERM"]);

export function isPermissionDeniedError(error) {
  const visited = new Set();
  let current = error;
  while (current != null && typeof current === "object" && !visited.has(current)) {
    visited.add(current);
    if (permissionDeniedCodes.has(current.code)) return true;
    current = current.cause;
  }
  return false;
}

export async function isUnixSocketPermissionDenied(
  socketPath,
  { createConnection = net.createConnection, timeoutMs = 500 } = {},
) {
  return await new Promise((resolve) => {
    let socket;
    let timer;
    let settled = false;

    const finish = (denied) => {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
      socket?.removeListener("connect", onConnect);
      socket?.removeListener("error", onError);
      socket?.destroy();
      resolve(denied);
    };
    const onConnect = () => finish(false);
    const onError = (error) => finish(isPermissionDeniedError(error));

    try {
      socket = createConnection(socketPath);
    } catch (error) {
      finish(isPermissionDeniedError(error));
      return;
    }
    socket.once("connect", onConnect);
    socket.once("error", onError);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}
