#!/usr/bin/env bash
set -euo pipefail

export PLAYWRIGHT_BROWSERS_PATH=0
export TZ="${TZ:-UTC}"

cd /usr/src/microsoft-rewards-script

LOCKFILE=/tmp/run_daily.lock

# -------------------------------
#  函数: 检查并修复锁文件完整性
# -------------------------------
self_heal_lockfile() {
    # 如果锁文件存在但为空  删除它
    if [ -f "$LOCKFILE" ]; then
        local lock_content
        lock_content=$(<"$LOCKFILE" || echo "")

        if [[ -z "$lock_content" ]]; then
            echo "[$(date)] [run_daily.sh] 发现空锁文件  正在删除。"
            rm -f "$LOCKFILE"
            return
        fi

        # 如果锁文件包含非数字PID  删除它
        if ! [[ "$lock_content" =~ ^[0-9]+$ ]]; then
            echo "[$(date)] [run_daily.sh] 发现损坏的锁文件内容 ('$lock_content')  正在删除。"
            rm -f "$LOCKFILE"
            return
        fi

        # 如果锁文件包含PID但进程已死  删除它
        if ! kill -0 "$lock_content" 2>/dev/null; then
            echo "[$(date)] [run_daily.sh] 锁文件PID $lock_content 已死亡  正在删除陈旧锁。"
            rm -f "$LOCKFILE"
            return
        fi
    fi
}

# -------------------------------
#  函数: 获取锁
# -------------------------------
acquire_lock() {
    local max_attempts=5
    local attempt=0
    local timeout_hours=${STUCK_PROCESS_TIMEOUT_HOURS:-8}
    local timeout_seconds=$((timeout_hours * 3600))

    while [ $attempt -lt $max_attempts ]; do
        # 尝试使用当前PID创建锁
        if (set -C; echo "$$" > "$LOCKFILE") 2>/dev/null; then
            echo "[$(date)] [run_daily.sh] 锁获取成功 (PID: $$)"
            return 0
        fi

        # 锁存在，验证它
        if [ -f "$LOCKFILE" ]; then
            local existing_pid
            existing_pid=$(<"$LOCKFILE" || echo "")

            echo "[$(date)] [run_daily.sh] 锁文件存在，PID: '$existing_pid'"

            # 如果锁文件内容无效  删除并重试
            if [[ -z "$existing_pid" || ! "$existing_pid" =~ ^[0-9]+$ ]]; then
                echo "[$(date)] [run_daily.sh] 删除无效锁文件  重试..."
                rm -f "$LOCKFILE"
                continue
            fi

            # 如果进程已死  删除并重试
            if ! kill -0 "$existing_pid" 2>/dev/null; then
                echo "[$(date)] [run_daily.sh] 删除陈旧锁 (死PID: $existing_pid)"
                rm -f "$LOCKFILE"
                continue
            fi

            # 检查进程运行时间  如果超过超时则终止
            local process_age
            if process_age=$(ps -o etimes= -p "$existing_pid" 2>/dev/null | tr -d ' '); then
                if [ "$process_age" -gt "$timeout_seconds" ]; then
                    echo "[$(date)] [run_daily.sh] 终止卡住的进程 $existing_pid (${process_age}s > ${timeout_hours}h)"
                    kill -TERM "$existing_pid" 2>/dev/null || true
                    sleep 5
                    kill -KILL "$existing_pid" 2>/dev/null || true
                    rm -f "$LOCKFILE"
                    continue
                fi
            fi
        fi

        echo "[$(date)] [run_daily.sh] 锁被PID $existing_pid 持有，尝试 $((attempt + 1))/$max_attempts"
        sleep 2
        ((attempt++))
    done

    echo "[$(date)] [run_daily.sh] 尝试 $max_attempts 次后仍无法获取锁；退出。"
    return 1
}

# -------------------------------
#  函数: 释放锁
# -------------------------------
release_lock() {
    if [ -f "$LOCKFILE" ]; then
        local lock_pid
        lock_pid=$(<"$LOCKFILE")
        if [ "$lock_pid" = "$$" ]; then
            rm -f "$LOCKFILE"
            echo "[$(date)] [run_daily.sh] 锁已释放 (PID: $$)"
        fi
    fi
}

# 退出时始终释放锁  但仅在我们获得锁时
trap 'release_lock' EXIT INT TERM

# -------------------------------
#  主执行流程
# -------------------------------
echo "[$(date)] [run_daily.sh] 当前进程PID: $$"

# 在继续之前自愈任何损坏或空锁
self_heal_lockfile

# 尝试安全获取锁
if ! acquire_lock; then
    exit 0
fi

# 在MIN和MAX之间随机休眠以分散执行
MINWAIT=${MIN_SLEEP_MINUTES:-5}
MAXWAIT=${MAX_SLEEP_MINUTES:-50}
MINWAIT_SEC=$((MINWAIT*60))
MAXWAIT_SEC=$((MAXWAIT*60))

if [ "${SKIP_RANDOM_SLEEP:-false}" != "true" ]; then
    SLEEPTIME=$(( MINWAIT_SEC + RANDOM % (MAXWAIT_SEC - MINWAIT_SEC) ))
    echo "[$(date)] [run_daily.sh] 休眠 $((SLEEPTIME/60)) 分钟 ($SLEEPTIME 秒)"
    sleep "$SLEEPTIME"
else
    echo "[$(date)] [run_daily.sh] 跳过随机休眠"
fi

# 启动实际脚本
echo "[$(date)] [run_daily.sh] 开始脚本..."
if npm start 2>&1 | tee -a /var/log/microsoft-rewards.log; then
    echo "[$(date)] [run_daily.sh] 脚本成功完成。"
else
    echo "[$(date)] [run_daily.sh] 错误: 脚本失败！" >&2
fi

echo "[$(date)] [run_daily.sh] 脚本完成"
# 锁通过trap自动释放