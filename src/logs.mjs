#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { displayPath } from "../scripts/lib/operation-report.mjs";
import { registrationPaths } from "../scripts/lib/registration.mjs";
import {
  operationLogsMessage,
  recentOperationLogs,
} from "./logs-support.mjs";
import { sysexits } from "./settings.mjs";

const args = process.argv.slice(2);
const latest = args.includes("--latest");
const json = args.includes("--json");
const help = args.includes("--help") || args.includes("-h");
const knownArguments = new Set(["--latest", "--json", "--help", "-h"]);
const unknownArguments = args.filter((argument) => !knownArguments.has(argument));

if (help) {
  process.stdout.write(
    [
      "查看 Codex App Server Bridge 的操作日志。",
      "",
      "用法：codex-bridge logs [--latest | --json]",
      "",
      "  --latest  输出最近一条日志的完整内容",
      "  --json    输出日志目录与最近记录的 JSON",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (unknownArguments.length > 0 || (latest && json)) {
  process.stderr.write(
    `无法识别的参数组合：${args.join(" ")}\n运行 codex-bridge logs --help 查看用法。\n`,
  );
  process.exit(sysexits.config);
}

const paths = registrationPaths();
const logsDirectory = path.join(path.dirname(paths.receiptPath), "logs");
const files = await recentOperationLogs(logsDirectory);

if (latest) {
  if (files.length === 0) {
    process.stdout.write("暂时没有操作日志。\n");
    process.exit(0);
  }
  process.stdout.write(await fs.readFile(files[0], "utf8"));
} else if (json) {
  process.stdout.write(
    `${JSON.stringify({ logsDirectory, files }, null, 2)}\n`,
  );
} else {
  process.stdout.write(
    operationLogsMessage({ logsDirectory, files, displayPath }),
  );
}
