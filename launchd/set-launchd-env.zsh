#!/bin/zsh
set -eu

script_directory="${0:a:h}"
install_root="${CHATGPT_CODEX_INSTALL_ROOT:-${script_directory:h:h}}"
/bin/launchctl setenv CODEX_CLI_PATH "$install_root/current/bin/chatgpt-codex"
/bin/launchctl unsetenv CODEX_APP_SERVER_USE_LOCAL_DAEMON
