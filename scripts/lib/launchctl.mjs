import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  legacyRegistrationLabels,
  registrationLabel,
} from "./registration.mjs";

const execFileAsync = promisify(execFile);
const launchctlPath = "/bin/launchctl";

async function launchctl(args, { tolerateFailure = false } = {}) {
  try {
    return await execFileAsync(launchctlPath, args, { encoding: "utf8" });
  } catch (error) {
    if (tolerateFailure) return { stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    throw new Error(
      `launchctl ${args.join(" ")} 失败：${(error.stderr || error.message).trim()}`,
      { cause: error },
    );
  }
}

export async function bootoutManagedAgents(uid = process.getuid()) {
  for (const label of [registrationLabel, ...legacyRegistrationLabels]) {
    await launchctl(["bootout", `gui/${uid}/${label}`], { tolerateFailure: true });
  }
}

export async function bootstrapManagedAgent(plistPath, uid = process.getuid()) {
  await launchctl(["bootstrap", `gui/${uid}`, plistPath]);
}

export async function guiEnvironment(name, uid = process.getuid()) {
  const result = await launchctl(
    ["asuser", String(uid), launchctlPath, "getenv", name],
    { tolerateFailure: true },
  );
  return result.stdout.trim();
}

export async function unsetGuiEnvironment(name, uid = process.getuid()) {
  await launchctl([
    "asuser",
    String(uid),
    launchctlPath,
    "unsetenv",
    name,
  ]);
}
