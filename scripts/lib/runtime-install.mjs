import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const runtimeDirectories = ["src", "bin", "launchd", "scripts"];
const runtimeFiles = ["README.md", "package.json"];

async function visitFiles(directory, relativeDirectory, files) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const relativePath = path.join(relativeDirectory, entry.name);
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visitFiles(absolutePath, relativePath, files);
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
}

export async function hashRuntime(projectRoot) {
  const hash = crypto.createHash("sha256");
  const files = [...runtimeFiles];
  for (const directory of runtimeDirectories) {
    await visitFiles(path.join(projectRoot, directory), directory, files);
  }
  for (const relativePath of files.sort()) {
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await fs.readFile(path.join(projectRoot, relativePath)));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

async function readLinkTarget(linkPath) {
  try {
    return await fs.readlink(linkPath);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "EINVAL") return null;
    throw error;
  }
}

async function replaceSymlink(linkPath, target) {
  const temporaryLink = `${linkPath}.new.${process.pid}`;
  await fs.rm(temporaryLink, { force: true });
  await fs.symlink(target, temporaryLink);
  await fs.rename(temporaryLink, linkPath);
}

async function releaseExists(releaseDirectory, runtimeHash) {
  try {
    const installedHash = (
      await fs.readFile(path.join(releaseDirectory, ".runtime-hash"), "utf8")
    ).trim();
    if (installedHash !== runtimeHash) {
      throw new Error(
        `运行时目录 ${releaseDirectory} 已存在，但内容标识不匹配。`,
      );
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function stageRelease({ projectRoot, releasesDirectory, releaseDirectory, runtimeHash }) {
  if (await releaseExists(releaseDirectory, runtimeHash)) return false;

  const stagingDirectory = path.join(
    releasesDirectory,
    `.staging-${runtimeHash}-${process.pid}`,
  );
  await fs.rm(stagingDirectory, { recursive: true, force: true });
  await fs.mkdir(stagingDirectory, { recursive: false, mode: 0o700 });
  try {
    for (const directory of runtimeDirectories) {
      await fs.cp(
        path.join(projectRoot, directory),
        path.join(stagingDirectory, directory),
        { recursive: true, preserveTimestamps: true },
      );
    }
    for (const file of runtimeFiles) {
      await fs.copyFile(
        path.join(projectRoot, file),
        path.join(stagingDirectory, file),
      );
    }
    for (const executable of [
      "bin/chatgpt-codex",
      "bin/chatgpt-codex-inst",
      "bin/chatgpt-codex-uninst",
      "bin/codex",
      "bin/codex-chatgpt-status",
      "bin/codex-standalone",
      "launchd/set-launchd-env.zsh",
      "scripts/install.mjs",
      "scripts/inst.mjs",
      "scripts/uninst.mjs",
    ]) {
      await fs.chmod(path.join(stagingDirectory, executable), 0o755);
    }
    await fs.writeFile(
      path.join(stagingDirectory, ".runtime-hash"),
      `${runtimeHash}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    try {
      await fs.rename(stagingDirectory, releaseDirectory);
    } catch (error) {
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
      if (!(await releaseExists(releaseDirectory, runtimeHash))) throw error;
    }
    return true;
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true });
  }
}

export async function installRuntime({ projectRoot, installRoot }) {
  const runtimeHash = await hashRuntime(projectRoot);
  const releasesDirectory = path.join(installRoot, "releases");
  const releaseDirectory = path.join(releasesDirectory, runtimeHash);
  await fs.mkdir(releasesDirectory, { recursive: true, mode: 0o700 });
  const created = await stageRelease({
    projectRoot,
    releasesDirectory,
    releaseDirectory,
    runtimeHash,
  });

  const currentLink = path.join(installRoot, "current");
  const previousLink = path.join(installRoot, "previous");
  const oldCurrentTarget = await readLinkTarget(currentLink);
  const newCurrentTarget = path.relative(installRoot, releaseDirectory);
  const activated = oldCurrentTarget !== newCurrentTarget;
  if (activated) {
    if (oldCurrentTarget != null) {
      await replaceSymlink(previousLink, oldCurrentTarget);
    }
    await replaceSymlink(currentLink, newCurrentTarget);
  }

  return {
    installRoot,
    releaseDirectory,
    current: await fs.realpath(currentLink),
    previous: activated ? oldCurrentTarget : await readLinkTarget(previousLink),
    runtimeHash,
    created,
    activated,
  };
}
