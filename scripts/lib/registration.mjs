import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJson, removeIfExists, writeJsonAtomic } from "../../src/atomic-file.mjs";

export const markerStart = "# >>> chatgpt-codex-primary >>>";
export const markerEnd = "# <<< chatgpt-codex-primary <<<";
export const registrationLabel = "local.chatgpt-codex-primary.env";
export const legacyRegistrationLabels = [];

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function xmlEscape(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function registrationPaths({
  env = process.env,
  homeDirectory = env.HOME?.trim() || os.homedir(),
  installRoot =
    env.CHATGPT_CODEX_INSTALL_ROOT?.trim() ||
    path.join(homeDirectory, ".local", "share", "chatgpt-codex-primary"),
  launchAgentsDirectory =
    env.CHATGPT_CODEX_LAUNCH_AGENTS_DIR?.trim() ||
    path.join(homeDirectory, "Library", "LaunchAgents"),
  localBinDirectory =
    env.CHATGPT_CODEX_LOCAL_BIN_DIR?.trim() ||
    path.join(homeDirectory, ".local", "bin"),
} = {}) {
  const currentDirectory = path.join(installRoot, "current");
  return {
    homeDirectory,
    installRoot,
    currentDirectory,
    binDirectory: path.join(currentDirectory, "bin"),
    managedCodexPath: path.join(currentDirectory, "bin", "codex"),
    localBinDirectory,
    localCodexPath: path.join(localBinDirectory, "codex"),
    cliPath: path.join(currentDirectory, "bin", "chatgpt-codex"),
    launchAgentScriptPath: path.join(
      currentDirectory,
      "launchd",
      "set-launchd-env.zsh",
    ),
    launchAgentsDirectory,
    launchAgentPlistPath: path.join(
      launchAgentsDirectory,
      `${registrationLabel}.plist`,
    ),
    legacyLaunchAgentPlistPaths: legacyRegistrationLabels.map((label) =>
      path.join(launchAgentsDirectory, `${label}.plist`),
    ),
    receiptPath:
      env.CHATGPT_CODEX_REGISTRATION_RECEIPT?.trim() ||
      path.join(
        homeDirectory,
        ".local",
        "state",
        "chatgpt-codex-primary",
        "registration.json",
      ),
    profilePaths: {
      zshenv: path.join(homeDirectory, ".zshenv"),
      zshrc: path.join(homeDirectory, ".zshrc"),
      zprofile: path.join(homeDirectory, ".zprofile"),
    },
  };
}

async function pathState(filePath) {
  try {
    const metadata = await fs.lstat(filePath);
    if (metadata.isSymbolicLink()) {
      return { kind: "symlink", target: await fs.readlink(filePath) };
    }
    return { kind: "other" };
  } catch (error) {
    if (error?.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

function resolvedLinkTarget(linkPath, target) {
  return path.resolve(path.dirname(linkPath), target);
}

function isManagedCodexLink(paths, state) {
  return (
    state.kind === "symlink" &&
    resolvedLinkTarget(paths.localCodexPath, state.target) ===
      path.resolve(paths.managedCodexPath)
  );
}

function isStandaloneCodexLink(paths, state) {
  if (state.kind !== "symlink") return false;
  const target = resolvedLinkTarget(paths.localCodexPath, state.target);
  const standaloneRoot = path.join(
    paths.homeDirectory,
    ".codex",
    "packages",
    "standalone",
  );
  return target === path.join(standaloneRoot, "current", "bin", "codex");
}

async function replaceSymlink(linkPath, target) {
  await fs.mkdir(path.dirname(linkPath), { recursive: true, mode: 0o700 });
  const temporaryLink = `${linkPath}.new.${process.pid}`;
  await fs.rm(temporaryLink, { force: true });
  await fs.symlink(target, temporaryLink);
  await fs.rename(temporaryLink, linkPath);
}

export async function registerLocalCodexEntrypoint(paths) {
  const existingReceipt = await readJson(paths.receiptPath);
  const current = await pathState(paths.localCodexPath);
  if (isManagedCodexLink(paths, current)) {
    return {
      changed: false,
      receipt:
        existingReceipt?.localCodexEntrypoint ?? {
          path: paths.localCodexPath,
          managedTarget: paths.managedCodexPath,
          original: { kind: "missing" },
        },
    };
  }
  if (current.kind !== "missing" && !isStandaloneCodexLink(paths, current)) {
    throw new Error(
      `拒绝替换 ${paths.localCodexPath}：它不是 Codex standalone 的受支持 symlink。`,
    );
  }

  const entrypointReceipt = {
    path: paths.localCodexPath,
    managedTarget: paths.managedCodexPath,
    original: current,
  };
  await writeJsonAtomic(paths.receiptPath, {
    ...(existingReceipt ?? {}),
    schemaVersion: 2,
    installRoot: paths.installRoot,
    localCodexEntrypoint: entrypointReceipt,
  });
  await replaceSymlink(paths.localCodexPath, paths.managedCodexPath);
  return { changed: true, receipt: entrypointReceipt };
}

export async function restoreLocalCodexEntrypoint(paths, receipt) {
  const entrypoint = receipt?.localCodexEntrypoint;
  if (!entrypoint) return { changed: false, reason: "registration receipt has no entrypoint" };
  const current = await pathState(paths.localCodexPath);
  if (!isManagedCodexLink(paths, current)) {
    return { changed: false, reason: "entrypoint was changed after registration" };
  }
  if (entrypoint.original?.kind === "symlink") {
    await replaceSymlink(paths.localCodexPath, entrypoint.original.target);
    return { changed: true, restored: entrypoint.original };
  }
  if (entrypoint.original?.kind === "missing") {
    await fs.unlink(paths.localCodexPath);
    return { changed: true, restored: entrypoint.original };
  }
  throw new Error(`无法恢复 ${paths.localCodexPath}：注册收据中的原始类型不受支持。`);
}

export function removeManagedBlocks(content) {
  const hadTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hadTrailingNewline) lines.pop();
  const output = [];
  let insideBlock = false;
  for (const line of lines) {
    if (line === markerStart) {
      if (insideBlock) throw new Error("检测到嵌套的 chatgpt-codex-primary marker。");
      insideBlock = true;
      continue;
    }
    if (line === markerEnd) {
      if (!insideBlock) throw new Error("检测到缺少起始 marker 的注册块。");
      insideBlock = false;
      continue;
    }
    if (!insideBlock) output.push(line);
  }
  if (insideBlock) throw new Error("检测到未闭合的 chatgpt-codex-primary marker。");
  return `${output.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
}

function appendManagedBlock(content, block) {
  const base = removeManagedBlocks(content).replace(/[\t \n]+$/gu, "");
  return `${base}${base === "" ? "" : "\n\n"}${block}\n`;
}

export function profileBlocks(installRoot) {
  const binDirectory = shellQuote(path.join(installRoot, "current", "bin"));
  const cliPath = shellQuote(
    path.join(installRoot, "current", "bin", "chatgpt-codex"),
  );
  return {
    path: [
      markerStart,
      `chatgpt_codex_primary_bin=${binDirectory}`,
      'path=("$chatgpt_codex_primary_bin" ${path:#"$chatgpt_codex_primary_bin"})',
      "export PATH",
      "unset chatgpt_codex_primary_bin",
      markerEnd,
    ].join("\n"),
    environment: [
      markerStart,
      `export CODEX_CLI_PATH=${cliPath}`,
      `export CODEX_INSTALL_DIR=${binDirectory}`,
      "unset CODEX_APP_SERVER_USE_LOCAL_DAEMON",
      markerEnd,
    ].join("\n"),
  };
}

export function launchAgentPlist(paths) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    `  <string>${xmlEscape(registrationLabel)}</string>`,
    "  <key>ProgramArguments</key>",
    "  <array>",
    `    <string>${xmlEscape(paths.launchAgentScriptPath)}</string>`,
    "  </array>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>ProcessType</key>",
    "  <string>Background</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function writeTextAtomic(filePath, content, defaultMode = 0o600) {
  const existing = await readText(filePath);
  if (existing === content) return false;
  let mode = defaultMode;
  try {
    mode = (await fs.stat(filePath)).mode & 0o777;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporaryPath, content, { encoding: "utf8", mode });
  await fs.rename(temporaryPath, filePath);
  return true;
}

export async function writeRegistrationFiles(paths) {
  const existingReceipt = await readJson(paths.receiptPath);
  const blocks = profileBlocks(paths.installRoot);
  const changedFiles = [];
  for (const profilePath of [paths.profilePaths.zshenv, paths.profilePaths.zshrc]) {
    const content = appendManagedBlock(await readText(profilePath), blocks.path);
    if (await writeTextAtomic(profilePath, content)) changedFiles.push(profilePath);
  }
  const zprofileContent = appendManagedBlock(
    await readText(paths.profilePaths.zprofile),
    blocks.environment,
  );
  if (await writeTextAtomic(paths.profilePaths.zprofile, zprofileContent)) {
    changedFiles.push(paths.profilePaths.zprofile);
  }

  await fs.mkdir(paths.launchAgentsDirectory, { recursive: true, mode: 0o700 });
  if (
    await writeTextAtomic(
      paths.launchAgentPlistPath,
      launchAgentPlist(paths),
      0o644,
    )
  ) {
    changedFiles.push(paths.launchAgentPlistPath);
  }
  for (const legacyPath of paths.legacyLaunchAgentPlistPaths) {
    await removeIfExists(legacyPath);
  }

  await writeJsonAtomic(paths.receiptPath, {
    ...(existingReceipt ?? {}),
    schemaVersion: 2,
    label: registrationLabel,
    installRoot: paths.installRoot,
    cliPath: paths.cliPath,
    launchAgentPlistPath: paths.launchAgentPlistPath,
    localCodexEntrypoint: existingReceipt?.localCodexEntrypoint,
    registeredAt: new Date().toISOString(),
  });
  return { changedFiles };
}

export async function readRegistrationReceipt(paths) {
  return await readJson(paths.receiptPath);
}

export async function removeRegistrationFiles(paths) {
  const changedFiles = [];
  for (const profilePath of Object.values(paths.profilePaths)) {
    const original = await readText(profilePath);
    if (original === "") continue;
    const updated = removeManagedBlocks(original);
    if (updated !== original && (await writeTextAtomic(profilePath, updated))) {
      changedFiles.push(profilePath);
    }
  }
  for (const plistPath of [
    paths.launchAgentPlistPath,
    ...paths.legacyLaunchAgentPlistPaths,
  ]) {
    try {
      await fs.unlink(plistPath);
      changedFiles.push(plistPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  await removeIfExists(paths.receiptPath);
  return { changedFiles };
}
