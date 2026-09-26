import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resourceCodexPath } from "../src/settings.mjs";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-resources-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const modern = path.join(root, "codex-cli/CodexCLI.app/Contents/MacOS/codex");
  const legacy = path.join(root, "codex");
  async function executable(file) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  return { root, modern, legacy, executable };
}

test("新版布局选择应用包内 Codex，两个路径并存时优先新版", async (t) => {
  const f = await fixture(t);
  await f.executable(f.modern);
  assert.equal(resourceCodexPath({}, f.root), f.modern);
  await f.executable(f.legacy);
  assert.equal(resourceCodexPath({}, f.root), f.modern);
});

test("旧版布局仍可用，更新布局后重新解析路径", async (t) => {
  const f = await fixture(t);
  await f.executable(f.legacy);
  assert.equal(resourceCodexPath({}, f.root), f.legacy);
  await f.executable(f.modern);
  await fs.unlink(f.legacy);
  assert.equal(resourceCodexPath({}, f.root), f.modern);
});

test("新版路径不可执行或为目录时使用旧版", async (t) => {
  const f = await fixture(t);
  await f.executable(f.legacy);
  await f.executable(f.modern);
  await fs.chmod(f.modern, 0o644);
  assert.equal(resourceCodexPath({}, f.root), f.legacy);
  await fs.unlink(f.modern);
  await fs.mkdir(f.modern);
  assert.equal(resourceCodexPath({}, f.root), f.legacy);
});

test("显式覆盖始终优先，错误覆盖不静默降级", async (t) => {
  const f = await fixture(t);
  await f.executable(f.modern);
  const override = path.join(f.root, "missing-override");
  assert.equal(resourceCodexPath({ CODEX_BRIDGE_RESOURCE_PATH: ` ${override} ` }, f.root), override);
  assert.equal(resourceCodexPath({ CODEX_BRIDGE_RESOURCE_PATH: "  " }, f.root), f.modern);
});

test("无可用布局时保留旧路径供启动报错，不选择 standalone", async (t) => {
  const f = await fixture(t);
  assert.equal(resourceCodexPath({}, f.root), f.legacy);
});
