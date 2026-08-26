import fs from "node:fs/promises";
import path from "node:path";

export async function recentOperationLogs(
  logsDirectory,
  { limit = 10, fileSystem = fs } = {},
) {
  let entries;
  try {
    entries = await fileSystem.readdir(logsDirectory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(logsDirectory, entry.name))
    .sort((left, right) => right.localeCompare(left))
    .slice(0, limit);
}

export function operationLogsMessage({ logsDirectory, files, displayPath }) {
  const lines = [`操作日志：${displayPath(logsDirectory)}`];
  if (files.length === 0) {
    lines.push("暂时没有操作日志。", "");
    return lines.join("\n");
  }
  lines.push("", "最近记录：");
  for (const file of files) lines.push(`- ${path.basename(file)}`);
  lines.push("", "查看最新明细：codex-bridge logs --latest", "");
  return lines.join("\n");
}
