import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const requirement = 'identifier "com.openai.sky.CUAService" and anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"';

async function parentExecutable(pid) {
  const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "comm="], { timeout: 2000 });
  return stdout.trim();
}

async function verifySignature(executable) {
  await execFileAsync("/usr/bin/codesign", ["--verify", "--strict", "-R", `=${requirement}`, executable], { timeout: 5000 });
}

// 仅兼容官方 Computer Use 的 stdio 辅助查询，不放开普通 CLI listener。
// 这是一条进程路由规则，不替代操作系统的权限和认证边界。
export async function isComputerUseHelper(args, {
  platform = process.platform,
  parentPid = process.ppid,
  homeDirectory = os.homedir(),
  getParentExecutable = parentExecutable,
  verifyExecutable = verifySignature,
} = {}) {
  if (platform !== "darwin" || !Number.isSafeInteger(parentPid) || parentPid <= 0) return false;
  if (args.length !== 3 || args[0] !== "app-server" || args[1] !== "--listen" || args[2] !== "stdio://") return false;
  const expected = path.join(homeDirectory, ".codex/computer-use/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService");
  try {
    if (await getParentExecutable(parentPid) !== expected) return false;
    await verifyExecutable(expected);
    return await getParentExecutable(parentPid) === expected;
  } catch {
    // 无法确认调用来源时保持原来的拒绝行为。
    return false;
  }
}
