import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  isTrustedManagedSupervisorPath,
  managedSupervisorPathForState,
} from "../src/managed-supervisor.mjs";

test("只信任当前 supervisor 或同一安装目录中的内容哈希 release", () => {
  const current = "/private/install/releases/2f95af8bb918/src/supervisor.mjs";

  assert.equal(isTrustedManagedSupervisorPath(current, current), true);
  assert.equal(
    isTrustedManagedSupervisorPath(
      "/private/install/releases/481b94841d6d/src/supervisor.mjs",
      current,
    ),
    true,
  );
  assert.equal(
    isTrustedManagedSupervisorPath(
      "/private/other/releases/481b94841d6d/src/supervisor.mjs",
      current,
    ),
    false,
  );
  assert.equal(
    isTrustedManagedSupervisorPath(
      "/private/install/releases/not-a-release/src/supervisor.mjs",
      current,
    ),
    false,
  );
});

test("升级后的管理器可识别上一 release 的旧格式 supervisor", async (context) => {
  const temporaryDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "managed-supervisor-upgrade-"),
  );
  const releasesDirectory = path.join(temporaryDirectory, "releases");
  const previous = path.join(
    releasesDirectory,
    "481b94841d6d",
    "src",
    "supervisor.mjs",
  );
  const current = path.join(
    releasesDirectory,
    "2f95af8bb918",
    "src",
    "supervisor.mjs",
  );
  await fs.mkdir(path.dirname(previous), { recursive: true });
  await fs.mkdir(path.dirname(current), { recursive: true });
  await fs.writeFile(previous, "", "utf8");
  await fs.writeFile(current, "", "utf8");
  context.after(async () => {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  });

  const resolved = await managedSupervisorPathForState(
    { supervisorPid: 123 },
    current,
    {
      readProcessCommand: async (pid) => {
        assert.equal(pid, 123);
        return `${process.execPath} ${previous} /private/state/launch.json`;
      },
    },
  );
  assert.equal(resolved, previous);
});

test("新版状态中的 supervisor 路径仍须属于当前安装目录", async () => {
  const current = "/private/install/releases/2f95af8bb918/src/supervisor.mjs";
  await assert.rejects(
    managedSupervisorPathForState(
      {
        supervisorPid: 123,
        supervisorPath:
          "/private/other/releases/481b94841d6d/src/supervisor.mjs",
      },
      current,
    ),
    /recorded supervisor path is not managed by this installation/u,
  );
});
