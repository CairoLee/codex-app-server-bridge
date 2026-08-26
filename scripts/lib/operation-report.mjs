import os from "node:os";
import path from "node:path";
import { writeJsonAtomic } from "../../src/atomic-file.mjs";

function logTimestamp(date) {
  return date.toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function displayPath(filePath, homeDirectory = os.homedir()) {
  const relative = path.relative(homeDirectory, filePath);
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~/${relative}`;
  }
  return filePath;
}

export async function writeOperationLog({
  operation,
  details,
  receiptPath,
  now = new Date(),
}) {
  const logsDirectory = path.join(path.dirname(receiptPath), "logs");
  const logPath = path.join(
    logsDirectory,
    `${logTimestamp(now)}-${operation}-${process.pid}.json`,
  );
  await writeJsonAtomic(logPath, {
    schemaVersion: 1,
    operation,
    completedAt: now.toISOString(),
    ...details,
  });
  return logPath;
}

export function installationMessage({ logPath }) {
  return [
    "✓ 安装完成。",
    "ChatGPT Desktop、Codex CLI 与 Remote SSH 已配置为复用桌面端 App Server。",
    "",
    "下一步：",
    "1. 重新启动 ChatGPT Desktop。",
    "2. 打开一个新终端，运行 codex-bridge status 检查状态。",
    "",
    `详细记录：${displayPath(logPath)}`,
    "",
  ].join("\n");
}

export function uninstallationMessage({
  alreadyUninstalled,
  entrypointRestored,
  logPath,
}) {
  if (alreadyUninstalled) {
    return [
      "✓ 当前已经是未安装状态，无需重复处理。",
      `详细记录：${displayPath(logPath)}`,
      "",
    ].join("\n");
  }

  return [
    "✓ 卸载完成。",
    entrypointRestored
      ? "Codex 命令入口已恢复为安装前的 standalone 版本。"
      : "已清理本项目管理的 shell 与登录项设置。",
    "",
    "下一步：可以重新打开 ChatGPT Desktop；请使用新终端运行 Codex。",
    `详细记录：${displayPath(logPath)}`,
    "",
  ].join("\n");
}
