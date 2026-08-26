import test from "node:test";
import assert from "node:assert/strict";
import {
  chatGPTDesktopPids,
  requireChatGPTDesktopStopped,
} from "../scripts/lib/chatgpt-preflight.mjs";

test("识别所有 ChatGPT Desktop 主进程并规范化 PID", async () => {
  const pids = await chatGPTDesktopPids({
    run: async (executable, args) => {
      assert.equal(executable, "/bin/ps");
      assert.deepEqual(args, ["-axo", "pid=,args="]);
      return {
        stdout: [
          "  420 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
          "  108 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT --diagnostic",
          "  777 /Applications/ChatGPT.app/Contents/Frameworks/browser_crashpad_handler",
          "  999 /bin/zsh -c ChatGPT",
          "  420 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT",
          "",
        ].join("\n"),
      };
    },
  });

  assert.deepEqual(pids, [108, 420]);
});

test("进程列表无主程序路径时视为 ChatGPT Desktop 已退出", async () => {
  const pids = await chatGPTDesktopPids({
    run: async () => ({
      stdout:
        "123 /Applications/ChatGPT.app/Contents/Frameworks/browser_crashpad_handler\n",
    }),
  });

  assert.deepEqual(pids, []);
  await assert.doesNotReject(
    requireChatGPTDesktopStopped({ run: async () => ({ stdout: "" }) }),
  );
});

test("安装或卸载前发现桌面端运行时失败关闭", async () => {
  await assert.rejects(
    requireChatGPTDesktopStopped({
      run: async () => ({
        stdout: "3804 /Applications/ChatGPT.app/Contents/MacOS/ChatGPT\n",
      }),
    }),
    (error) => {
      assert.equal(error.code, "CHATGPT_DESKTOP_RUNNING");
      assert.equal(error.exitCode, 69);
      assert.deepEqual(error.pids, [3804]);
      assert.match(error.message, /⌘Q/u);
      assert.match(error.message, /没有修改任何设置/u);
      return true;
    },
  );
});

test("ps 自身失败时保留检测失败上下文", async () => {
  await assert.rejects(
    chatGPTDesktopPids({
      run: async () => {
        const error = new Error("permission denied");
        error.code = 2;
        throw error;
      },
    }),
    /无法检测 ChatGPT Desktop 是否仍在运行.*permission denied/u,
  );
});
