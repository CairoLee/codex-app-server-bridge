以下 marker block 由安装步骤写入对应 shell 文件。卸载时只删除 marker 之间的内容。

## `.zshenv` 与 `.zshrc`

```zsh
# >>> codex-app-server-bridge >>>
codex_bridge_bin="$HOME/.local/share/codex-app-server-bridge/current/bin"
path=("$codex_bridge_bin" ${path:#"$codex_bridge_bin"})
export PATH
unset codex_bridge_bin
# <<< codex-app-server-bridge <<<
```

## `.zprofile`

```zsh
# >>> codex-app-server-bridge >>>
export CODEX_CLI_PATH="$HOME/.local/share/codex-app-server-bridge/current/bin/codex-bridge-launcher"
export CODEX_INSTALL_DIR="$HOME/.local/share/codex-app-server-bridge/current/bin"
unset CODEX_APP_SERVER_USE_LOCAL_DAEMON
# <<< codex-app-server-bridge <<<
```
