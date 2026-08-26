import path from "node:path";

const appServerToolSubcommands = new Set([
  "daemon",
  "proxy",
  "generate-ts",
  "generate-json-schema",
  "generate-internal-json-schema",
]);

export function isAppServerRunInvocation(args) {
  const appServerIndex = args.indexOf("app-server");
  if (appServerIndex < 0) return false;
  return !args
    .slice(appServerIndex + 1)
    .some((argument) => appServerToolSubcommands.has(argument));
}

export function withUnixSocketTransport(args, socketPath) {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--stdio") continue;
    if (argument === "--listen") {
      index += 1;
      continue;
    }
    if (argument.startsWith("--listen=")) continue;
    result.push(argument);
  }
  result.push("--listen", `unix://${path.resolve(socketPath)}`);
  return result;
}
