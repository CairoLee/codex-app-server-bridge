import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readJson, removeIfExists, writeJsonAtomic } from "../../src/atomic-file.mjs";

export const markerStart = "# >>> codex-app-server-bridge >>>";
export const markerEnd = "# <<< codex-app-server-bridge <<<";
export const legacyMarkerPairs = [
  {
    start: "# >>> chatgpt-codex-primary >>>",
    end: "# <<< chatgpt-codex-primary <<<",
  },
];
export const registrationLabel = "local.codex-app-server-bridge.env";
export const legacyRegistrationLabels = ["local.chatgpt-codex-primary.env"];

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
    env.CODEX_BRIDGE_INSTALL_ROOT?.trim() ||
    path.join(homeDirectory, ".local", "share", "codex-app-server-bridge"),
  launchAgentsDirectory =
    env.CODEX_BRIDGE_LAUNCH_AGENTS_DIR?.trim() ||
    path.join(homeDirectory, "Library", "LaunchAgents"),
  localBinDirectory =
    env.CODEX_BRIDGE_LOCAL_BIN_DIR?.trim() ||
    path.join(homeDirectory, ".local", "bin"),
} = {}) {
  const currentDirectory = path.join(installRoot, "current");
  const legacyInstallRoot = path.join(
    homeDirectory,
    ".local",
    "share",
    "chatgpt-codex-primary",
  );
  return {
    homeDirectory,
    installRoot,
    currentDirectory,
    binDirectory: path.join(currentDirectory, "bin"),
    managedCodexPath: path.join(currentDirectory, "bin", "codex"),
    localBinDirectory,
    localCodexPath: path.join(localBinDirectory, "codex"),
    cliPath: path.join(currentDirectory, "bin", "codex-bridge-launcher"),
    legacyCliPaths: [
      path.join(legacyInstallRoot, "current", "bin", "chatgpt-codex"),
    ],
    legacyManagedCodexPaths: [
      path.join(legacyInstallRoot, "current", "bin", "codex"),
    ],
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
      env.CODEX_BRIDGE_RECEIPT?.trim() ||
      path.join(
        homeDirectory,
        ".local",
        "state",
        "codex-app-server-bridge",
        "installation.json",
      ),
    legacyReceiptPaths: [
      path.join(
        homeDirectory,
        ".local",
        "state",
        "chatgpt-codex-primary",
        "registration.json",
      ),
    ],
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

function managedCodexTarget(paths, state) {
  if (state.kind !== "symlink") return null;
  const target = resolvedLinkTarget(paths.localCodexPath, state.target);
  return [paths.managedCodexPath, ...paths.legacyManagedCodexPaths]
    .map((candidate) => path.resolve(candidate))
    .find((candidate) => candidate === target) ?? null;
}

function isManagedCodexLink(paths, state) {
  return managedCodexTarget(paths, state) != null;
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
  const existingReceipt = await readRegistrationReceipt(paths);
  const current = await pathState(paths.localCodexPath);
  const currentManagedTarget = managedCodexTarget(paths, current);
  if (currentManagedTarget === path.resolve(paths.managedCodexPath)) {
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
  if (currentManagedTarget != null && !existingReceipt?.localCodexEntrypoint) {
    throw new Error(
      `拒绝迁移 ${paths.localCodexPath}：检测到旧版托管入口，但找不到可恢复的注册收据。`,
    );
  }
  if (current.kind !== "missing" && !isStandaloneCodexLink(paths, current)) {
    if (currentManagedTarget == null) {
      throw new Error(
        `拒绝替换 ${paths.localCodexPath}：它不是 Codex standalone 的受支持 symlink。`,
      );
    }
  }

  const entrypointReceipt = {
    path: paths.localCodexPath,
    managedTarget: paths.managedCodexPath,
    original:
      currentManagedTarget == null
        ? current
        : existingReceipt.localCodexEntrypoint.original,
  };
  await writeJsonAtomic(paths.receiptPath, {
    ...(existingReceipt ?? {}),
    schemaVersion: 3,
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
  const markerPairs = [
    { start: markerStart, end: markerEnd },
    ...legacyMarkerPairs,
  ];
  let activeMarker = null;
  for (const line of lines) {
    const openingMarker = markerPairs.find((pair) => pair.start === line);
    if (openingMarker) {
      if (activeMarker) throw new Error("检测到嵌套的 Codex App Server Bridge marker。");
      activeMarker = openingMarker;
      continue;
    }
    const closingMarker = markerPairs.find((pair) => pair.end === line);
    if (closingMarker) {
      if (!activeMarker || closingMarker !== activeMarker) {
        throw new Error("检测到缺少匹配起始 marker 的安装块。");
      }
      activeMarker = null;
      continue;
    }
    if (!activeMarker) output.push(line);
  }
  if (activeMarker) throw new Error("检测到未闭合的 Codex App Server Bridge marker。");
  return `${output.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
}

function appendManagedBlock(content, block) {
  const base = removeManagedBlocks(content).replace(/[\t \n]+$/gu, "");
  return `${base}${base === "" ? "" : "\n\n"}${block}\n`;
}

export function profileBlocks(installRoot) {
  const binDirectory = shellQuote(path.join(installRoot, "current", "bin"));
  const cliPath = shellQuote(
    path.join(installRoot, "current", "bin", "codex-bridge-launcher"),
  );
  return {
    path: [
      markerStart,
      `codex_bridge_bin=${binDirectory}`,
      'path=("$codex_bridge_bin" ${path:#"$codex_bridge_bin"})',
      "export PATH",
      "unset codex_bridge_bin",
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
  const existingReceipt = await readRegistrationReceipt(paths);
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
    schemaVersion: 3,
    label: registrationLabel,
    installRoot: paths.installRoot,
    cliPath: paths.cliPath,
    launchAgentPlistPath: paths.launchAgentPlistPath,
    localCodexEntrypoint: existingReceipt?.localCodexEntrypoint,
    registeredAt: new Date().toISOString(),
  });
  for (const legacyReceiptPath of paths.legacyReceiptPaths) {
    if (path.resolve(legacyReceiptPath) !== path.resolve(paths.receiptPath)) {
      await removeIfExists(legacyReceiptPath);
    }
  }
  return { changedFiles };
}

export async function readRegistrationReceipt(paths) {
  const current = await readJson(paths.receiptPath);
  if (current != null) return current;
  for (const legacyReceiptPath of paths.legacyReceiptPaths) {
    const legacy = await readJson(legacyReceiptPath);
    if (legacy != null) return legacy;
  }
  return null;
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
  for (const receiptPath of [paths.receiptPath, ...paths.legacyReceiptPaths]) {
    await removeIfExists(receiptPath);
  }
  return { changedFiles };
}
