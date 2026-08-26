#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRuntime } from "./lib/runtime-install.mjs";
import { requireChatGPTDesktopStopped } from "./lib/chatgpt-preflight.mjs";
import {
  installationMessage,
  writeOperationLog,
} from "./lib/operation-report.mjs";
import {
  registerLocalCodexEntrypoint,
  registrationPaths,
  writeRegistrationFiles,
} from "./lib/registration.mjs";
import { bootoutManagedAgents, bootstrapManagedAgent } from "./lib/launchctl.mjs";

if (process.platform !== "darwin") {
  throw new Error("当前安装器仅支持 macOS。");
}

try {
  await requireChatGPTDesktopStopped();
} catch (error) {
  if (error?.code !== "CHATGPT_DESKTOP_RUNNING") throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(error.exitCode);
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const homeDirectory = process.env.HOME?.trim() || os.homedir();
const installRoot =
  process.env.CODEX_BRIDGE_INSTALL_ROOT?.trim() ||
  path.join(homeDirectory, ".local", "share", "codex-app-server-bridge");
const runtime = await installRuntime({ projectRoot, installRoot });
const paths = registrationPaths({ homeDirectory, installRoot });

await bootoutManagedAgents();
const localCodexEntrypoint = await registerLocalCodexEntrypoint(paths);
const registration = await writeRegistrationFiles(paths);
await bootstrapManagedAgent(paths.launchAgentPlistPath);

const report = {
  ok: true,
  runtime,
  registration,
  localCodexEntrypoint,
  launchAgent: paths.launchAgentPlistPath,
  restartChatGPTRequired: true,
};
const logPath = await writeOperationLog({
  operation: "inst",
  details: report,
  receiptPath: paths.receiptPath,
});
process.stdout.write(installationMessage({ logPath }));
