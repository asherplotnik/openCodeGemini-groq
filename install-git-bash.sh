#!/usr/bin/env bash

set -euo pipefail

task_harness_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
task_secret_path="$task_harness_dir/.env"
task_config_path="$task_harness_dir/opencode.json"
task_bashrc_path="$HOME/.bashrc"
task_marker_start='# >>> opencode-groq-harness >>>'
task_marker_end='# <<< opencode-groq-harness <<<'

if [[ ! -r "$task_secret_path" ]]; then
  printf 'Missing API key file: %s\n' "$task_secret_path" >&2
  exit 1
fi

if ! grep -qE '^\s*GROQ_API_KEY\s*=\s*gsk_.+\s*$' "$task_secret_path"; then
  printf '%s must contain GROQ_API_KEY=gsk_...\n' "$task_secret_path" >&2
  exit 1
fi

if [[ ! -r "$task_config_path" ]]; then
  printf 'Missing OpenCode config: %s\n' "$task_config_path" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  printf 'npm is required to install OpenCode globally.\n' >&2
  exit 1
fi

if command -v opencode >/dev/null 2>&1; then
  printf 'OpenCode is already installed globally.\n'
else
  npm install --global opencode-ai
fi

touch "$task_bashrc_path"
task_bashrc_temp=$(mktemp)
awk -v start="$task_marker_start" -v end="$task_marker_end" '
  $0 == start { in_block = 1; next }
  $0 == end { in_block = 0; next }
  !in_block { print }
' "$task_bashrc_path" > "$task_bashrc_temp"
mv "$task_bashrc_temp" "$task_bashrc_path"

task_harness_dir_quoted=$(printf '%q' "$task_harness_dir")
task_config_path_quoted=$(printf '%q' "$task_config_path")

cat >> "$task_bashrc_path" <<EOF

$task_marker_start
function opencode() (
  local task_harness_dir=$task_harness_dir_quoted
  local task_config_path=$task_config_path_quoted
  local task_secret_path="\$task_harness_dir/.env"
  local task_env_line
  local task_env_name
  local task_env_value

  if [[ ! -r "\$task_secret_path" ]]; then
    printf 'GROQ_API_KEY file not found: %s\\n' "\$task_secret_path" >&2
    return 1
  fi

  while IFS= read -r task_env_line || [[ -n "\$task_env_line" ]]; do
    [[ "\$task_env_line" =~ ^[[:space:]]*(#|\$) ]] && continue
    if [[ "\$task_env_line" =~ ^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)\$ ]]; then
      task_env_name=\${BASH_REMATCH[1]}
      task_env_value=\${BASH_REMATCH[2]}
      task_env_value="\${task_env_value#\"\${task_env_value%%[![:space:]]*}\"}"
      task_env_value="\${task_env_value%\"\${task_env_value##*[![:space:]]}\"}"
      if [[ \${#task_env_value} -ge 2 && ( "\${task_env_value:0:1}" == '"' || "\${task_env_value:0:1}" == "'" ) && "\${task_env_value: -1}" == "\${task_env_value:0:1}" ]]; then
        task_env_value=\${task_env_value:1:-1}
      fi
      export "\$task_env_name=\$task_env_value"
    else
      printf 'Invalid .env entry: %s\\n' "\$task_env_line" >&2
      return 1
    fi
  done < <(tr -d '\r' < "\$task_secret_path")

  if [[ -z \${GROQ_API_KEY:-} ]]; then
    printf 'GROQ_API_KEY was not found in %s\\n' "\$task_secret_path" >&2
    return 1
  fi

  local task_proxy_port=\${GEMINI_PROXY_PORT:-8787}
  local task_proxy_url="http://127.0.0.1:\$task_proxy_port/health"
  local task_proxy_pid
  local task_proxy_started=0
  if ! curl --silent --fail --max-time 1 "\$task_proxy_url" >/dev/null; then
    if [[ \${GEMINI_PROXY_DEBUG:-} == 1 ]]; then
      node "\$task_harness_dir/scripts/gemini-stream-proxy.mjs" &
    else
      node "\$task_harness_dir/scripts/gemini-stream-proxy.mjs" >/dev/null 2>&1 &
    fi
    task_proxy_pid=\$!
    task_proxy_started=1
    for _ in {1..20}; do
      if curl --silent --fail --max-time 1 "\$task_proxy_url" >/dev/null; then
        break
      fi
      sleep 0.1
    done
    if ! curl --silent --fail --max-time 1 "\$task_proxy_url" >/dev/null; then
      kill "\$task_proxy_pid" 2>/dev/null || true
      printf 'Could not start the local Gemini stream proxy.\\n' >&2
      return 1
    fi
  fi

  export OPENCODE_CONFIG="\$task_config_path"
  command opencode "\$@"
  local task_status=\$?
  if (( task_proxy_started )); then
    kill "\$task_proxy_pid" 2>/dev/null || true
    wait "\$task_proxy_pid" 2>/dev/null || true
  fi
  return "\$task_status"
)
$task_marker_end
EOF

printf '\nOpen a new Git Bash window, then run: opencode\n'
