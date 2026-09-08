#!/bin/sh
set -eu
# Resolve optional 1Password variables once, without runtime package downloads.
if [ -n "${OP_TOKEN:-}" ] && [ -z "${CAPI_ENV_RESOLVED:-}" ]; then
  export CAPI_ENV_RESOLVED=1
  exec bun /app/node_modules/varlock/bin/cli.js run -- /entrypoint.sh "$@"
fi
case "${1:-}" in
  admin|storage|config|auth|debug|check-usage) exec bun /app/dist/main.js "$@" ;;
  --auth) shift; exec bun /app/dist/main.js auth "$@" ;;
  start) shift ;;
esac
set -- start "$@"
[ -z "${COPILOT_HOST:-}" ] || set -- "$@" --host "$COPILOT_HOST"
[ "${COPILOT_VERBOSE:-}" != "true" ] || set -- "$@" --verbose
[ "${COPILOT_DEBUG:-}" != "true" ] || set -- "$@" --debug
exec bun /app/dist/main.js "$@"
