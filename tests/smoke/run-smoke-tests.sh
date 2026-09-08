#!/bin/bash
set -euo pipefail

SERVER_URL="${1:?Usage: $0 <server-url>}"
export SERVER_URL
: "${SMOKE_GATEWAY_KEY:?Supply the explicitly provisioned smoke gateway key}"
export SMOKE_GATEWAY_KEY
PASS=0
FAIL=0
SKIP=0
RESULTS=()

if [ "${SMOKE_REQUIRE_CLIENTS:-0}" = "1" ]; then
  for client in claude codex gemini; do
    command -v "$client" >/dev/null || { echo "Required smoke client missing: $client"; exit 1; }
  done
fi

run_test() {
  local name="$1"; shift
  echo ""
  echo "--- $name ---"
  if timeout 120 bash -c "$*" 2>&1; then
    PASS=$((PASS+1))
    RESULTS+=("PASS  $name")
    echo "PASS: $name"
  else
    FAIL=$((FAIL+1))
    RESULTS+=("FAIL  $name")
    echo "FAIL: $name"
  fi
}

skip_test() {
  local name="$1"
  SKIP=$((SKIP+1))
  RESULTS+=("SKIP  $name")
  echo "SKIP: $name"
}

cleanup_smoke_file() {
  rm -f smoke.txt
}

cleanup_codex_output() {
  rm -f codex-output.txt
}

cleanup_claude_output() {
  rm -f claude-output.json
}

cleanup_gemini_output() {
  rm -f gemini-output.json
}

trap 'cleanup_smoke_file; cleanup_codex_output; cleanup_claude_output; cleanup_gemini_output' EXIT

###############################################################################
# Direct API test (curl) to verify the Messages endpoint works
###############################################################################
echo ""
echo "==============================="
echo "  Direct API Tests (curl)"
echo "==============================="

run_test "api:messages-endpoint" '
  response=$(curl -s -w "\nHTTP_STATUS:%{http_code}" -X POST "$SERVER_URL/v1/messages" \
    -H "Content-Type: application/json" \
    -H "x-api-key: $SMOKE_GATEWAY_KEY" \
    -H "anthropic-version: 2023-06-01" \
    -d "{
      \"model\": \"claude-sonnet-4.6\",
      \"max_tokens\": 64,
      \"stream\": false,
      \"messages\": [{\"role\": \"user\", \"content\": \"Reply with exactly: SMOKE_TEST_OK\"}]
    }" 2>&1)
  status=$?
  echo "$response"
  test "$status" -eq 0 \
    && echo "$response" | grep -q "HTTP_STATUS:200" \
    && echo "$response" | grep -q "SMOKE_TEST_OK"
'

###############################################################################
# Claude Code
###############################################################################
echo ""
echo "==============================="
echo "  Claude Code Tests"
echo "==============================="

if command -v claude &>/dev/null; then
  export ANTHROPIC_BASE_URL="$SERVER_URL"
  export ANTHROPIC_AUTH_TOKEN="$SMOKE_GATEWAY_KEY"
  export ANTHROPIC_MODEL="claude-sonnet-4.6"
  export ANTHROPIC_SMALL_FAST_MODEL="gpt-4o-mini"
  export DISABLE_NON_ESSENTIAL_MODEL_CALLS="1"
  export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"

  run_test "claude-code:text-generation" '
    output_file="claude-output.json"
    rm -f "$output_file"
    claude -p "Reply with exactly: SMOKE_TEST_OK" --output-format json \
      > "$output_file"
    status=$?
    output=$(cat "$output_file")
    echo "$output"
    test "$status" -eq 0 && python3 -c "import json, sys; payload = json.load(open(sys.argv[1])); raise SystemExit(0 if payload.get(\"result\", \"\").strip() == \"SMOKE_TEST_OK\" else \"Claude response did not match SMOKE_TEST_OK\")" "$output_file"
  '
  cleanup_claude_output

  cleanup_smoke_file
  run_test "claude-code:tool-calling" '
    output=$(claude -p "Create a file called smoke.txt with the content: hello" --dangerously-skip-permissions --output-format json 2>&1)
    status=$?
    echo "$output"
    test "$status" -eq 0 && test -f smoke.txt && grep -q "hello" smoke.txt
  '
  cleanup_smoke_file
