#!/usr/bin/env bash
set -euo pipefail

CRON_TEMPLATE="${CRON_TEMPLATE:-/etc/cron.d/microsoft-rewards-cron.template}"
CRON_FILE="${CRON_FILE:-/etc/cron.d/microsoft-rewards-cron}"
SCHEDULE_FILE="${SCHEDULE_FILE:-/usr/src/microsoft-rewards-script/dist/config/schedule.json}"

validate_cron_schedule() {
  local schedule="${1:-}"
  local fields

  fields=$(printf '%s\n' "$schedule" | awk '{print NF}')
  if [ "$fields" -ne 5 ]; then
    echo "CRON_SCHEDULE must contain exactly 5 fields" >&2
    return 1
  fi

  if printf '%s\n' "$schedule" | grep -Eq '(^|[[:space:]])(@|[A-Za-z]|;|&&|\|\||`|\$|\(|\)|<|>)'; then
    echo "CRON_SCHEDULE contains unsupported characters" >&2
    return 1
  fi
}

write_schedule_file() {
  local schedule="$1"
  mkdir -p "$(dirname "$SCHEDULE_FILE")"
  jq -n \
    --arg schedule "$schedule" \
    --arg timezone "${TZ:-UTC}" \
    --arg updatedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{schedule:$schedule, timezone:$timezone, updatedAt:$updatedAt}' > "$SCHEDULE_FILE"
}

render_cron_file() {
  local schedule="$1"
  local escaped_schedule

  validate_cron_schedule "$schedule"
  if [ ! -f "$CRON_TEMPLATE" ]; then
    echo "Cron template not found: $CRON_TEMPLATE" >&2
    return 1
  fi

  escaped_schedule=$(printf '%s' "$schedule" | sed 's/[&/\]/\\&/g')
  sed \
    -e "s|\${CRON_SCHEDULE}|$escaped_schedule|g" \
    -e "s|\${TZ}|${TZ:-UTC}|g" \
    "$CRON_TEMPLATE" > "$CRON_FILE"
  chmod 0644 "$CRON_FILE"
  write_schedule_file "$schedule"
}

reload_cron_service() {
  if command -v service >/dev/null 2>&1; then
    service cron reload >/dev/null 2>&1 || service cron restart >/dev/null 2>&1 || service cron start
  fi
}

current_schedule() {
  if [ -f "$SCHEDULE_FILE" ]; then
    jq -r '.schedule // empty' "$SCHEDULE_FILE" 2>/dev/null || true
  fi
}

case "${1:-}" in
  apply)
    schedule="${2:-${CRON_SCHEDULE:-}}"
    if [ -z "$schedule" ]; then
      echo "CRON_SCHEDULE is required" >&2
      exit 1
    fi
    render_cron_file "$schedule"
    reload_cron_service
    echo "[schedule] Applied CRON_SCHEDULE=$schedule"
    ;;
  validate)
    validate_cron_schedule "${2:-}"
    ;;
  current)
    current_schedule
    ;;
  *)
    echo "Usage: schedule.sh apply <5-field-cron> | validate <5-field-cron> | current" >&2
    exit 2
    ;;
esac
