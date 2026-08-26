#!/usr/bin/env node
import { bootoutManagedAgents, guiEnvironment, unsetGuiEnvironment } from "./lib/launchctl.mjs";
import {
  readRegistrationReceipt,
  registrationPaths,
  removeRegistrationFiles,
  restoreLocalCodexEntrypoint,
} from "./lib/registration.mjs";

if (process.platform !== "darwin") {
  throw new Error("当前卸载器仅支持 macOS。");
}

const paths = registrationPaths();
const receipt = await readRegistrationReceipt(paths);
const managedCliPaths = new Set([paths.cliPath, receipt?.cliPath].filter(Boolean));
const currentCliPath = await guiEnvironment("CODEX_CLI_PATH");
if (managedCliPaths.has(currentCliPath)) {
  await unsetGuiEnvironment("CODEX_CLI_PATH");
}
await unsetGuiEnvironment("CODEX_APP_SERVER_USE_LOCAL_DAEMON");
await bootoutManagedAgents();
const localCodexEntrypoint = await restoreLocalCodexEntrypoint(paths, receipt);
const removal = await removeRegistrationFiles(paths);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      removal,
      localCodexEntrypoint,
      preservedInstallRoot: receipt?.installRoot ?? paths.installRoot,
      restartChatGPTRequired: true,
    },
    null,
    2,
  )}\n`,
);
