#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRuntime } from "./lib/runtime-install.mjs";
import {
  registerLocalCodexEntrypoint,
  registrationPaths,
  writeRegistrationFiles,
} from "./lib/registration.mjs";
import { bootoutManagedAgents, bootstrapManagedAgent } from "./lib/launchctl.mjs";

if (process.platform !== "darwin") {
  throw new Error("当前安装器仅支持 macOS。");
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const homeDirectory = process.env.HOME?.trim() || os.homedir();
const installRoot =
  process.env.CHATGPT_CODEX_INSTALL_ROOT?.trim() ||
  path.join(homeDirectory, ".local", "share", "chatgpt-codex-primary");
const runtime = await installRuntime({ projectRoot, installRoot });
const paths = registrationPaths({ homeDirectory, installRoot });

await bootoutManagedAgents();
const localCodexEntrypoint = await registerLocalCodexEntrypoint(paths);
const registration = await writeRegistrationFiles(paths);
await bootstrapManagedAgent(paths.launchAgentPlistPath);

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      runtime,
      registration,
      localCodexEntrypoint,
      launchAgent: paths.launchAgentPlistPath,
      restartChatGPTRequired: true,
    },
    null,
    2,
  )}\n`,
);
