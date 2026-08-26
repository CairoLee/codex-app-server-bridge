import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRuntime } from "../scripts/lib/runtime-install.mjs";
import {
  markerEnd,
  markerStart,
  readRegistrationReceipt,
  registerLocalCodexEntrypoint,
  registrationPaths,
  removeRegistrationFiles,
  restoreLocalCodexEntrypoint,
  writeRegistrationFiles,
} from "../scripts/lib/registration.mjs";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDirectory, "..");

test("运行时安装按内容复用发布目录", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "runtime-install-test-"),
  );
  context.after(() => fs.rm(temporaryDirectory, { recursive: true, force: true }));
  const installRoot = path.join(temporaryDirectory, "install");

  const first = await installRuntime({ projectRoot, installRoot });
  const second = await installRuntime({ projectRoot, installRoot });

  assert.equal(first.created, true);
  assert.equal(first.activated, true);
  assert.equal(second.created, false);
  assert.equal(second.activated, false);
  assert.equal(first.releaseDirectory, second.releaseDirectory);
  assert.equal(await fs.readlink(path.join(installRoot, "current")), `releases/${first.runtimeHash}`);
  for (const executable of ["chatgpt-codex-inst", "chatgpt-codex-uninst"]) {
    const metadata = await fs.stat(path.join(first.releaseDirectory, "bin", executable));
    assert.notEqual(metadata.mode & 0o111, 0, `${executable} 应可执行`);
  }
});

test("安装可重复执行且所有持久配置只引用安装目录", async (context) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "registration-test-"));
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const installRoot = path.join(homeDirectory, "custom install");
  const paths = registrationPaths({ homeDirectory, installRoot });
  await fs.writeFile(paths.profilePaths.zshenv, "export KEEP_ME=yes\n", "utf8");
  await fs.mkdir(paths.launchAgentsDirectory, { recursive: true });

  const first = await writeRegistrationFiles(paths);
  const second = await writeRegistrationFiles(paths);
  const zshenv = await fs.readFile(paths.profilePaths.zshenv, "utf8");
  const zprofile = await fs.readFile(paths.profilePaths.zprofile, "utf8");
  const plist = await fs.readFile(paths.launchAgentPlistPath, "utf8");

  assert.ok(first.changedFiles.length > 0);
  assert.deepEqual(second.changedFiles, []);
  assert.equal(zshenv.match(new RegExp(markerStart, "gu"))?.length, 1);
  assert.equal(zshenv.match(new RegExp(markerEnd, "gu"))?.length, 1);
  assert.match(zshenv, /export KEEP_ME=yes/u);
  assert.match(zprofile, /CODEX_INSTALL_DIR/u);
  assert.match(zprofile, new RegExp(installRoot.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.doesNotMatch(zprofile, new RegExp(projectRoot, "u"));
  assert.match(plist, /local\.chatgpt-codex-primary\.env/u);
});

test("安装接管 standalone 固定入口且卸载恢复原 symlink", async (context) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "entrypoint-test-"));
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const installRoot = path.join(homeDirectory, ".local", "share", "chatgpt-codex-primary");
  const paths = registrationPaths({ homeDirectory, installRoot });
  const standaloneTarget = path.join(
    homeDirectory,
    ".codex",
    "packages",
    "standalone",
    "current",
    "bin",
    "codex",
  );
  await fs.mkdir(paths.localBinDirectory, { recursive: true });
  await fs.symlink(standaloneTarget, paths.localCodexPath);

  const first = await registerLocalCodexEntrypoint(paths);
  await writeRegistrationFiles(paths);
  const second = await registerLocalCodexEntrypoint(paths);
  const receipt = await readRegistrationReceipt(paths);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(await fs.readlink(paths.localCodexPath), paths.managedCodexPath);
  assert.deepEqual(receipt.localCodexEntrypoint.original, {
    kind: "symlink",
    target: standaloneTarget,
  });

  const restoration = await restoreLocalCodexEntrypoint(paths, receipt);
  assert.equal(restoration.changed, true);
  assert.equal(await fs.readlink(paths.localCodexPath), standaloneTarget);
});

test("安装拒绝覆盖未知的本地 Codex 入口", async (context) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "entrypoint-guard-test-"));
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const paths = registrationPaths({ homeDirectory });
  await fs.mkdir(paths.localBinDirectory, { recursive: true });
  await fs.writeFile(paths.localCodexPath, "user-owned", "utf8");

  await assert.rejects(
    registerLocalCodexEntrypoint(paths),
    /不是 Codex standalone 的受支持 symlink/u,
  );
  assert.equal(await fs.readFile(paths.localCodexPath, "utf8"), "user-owned");
});

test("卸载只移除托管配置并保留运行时和用户内容", async (context) => {
  const homeDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "unregister-test-"));
  context.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const installRoot = path.join(homeDirectory, ".local", "share", "chatgpt-codex-primary");
  const paths = registrationPaths({ homeDirectory, installRoot });
  const sentinel = path.join(installRoot, "runtime-sentinel");
  await fs.mkdir(installRoot, { recursive: true });
  await fs.writeFile(sentinel, "preserve", "utf8");
  await fs.writeFile(paths.profilePaths.zshrc, "export KEEP_ME=yes\n", "utf8");
  await writeRegistrationFiles(paths);

  await removeRegistrationFiles(paths);

  const zshrc = await fs.readFile(paths.profilePaths.zshrc, "utf8");
  assert.match(zshrc, /export KEEP_ME=yes/u);
  assert.doesNotMatch(zshrc, /chatgpt-codex-primary/u);
  assert.equal(await fs.readFile(sentinel, "utf8"), "preserve");
  await assert.rejects(fs.access(paths.launchAgentPlistPath));
  await assert.rejects(fs.access(paths.receiptPath));
});
