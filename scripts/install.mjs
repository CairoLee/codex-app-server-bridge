#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRuntime } from "./lib/runtime-install.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDirectory, "..");
const homeDirectory = process.env.HOME?.trim() || os.homedir();
const installRoot =
  process.env.CHATGPT_CODEX_INSTALL_ROOT?.trim() ||
  path.join(homeDirectory, ".local", "share", "chatgpt-codex-primary");

const result = await installRuntime({ projectRoot, installRoot });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
