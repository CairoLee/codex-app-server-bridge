import fs from "node:fs/promises";
import path from "node:path";
import { isProcessAlive } from "./process-utils.mjs";
import { readJson, writeJsonAtomic } from "./atomic-file.mjs";

const wait = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function acquireDirectoryLock(lockDirectory, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  const ownerPath = path.join(lockDirectory, "owner.json");
  await fs.mkdir(path.dirname(lockDirectory), { recursive: true, mode: 0o700 });
  for (;;) {
    try {
      await fs.mkdir(lockDirectory, { mode: 0o700 });
      await writeJsonAtomic(ownerPath, {
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      });
      return async () => {
        const owner = await readJson(ownerPath).catch(() => null);
        if (owner?.pid === process.pid) {
          await fs.rm(lockDirectory, { recursive: true, force: true });
        }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const owner = await readJson(ownerPath).catch(() => null);
    if (owner?.pid && !isProcessAlive(owner.pid)) {
      const stalePath = `${lockDirectory}.stale.${process.pid}.${Date.now()}`;
      try {
        await fs.rename(lockDirectory, stalePath);
        await fs.rm(stalePath, { recursive: true, force: true });
        continue;
      } catch (error) {
        if (error?.code !== "ENOENT") await wait(50);
      }
    }

    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for startup lock ${lockDirectory}`);
    }
    await wait(100);
  }
}
