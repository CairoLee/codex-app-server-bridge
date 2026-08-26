import os from "node:os";
import path from "node:path";

function displayPath(filePath, homeDirectory = os.homedir()) {
  const relative = path.relative(homeDirectory, filePath);
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `~/${relative}`;
  }
  return filePath;
}

function appServerVersion(userAgent) {
  return userAgent?.match(/Codex Desktop\/([^\s]+)/u)?.[1] ?? null;
}

export function friendlyFailureReason(reason) {
  if (reason === "state file is missing") {
    return "尚未发现共享服务。请确认已经完成安装，并启动 ChatGPT Desktop。";
  }
  if (reason === "ChatGPT owner process is not running") {
    return "ChatGPT Desktop 当前没有运行。";
  }
  if (reason === "shared server supervisor is not running") {
    return "共享服务的管理进程没有运行。";
  }
  if (reason === "shared App Server process is not running") {
    return "共享 Codex App Server 没有运行。";
  }
  if (reason === "shared server uses a different resource Codex path") {
    return "共享服务使用了不同的 Codex 程序，当前配置不一致。";
  }
  if (reason === "shared server uses a different socket") {
    return "共享服务使用了不同的连接地址，当前配置不一致。";
  }
  if (reason === "ChatGPT App Tools pipe is unavailable") {
    return "ChatGPT Desktop 的 App Tools 连接尚未就绪。";
  }
  if (reason === "ChatGPT App Tools pipe is not a socket") {
    return "ChatGPT Desktop 的 App Tools 连接状态异常。";
  }
  if (reason?.startsWith("shared server state is ")) {
    return "共享服务仍在启动或关闭过程中，请稍后再试。";
  }
  if (reason?.startsWith("state file is unreadable:")) {
    return "共享服务的状态记录无法读取。";
  }
  if (reason?.startsWith("state file belongs to an unknown manager")) {
    return "发现了无法识别的共享服务状态。";
  }
  if (reason?.startsWith("App Server probe failed:")) {
    return "共享 Codex App Server 暂时无法连接。";
  }
  return "共享服务当前不可用。";
}

export function healthyStatusMessage(status, { verbose = false } = {}) {
  const version = appServerVersion(status.serverInfo?.userAgent);
  const lines = [
    "✓ 共享 Codex App Server 运行正常。",
    "ChatGPT Desktop、Codex CLI 与 Remote SSH 可以访问同一组会话。",
  ];
  if (version) lines.push(`Codex 版本：${version}`);

  if (verbose) {
    lines.push(
      "",
      "详细信息：",
      `- ChatGPT Desktop PID：${status.state.ownerPid}`,
      `- 管理进程 PID：${status.state.supervisorPid}`,
      `- App Server PID：${status.state.serverPid}`,
      `- Socket：${displayPath(status.state.socketPath)}`,
      `- Codex：${status.state.resourceCodexPath}`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function unhealthyStatusMessage(status, { verbose = false } = {}) {
  const lines = [
    "✗ 共享 Codex App Server 当前不可用。",
    `原因：${friendlyFailureReason(status.reason)}`,
    "",
    "建议：完全退出并重新启动 ChatGPT Desktop，然后再次检查。",
  ];
  if (verbose) {
    lines.push("", `内部原因：${status.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}
