#!/bin/bash
set -e

CONTAINER_NAME=${1:-"microsoft-rewards-script"}

echo "=========================================="
echo "Docker Cron 诊断工具"
echo "=========================================="
echo ""

echo "容器状态:"
docker ps --filter "name=$CONTAINER_NAME" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
echo ""

echo "=========================================="
echo "1. Cron 守护进程状态"
echo "=========================================="
if docker exec "$CONTAINER_NAME" pgrep cron > /dev/null; then
    CRON_PID=$(docker exec "$CONTAINER_NAME" pgrep cron)
    echo "✅ Cron 守护进程正在运行 (PID: $CRON_PID)"
    echo ""
    echo "Cron 进程详情:"
    docker exec "$CONTAINER_NAME" ps aux | grep cron | grep -v grep
else
    echo "❌ Cron 守护进程未运行"
fi
echo ""

echo "=========================================="
echo "2. Cron 配置文件"
echo "=========================================="
echo "主配置文件 (/etc/cron.d/microsoft-rewards-cron):"
docker exec "$CONTAINER_NAME" cat /etc/cron.d/microsoft-rewards-cron
echo ""

echo "其他 cron 配置文件:"
docker exec "$CONTAINER_NAME" ls -la /etc/cron.d/ | grep -v "total\|d\|\.placeholder\|e2scrub_all"
echo ""

echo "=========================================="
echo "3. 时间和时区设置"
echo "=========================================="
echo "容器时间:"
docker exec "$CONTAINER_NAME" date
echo ""
echo "时区设置:"
docker exec "$CONTAINER_NAME" cat /etc/timezone 2>/dev/null || echo "未设置"
echo ""
echo "环境变量 TZ:"
docker exec "$CONTAINER_NAME" env | grep TZ || echo "未设置"
echo ""

echo "=========================================="
echo "4. 锁文件状态"
echo "=========================================="
if docker exec "$CONTAINER_NAME" test -f /tmp/run_daily.lock; then
    echo "⚠️  锁文件存在"
    echo ""
    echo "锁文件内容:"
    docker exec "$CONTAINER_NAME" cat /tmp/run_daily.lock
    echo ""
    LOCK_PID=$(docker exec "$CONTAINER_NAME" cat /tmp/run_daily.lock)
    echo "检查锁文件中的进程是否还在运行..."
    if docker exec "$CONTAINER_NAME" kill -0 "$LOCK_PID" 2>/dev/null; then
        echo "✅ 进程 $LOCK_PID 仍在运行"
        echo ""
        echo "进程详情:"
        docker exec "$CONTAINER_NAME" ps aux | grep "$LOCK_PID" | grep -v grep
    else
        echo "❌ 进程 $LOCK_PID 已死亡，锁文件是陈旧的"
    fi
else
    echo "✅ 锁文件不存在，没有正在运行的任务"
fi
echo ""

echo "=========================================="
echo "5. 应用程序日志分析"
echo "=========================================="
echo "日志文件信息:"
docker exec "$CONTAINER_NAME" ls -lh /var/log/microsoft-rewards.log 2>/dev/null || echo "日志文件不存在"
echo ""

echo "最近的执行记录 (最后 50 行):"
docker exec "$CONTAINER_NAME" tail -50 /var/log/microsoft-rewards.log 2>/dev/null | grep -E "(RUN-START|RUN-END|ACCOUNT-START|ACCOUNT-END|脚本完成)" || echo "没有找到执行记录"
echo ""

echo "=========================================="
echo "6. 检查今天早上的执行"
echo "=========================================="
TODAY=$(docker exec "$CONTAINER_NAME" date +%Y-%m-%d)
echo "今天的日期: $TODAY"
echo ""
echo "查找今天的执行记录:"
docker exec "$CONTAINER_NAME" grep -E "($TODAY|$(docker exec "$CONTAINER_NAME" date +%m/%d))" /var/log/microsoft-rewards.log 2>/dev/null | head -20 || echo "没有找到今天的执行记录"
echo ""

echo "=========================================="
echo "7. Cron 邮件/错误日志"
echo "=========================================="
echo "检查 cron 邮件目录:"
docker exec "$CONTAINER_NAME" ls -la /var/mail/ 2>/dev/null || echo "邮件目录不存在"
echo ""

echo "检查系统日志中的 cron 记录:"
docker exec "$CONTAINER_NAME" cat /var/log/syslog 2>/dev/null | grep -i cron | tail -20 || echo "没有找到 syslog 中的 cron 记录"
echo ""

echo "=========================================="
echo "8. 容器启动时间"
echo "=========================================="
START_TIME=$(docker inspect "$CONTAINER_NAME" --format='{{.State.StartedAt}}')
echo "容器启动时间: $START_TIME"
echo ""
echo "容器运行时间:"
docker exec "$CONTAINER_NAME" uptime
echo ""

echo "=========================================="
echo "9. 手动测试 cron 任务"
echo "=========================================="
echo "创建一个测试任务，将在下一分钟执行..."
NEXT_MINUTE=$(($(docker exec "$CONTAINER_NAME" date +%M) + 1))
if [ $NEXT_MINUTE -eq 60 ]; then
    NEXT_MINUTE=0
fi

docker exec "$CONTAINER_NAME" bash -c "cat > /etc/cron.d/diagnostic-test << 'EOF'
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
TZ=Asia/Shanghai

$NEXT_MINUTE * * * * root /bin/bash -c 'echo \"Diagnostic test at \$(date)\" >> /var/log/diagnostic-test.log 2>&1'

EOF
chmod 0644 /etc/cron.d/diagnostic-test && kill -HUP 1"

echo "测试任务将在 $NEXT_MINUTE 分执行"
echo "等待 90 秒..."
sleep 90

if docker exec "$CONTAINER_NAME" test -f /var/log/diagnostic-test.log && [ -s /var/log/diagnostic-test.log ]; then
    echo "✅ 测试任务成功执行"
    echo ""
    echo "测试任务日志:"
    docker exec "$CONTAINER_NAME" cat /var/log/diagnostic-test.log
    docker exec "$CONTAINER_NAME" rm -f /etc/cron.d/diagnostic-test /var/log/diagnostic-test.log
else
    echo "❌ 测试任务未执行或日志为空"
    echo ""
    echo "检查 /var/log 目录:"
    docker exec "$CONTAINER_NAME" ls -la /var/log/ | grep -E "(diagnostic|test)"
fi
echo ""

echo "=========================================="
echo "✅ 诊断完成"
echo "=========================================="
echo ""
echo "建议:"
echo "1. 如果 cron 守护进程未运行，请重启容器"
echo "2. 如果锁文件存在但进程已死亡，请删除锁文件"
echo "3. 如果今天早上的任务没有执行，请检查容器是否在 7:00 前重启过"
echo "4. 如果测试任务成功执行，说明 cron 配置正确"
echo ""
echo "监控命令:"
echo "  - 容器日志: docker logs -f $CONTAINER_NAME"
echo "  - 应用日志: docker exec -it $CONTAINER_NAME tail -f /var/log/microsoft-rewards.log"
echo "  - Cron 配置: docker exec $CONTAINER_NAME cat /etc/cron.d/microsoft-rewards-cron"
