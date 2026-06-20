#!/bin/bash
# Log forwarder: Monitor log file and output to stdout for Docker logs
# This allows cron job logs to appear in docker logs

LOG_FILE="${LOG_FILE:-/var/log/microsoft-rewards.log}"
PID_FILE="/var/log/log-forwarder.pid"

# Check if already running
if [ -f "$PID_FILE" ]; then
    OLD_PID=$(cat "$PID_FILE")
    if kill -0 "$OLD_PID" 2>/dev/null; then
        echo "Log forwarder already running (PID: $OLD_PID)"
        exit 0
    else
        rm -f "$PID_FILE"
    fi
fi

# Save PID
echo $$ > "$PID_FILE"

# Ensure log file exists
touch "$LOG_FILE"

# Get initial size
LAST_SIZE=$(stat -c%s "$LOG_FILE" 2>/dev/null || echo 0)

echo "[$(date '+%a %b %d %H:%M:%S %Z %Y')] [log-forwarder] Log forwarder started | watching: $LOG_FILE"

# Monitor log file for new content
tail -n 0 -F "$LOG_FILE" 2>/dev/null | while IFS= read -r line; do
    echo "$line"
done
