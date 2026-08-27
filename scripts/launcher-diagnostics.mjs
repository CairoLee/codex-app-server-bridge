#!/usr/bin/env node
import {
  armLauncherDiagnostics,
  clearLauncherDiagnostics,
  disableLauncherDiagnostics,
  readLauncherDiagnostics,
} from "../src/launcher-diagnostics.mjs";

const command = process.argv[2];

if (command === "arm") {
  const result = await armLauncherDiagnostics();
  process.stdout.write(
    [
      "✓ Launcher 诊断记录已启用。",
      `配置开关：${result.configPath}`,
      `自动过期：${result.config.expiresAt}`,
      `最多记录：${result.config.maxRecords} 条`,
      `记录文件：${result.tracePath}`,
      "记录仅包含脱敏参数形态、进程关系和非敏感环境变量名称。",
      "",
    ].join("\n"),
  );
} else if (command === "disable") {
  const result = await disableLauncherDiagnostics();
  process.stdout.write(
    `✓ Launcher 诊断记录已关闭；已有记录保留在：${result.tracePath}\n`,
  );
} else if (command === "show") {
  const result = await readLauncherDiagnostics();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else if (command === "clear") {
  const result = await clearLauncherDiagnostics();
  process.stdout.write(`✓ 已清理 Launcher 诊断记录：${result.directory}\n`);
} else {
  process.stderr.write(
    "用法：node scripts/launcher-diagnostics.mjs <arm|disable|show|clear>\n",
  );
  process.exitCode = 64;
}
