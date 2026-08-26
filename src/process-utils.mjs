import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function processCommand(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const { stdout } = await execFileAsync("/bin/ps", [
      "-o",
      "command=",
      "-p",
      String(pid),
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !isProcessAlive(pid);
}

export async function signalVerifiedProcess(pid, expectedCommandFragment, signal) {
  if (!isProcessAlive(pid)) return false;
  const command = await processCommand(pid);
  if (command == null || !command.includes(expectedCommandFragment)) {
    throw new Error(
      `refusing to signal PID ${pid}: command does not contain ${expectedCommandFragment}`,
    );
  }
  process.kill(pid, signal);
  return true;
}
