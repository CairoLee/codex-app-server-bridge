#!/usr/bin/env node
import { primaryStatus } from "./primary-state.mjs";
import { runtimePaths, sysexits } from "./settings.mjs";

const status = await primaryStatus();
if (!status.ok) {
  process.stdout.write(
    `${JSON.stringify({ ok: false, reason: status.reason, paths: runtimePaths() }, null, 2)}\n`,
  );
  process.exitCode = sysexits.unavailable;
} else {
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
}
