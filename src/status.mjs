#!/usr/bin/env node
import { bridgeStatus } from "./bridge-state.mjs";
import { runtimePaths, sysexits } from "./settings.mjs";
import {
  healthyStatusMessage,
  unhealthyStatusMessage,
} from "./status-presentation.mjs";

const args = process.argv.slice(2);
const json = args.includes("--json");
const verbose = args.includes("--verbose") || args.includes("-v");
const help = args.includes("--help") || args.includes("-h");
const knownArguments = new Set(["--json", "--verbose", "-v", "--help", "-h"]);
const unknownArguments = args.filter((argument) => !knownArguments.has(argument));

if (help) {
  process.stdout.write(
    [
      "查看共享 Codex App Server 的运行状态。",
      "",
      "用法：codex-bridge status [--verbose | --json]",
      "",
      "  --verbose, -v  显示 PID、Socket 和 Codex 路径",
      "  --json         输出适合脚本处理的完整 JSON",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

if (unknownArguments.length > 0 || (json && verbose)) {
  process.stderr.write(
    `无法识别的参数组合：${args.join(" ")}\n运行 codex-bridge status --help 查看用法。\n`,
  );
  process.exit(sysexits.config);
}

const status = await bridgeStatus();
if (!status.ok) {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: false, reason: status.reason, paths: runtimePaths() }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(unhealthyStatusMessage(status, { verbose }));
  }
  process.exitCode = sysexits.unavailable;
} else {
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          ownerPid: status.state.ownerPid,
          supervisorPid: status.state.supervisorPid,
          serverPid: status.state.serverPid,
          socketPath: status.state.socketPath,
          resourceCodexPath: status.state.resourceCodexPath,
          appServerVersion: status.serverInfo?.userAgent || null,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    process.stdout.write(healthyStatusMessage(status, { verbose }));
  }
}
