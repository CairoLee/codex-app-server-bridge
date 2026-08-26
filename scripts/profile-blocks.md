以下 marker block 由安装步骤写入对应 shell 文件。卸载时只删除 marker 之间的内容。

## `.zshenv` 与 `.zshrc`

```zsh
# >>> chatgpt-codex-primary >>>
chatgpt_codex_primary_bin="$HOME/.local/share/chatgpt-codex-primary/current/bin"
path=("$chatgpt_codex_primary_bin" ${path:#"$chatgpt_codex_primary_bin"})
export PATH
unset chatgpt_codex_primary_bin
# <<< chatgpt-codex-primary <<<
```

## `.zprofile`

```zsh
# >>> chatgpt-codex-primary >>>
export CODEX_CLI_PATH="$HOME/.local/share/chatgpt-codex-primary/current/bin/chatgpt-codex"
export CODEX_INSTALL_DIR="$HOME/.local/share/chatgpt-codex-primary/current/bin"
unset CODEX_APP_SERVER_USE_LOCAL_DAEMON
# <<< chatgpt-codex-primary <<<
```
