import fs from "node:fs/promises";
import path from "node:path";
import { processCommand } from "./process-utils.mjs";

const releaseNamePattern = /^[0-9a-f]{12}$/u;

function normalizedAbsolutePath(filePath) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null;
  return path.normalize(filePath);
}

function versionedReleaseLayout(supervisorPath) {
  const normalized = normalizedAbsolutePath(supervisorPath);
  if (normalized == null || path.basename(normalized) !== "supervisor.mjs") {
    return null;
  }
  const sourceDirectory = path.dirname(normalized);
  if (path.basename(sourceDirectory) !== "src") return null;
  const releaseDirectory = path.dirname(sourceDirectory);
  if (!releaseNamePattern.test(path.basename(releaseDirectory))) return null;
  const releasesDirectory = path.dirname(releaseDirectory);
  if (path.basename(releasesDirectory) !== "releases") return null;
  return { normalized, releasesDirectory };
}

export function isTrustedManagedSupervisorPath(
  candidatePath,
  currentSupervisorPath,
) {
  const candidate = normalizedAbsolutePath(candidatePath);
  const current = normalizedAbsolutePath(currentSupervisorPath);
  if (candidate == null || current == null) return false;
  if (candidate === current) return true;

  const candidateLayout = versionedReleaseLayout(candidate);
  const currentLayout = versionedReleaseLayout(current);
  return (
    candidateLayout != null &&
    currentLayout != null &&
    candidateLayout.releasesDirectory === currentLayout.releasesDirectory
  );
}

export async function managedSupervisorPathForState(
  state,
  currentSupervisorPath,
  { readProcessCommand = processCommand } = {},
) {
  const recordedPath = state?.supervisorPath;
  if (recordedPath != null) {
    if (!isTrustedManagedSupervisorPath(recordedPath, currentSupervisorPath)) {
      throw new Error(
        `refusing to signal PID ${state?.supervisorPid}: recorded supervisor path is not managed by this installation`,
      );
    }
    return path.normalize(recordedPath);
  }

  const command = await readProcessCommand(state?.supervisorPid);
  if (command == null) {
    throw new Error(
      `refusing to signal PID ${state?.supervisorPid}: process command is unavailable`,
    );
  }

  const current = path.normalize(currentSupervisorPath);
  if (command.includes(current)) return current;

  const currentLayout = versionedReleaseLayout(current);
  if (currentLayout != null) {
    const entries = await fs.readdir(currentLayout.releasesDirectory, {
      withFileTypes: true,
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || !releaseNamePattern.test(entry.name)) continue;
      const candidate = path.join(
        currentLayout.releasesDirectory,
        entry.name,
        "src",
        "supervisor.mjs",
      );
      if (command.includes(candidate)) return candidate;
    }
  }

  throw new Error(
    `refusing to signal PID ${state?.supervisorPid}: command is not a managed supervisor from this installation`,
  );
}
