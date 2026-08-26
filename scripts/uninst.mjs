#!/usr/bin/env node
import { bootoutManagedAgents, guiEnvironment, unsetGuiEnvironment } from "./lib/launchctl.mjs";
import { requireChatGPTDesktopStopped } from "./lib/chatgpt-preflight.mjs";
import {
  uninstallationMessage,
  writeOperationLog,
} from "./lib/operation-report.mjs";
import {
  readRegistrationReceipt,
  registrationPaths,
  removeRegistrationFiles,
  restoreLocalCodexEntrypoint,
} from "./lib/registration.mjs";

if (process.platform !== "darwin") {
  throw new Error("当前卸载器仅支持 macOS。");
}

try {
  await requireChatGPTDesktopStopped();
} catch (error) {
  if (error?.code !== "CHATGPT_DESKTOP_RUNNING") throw error;
  process.stderr.write(`${error.message}\n`);
  process.exit(error.exitCode);
}

const paths = registrationPaths();
const receipt = await readRegistrationReceipt(paths);
const managedCliPaths = new Set(
  [paths.cliPath, ...paths.legacyCliPaths, receipt?.cliPath].filter(Boolean),
);
const currentCliPath = await guiEnvironment("CODEX_CLI_PATH");
const guiEnvironmentChanged = managedCliPaths.has(currentCliPath);
if (guiEnvironmentChanged) {
  await unsetGuiEnvironment("CODEX_CLI_PATH");
}
await unsetGuiEnvironment("CODEX_APP_SERVER_USE_LOCAL_DAEMON");
await bootoutManagedAgents();
const localCodexEntrypoint = await restoreLocalCodexEntrypoint(paths, receipt);
const removal = await removeRegistrationFiles(paths);

const changed =
  guiEnvironmentChanged ||
  localCodexEntrypoint.changed ||
  removal.changedFiles.length > 0;
const report = {
  ok: true,
  changed,
  guiEnvironmentChanged,
  removal,
  localCodexEntrypoint,
  preservedInstallRoot: receipt?.installRoot ?? paths.installRoot,
  restartChatGPTRequired: changed,
};
const logPath = await writeOperationLog({
  operation: "uninst",
  details: report,
  receiptPath: paths.receiptPath,
});
process.stdout.write(
  uninstallationMessage({
    alreadyUninstalled: !changed,
    entrypointRestored: localCodexEntrypoint.changed,
    logPath,
  }),
);