else
  skip_test "claude-code:text-generation"
  skip_test "claude-code:tool-calling"
fi

###############################################################################
# Codex CLI
###############################################################################
echo ""
echo "==============================="
echo "  Codex CLI Tests"
echo "==============================="

if command -v codex &>/dev/null; then
  export OPENAI_API_KEY="$SMOKE_GATEWAY_KEY"
  CODEX_BASE_URL_CONFIG="openai_base_url=\"$SERVER_URL/v1\""
  export CODEX_BASE_URL_CONFIG

  run_test "codex:text-generation" '
    output_file="codex-output.txt"
    rm -f "$output_file"
    output=$(codex exec --ignore-user-config --ephemeral \
      --config "$CODEX_BASE_URL_CONFIG" \
      --output-last-message "$output_file" \
      "Reply with exactly: SMOKE_TEST_OK" 2>&1)
    status=$?
    echo "$output"
    test "$status" -eq 0 && test "$(tr -d "\r\n" < "$output_file")" = "SMOKE_TEST_OK"
  '
  cleanup_codex_output

  cleanup_smoke_file
  run_test "codex:tool-calling" '
    output=$(codex exec --ignore-user-config --ephemeral \
      --config "$CODEX_BASE_URL_CONFIG" \
      --dangerously-bypass-approvals-and-sandbox \
      "Create a file called smoke.txt with the content: hello" 2>&1)
    status=$?
    echo "$output"
    test "$status" -eq 0 && test -f smoke.txt && grep -q "hello" smoke.txt
  '
  cleanup_smoke_file
else
  skip_test "codex:text-generation"
  skip_test "codex:tool-calling"
fi

###############################################################################
# Gemini CLI
###############################################################################
echo ""
echo "==============================="
echo "  Gemini CLI Tests"
echo "==============================="

if command -v gemini &>/dev/null; then
  export GEMINI_API_KEY="$SMOKE_GATEWAY_KEY"
  export GOOGLE_GEMINI_BASE_URL="$SERVER_URL"
  export GEMINI_CLI_SYSTEM_SETTINGS_PATH="$PWD/tests/smoke/gemini-system-settings.json"

  # Explicit API-key auth avoids Gemini CLI treating the custom base URL as an
  # invalid gateway auth method. The model bypasses its proxy-hosted classifier.
  run_test "gemini:text-generation" '
    output_file="gemini-output.json"
    rm -f "$output_file"
    gemini --skip-trust --output-format json \
      --model gemini-3.1-pro-preview -p "Reply with exactly: SMOKE_TEST_OK" \
      > "$output_file"
    status=$?
    output=$(cat "$output_file")
    echo "$output"
    test "$status" -eq 0 && python3 -c "import json, sys; payload = json.load(open(sys.argv[1])); raise SystemExit(0 if payload.get(\"response\", \"\").strip() == \"SMOKE_TEST_OK\" else \"Gemini response did not match SMOKE_TEST_OK\")" "$output_file"
  '
  cleanup_gemini_output

  cleanup_smoke_file
  run_test "gemini:tool-calling" '
    output=$(gemini --skip-trust --output-format json \
      --model gemini-3.1-pro-preview -p "Create a file called smoke.txt with the content: hello" -y 2>&1)
    status=$?
    echo "$output"
    test "$status" -eq 0 && test -f smoke.txt && grep -q "hello" smoke.txt
  '
  cleanup_smoke_file
else
  skip_test "gemini:text-generation"
  skip_test "gemini:tool-calling"
fi

###############################################################################
# Summary
###############################################################################
echo ""
echo "==============================="
echo "  Results"
echo "==============================="
for r in "${RESULTS[@]}"; do
  echo "  $r"
done
echo ""
echo "=== $PASS passed, $FAIL failed, $SKIP skipped ==="
[ "$FAIL" -eq 0 ]
