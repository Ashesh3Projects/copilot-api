#!/bin/sh
set -eu
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
