import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const chatGPTExecutablePath = "/Applications/ChatGPT.app/Contents/MacOS/ChatGPT";
const psPath = "/bin/ps";

export async function chatGPTDesktopPids({ run = execFileAsync } = {}) {
  try {
    const { stdout } = await run(psPath, ["-axo", "pid=,args="], {
      encoding: "utf8",
    });
    return [
      ...new Set(
        stdout
          .split("\n")
          .map((line) => line.match(/^\s*(\d+)\s+(.+)$/u))
          .filter((match) => {
            if (!match) return false;
            const command = match[2];
            return (
              command === chatGPTExecutablePath ||
              command.startsWith(`${chatGPTExecutablePath} `)
            );
          })
          .map((match) => Number.parseInt(match[1], 10)),
      ),
    ].sort((left, right) => left - right);
  } catch (error) {
    throw new Error(
      `无法检测 ChatGPT Desktop 是否仍在运行：${error?.message ?? String(error)}`,
      { cause: error },
    );
  }
}

export async function requireChatGPTDesktopStopped(options) {
  const pids = await chatGPTDesktopPids(options);
  if (pids.length === 0) return;

  const error = new Error(
    [
      `检测到 ChatGPT Desktop 仍在运行（PID: ${pids.join(", ")}）。`,
      "请先使用 ⌘Q 完全退出 ChatGPT Desktop，然后重新运行当前命令。",
      "本次没有修改任何设置。",
    ].join("\n"),
  );
  error.code = "CHATGPT_DESKTOP_RUNNING";
  error.exitCode = 69;
  error.pids = pids;
  throw error;
}
