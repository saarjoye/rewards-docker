#!/bin/sh
set -e

# 设置时区
if [ ! -z "$TZ" ]; then
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime
    echo $TZ > /etc/timezone
fi

# 创建日志文件
mkdir -p /var/log
touch /var/log/microsoft-rewards.log
touch /var/log/cron.log
chmod 666 /var/log/microsoft-rewards.log
chmod 666 /var/log/cron.log
echo "Log files created at /var/log/microsoft-rewards.log and /var/log/cron.log"

# 启用 cron 日志记录
sed -i 's/^#cron\.log/cron.log/' /etc/rsyslog.conf 2>/dev/null || echo "Cron logging already enabled or rsyslog config not found"
service rsyslog restart 2>/dev/null || echo "rsyslog restart skipped"

# 确保配置文件存在
if [ ! -f "src/accounts.json" ]; then
    echo "Error: accounts.json not found. Please mount it or create it."
    exit 1
fi

# 设置 cron 任务
if [ -f "/etc/cron.d/microsoft-rewards-cron.template" ]; then
    # 替换模板中的占位符
    # 转义 CRON_SCHEDULE 中的特殊字符（特别是 *）
    CRON_SCHEDULE_ESCAPED=$(printf '%s\n' "$CRON_SCHEDULE" | sed 's/[&/\]/\\&/g')
    
    # 使用环境变量替换模板中的占位符
    sed -e "s|\${CRON_SCHEDULE}|$CRON_SCHEDULE_ESCAPED|g" \
        -e "s|\${TZ}|$TZ|g" \
        /etc/cron.d/microsoft-rewards-cron.template > /etc/cron.d/microsoft-rewards-cron
    
    chmod 0644 /etc/cron.d/microsoft-rewards-cron
    
    # 应用cron配置（cron daemon会在启动时自动读取）
    echo "Cron configuration applied to /etc/cron.d/microsoft-rewards-cron"
    echo "Cron schedule: $CRON_SCHEDULE"
    
    # 如果设置了RUN_ON_START=true，则立即执行一次任务
    if [ "$RUN_ON_START" = "true" ]; then
        echo "RUN_ON_START is enabled. Executing task immediately in background..."
        SKIP_RANDOM_SLEEP=true /usr/src/microsoft-rewards-script/scripts/docker/run_daily.sh &
    fi
else
    echo "Warning: Cron template not found at /etc/cron.d/microsoft-rewards-cron.template"
fi

# Start log forwarder in background to stream logs to Docker
echo "Starting log forwarder to stream logs to docker logs..."
/usr/src/microsoft-rewards-script/scripts/docker/log-forwarder.sh &
LOG_FORWARDER_PID=$!

# Give log forwarder time to start
sleep 1

# Check if log forwarder is running
if ! kill -0 "$LOG_FORWARDER_PID" 2>/dev/null; then
    echo "Warning: Log forwarder failed to start. Logs may not appear in docker logs."
fi

# Start cron daemon in background
echo "Starting cron daemon..."
cron

# Wait for cron to be ready
sleep 2

# Verify cron is running
if pgrep -x cron > /dev/null; then
    echo "Cron daemon is running (PID: $(pgrep -x cron))"
else
    echo "Error: Cron daemon failed to start"
    exit 1
fi

echo "Container is running. Scheduled tasks will execute at: $CRON_SCHEDULE"
echo "Logs will appear in both:"
echo "  - docker logs <container_name>"
echo "  - /var/log/microsoft-rewards.log (inside container)"

# Keep container alive and wait for signals
# Both cron and log forwarder are running in background
wait
