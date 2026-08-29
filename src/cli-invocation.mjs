function hasExplicitWorkingDirectory(args) {
  for (const argument of args) {
    if (argument === "--") return false;
    if (
      argument === "-C" ||
      argument === "--cd" ||
      argument.startsWith("-C=") ||
      argument.startsWith("--cd=")
    ) {
      return true;
    }
  }
  return false;
}

function withInvocationWorkingDirectory(args, cwd) {
  if (hasExplicitWorkingDirectory(args)) return args;
  return ["--cd", cwd, ...args];
}

export function sharedRemoteInvocationArgs({ args, command, cwd, socketPath }) {
  const forwardedArgs =
    command == null ? withInvocationWorkingDirectory(args, cwd) : args;
  return ["--remote", `unix://${socketPath}`, ...forwardedArgs];
}
