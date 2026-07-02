#!/usr/bin/env bash
set -euo pipefail

export PLAYWRIGHT_BROWSERS_PATH=0
export TZ="${TZ:-UTC}"

cd /usr/src/microsoft-rewards-script

LOCKFILE="${RUN_LOCK_FILE:-/tmp/run_daily.lock}"
LOCK_META_FILE="${RUN_LOCK_META_FILE:-/tmp/run_daily.lock.meta}"
RUNTIME_LOG_FILE="${RUNTIME_LOG_FILE:-/var/log/microsoft-rewards.log}"
RUN_SOURCE="${RUN_SOURCE:-cron}"
RUN_MODE="${RUN_MODE:-task}"
RUN_ACCOUNT_MODE="${RUN_ACCOUNT_MODE:-continue}"
RUN_ACCOUNT_INDEX="${RUN_ACCOUNT_INDEX:-}"
MANUAL_TASK="${MANUAL_TASK:-}"
RUN_FAIL_ON_LOCK="${RUN_FAIL_ON_LOCK:-false}"
SCRIPT_PID="$$"
CHILD_PID=""

export RUN_SOURCE RUN_MODE RUN_ACCOUNT_MODE RUN_ACCOUNT_INDEX MANUAL_TASK RUN_FAIL_ON_LOCK RUNTIME_LOG_FILE

log() {
    echo "[$(date)] [run_daily.sh] $*"
}

json_escape() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_lock_meta() {
    local started_at
    started_at="$(date -Iseconds)"
    cat > "$LOCK_META_FILE" <<EOF
{
  "pid": $SCRIPT_PID,
  "source": "$(json_escape "$RUN_SOURCE")",
  "mode": "$(json_escape "$RUN_MODE")",
  "accountMode": "$(json_escape "$RUN_ACCOUNT_MODE")",
  "accountIndex": "$(json_escape "$RUN_ACCOUNT_INDEX")",
  "manualTask": "$(json_escape "$MANUAL_TASK")",
  "startedAt": "$(json_escape "$started_at")",
  "skipRandomSleep": "$(json_escape "${SKIP_RANDOM_SLEEP:-false}")",
  "logFile": "$(json_escape "$RUNTIME_LOG_FILE")"
}
EOF
}

read_lock_pid() {
    if [ ! -f "$LOCKFILE" ]; then
        return 1
    fi
    local pid
    pid="$(cat "$LOCKFILE" 2>/dev/null || true)"
    if [[ "$pid" =~ ^[0-9]+$ ]]; then
        printf '%s' "$pid"
        return 0
    fi
    return 1
}

is_alive() {
    local pid="${1:-}"
    [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

process_age() {
    local pid="$1"
    ps -o etimes= -p "$pid" 2>/dev/null | tr -d ' ' || true
}

remove_stale_lock() {
    rm -f "$LOCKFILE" "$LOCK_META_FILE"
    return 0
}

self_heal_lockfile() {
    if [ ! -f "$LOCKFILE" ]; then
        [ -f "$LOCK_META_FILE" ] && rm -f "$LOCK_META_FILE"
        return 0
    fi

    local lock_pid
    if ! lock_pid="$(read_lock_pid)"; then
        log "发现损坏的锁文件，正在删除。"
        remove_stale_lock
        return 0
    fi

    if ! is_alive "$lock_pid"; then
        log "锁文件PID $lock_pid 已死亡，正在删除陈旧锁。"
        remove_stale_lock
        return 0
    fi

    return 0
}

find_other_runner() {
    local current="$SCRIPT_PID"
    local pids pid cmd
    pids="$(pgrep -f '[n]ode .*dist/index\.js|[n]pm start' 2>/dev/null || true)"
    for pid in $pids; do
        [ "$pid" = "$current" ] && continue
        [ "$pid" = "$PPID" ] && continue
        cmd="$(ps -o args= -p "$pid" 2>/dev/null || true)"
        [ -z "$cmd" ] && continue
        case "$cmd" in
            *"pgrep -f"*|*"ps -o args="*) continue ;;
        esac
        printf '%s' "$pid"
        return 0
    done
    return 1
}

handle_existing_runner() {
    local existing_pid="$1"
    local timeout_hours=${STUCK_PROCESS_TIMEOUT_HOURS:-8}
    local timeout_seconds=$((timeout_hours * 3600))
    local age

    age="$(process_age "$existing_pid")"
    if [[ "$age" =~ ^[0-9]+$ ]] && [ "$age" -gt "$timeout_seconds" ]; then
        log "终止卡住的进程 $existing_pid (${age}s > ${timeout_hours}h)"
        kill -TERM "$existing_pid" 2>/dev/null || true
        sleep 5
        kill -KILL "$existing_pid" 2>/dev/null || true
        remove_stale_lock
        return 0
    fi

    log "已有任务运行中，PID: $existing_pid；本次来源=$RUN_SOURCE，模式=$RUN_MODE，账号模式=$RUN_ACCOUNT_MODE，拒绝启动。"
    return 1
}

acquire_lock() {
    local max_attempts=1
    local attempt=0
    local existing_pid

    while [ "$attempt" -lt "$max_attempts" ]; do
        self_heal_lockfile

        if (set -C; echo "$SCRIPT_PID" > "$LOCKFILE") 2>/dev/null; then
            write_lock_meta
            log "锁获取成功 (PID: $SCRIPT_PID, source=$RUN_SOURCE, mode=$RUN_MODE, accountMode=$RUN_ACCOUNT_MODE)"
            return 0
        fi

        existing_pid="$(read_lock_pid || true)"
        if [ -n "$existing_pid" ] && ! handle_existing_runner "$existing_pid"; then
            return 1
        fi

        attempt=$((attempt + 1))
    done

    return 1
}

check_orphan_runner() {
    local other_pid
    if other_pid="$(find_other_runner)"; then
        if ! handle_existing_runner "$other_pid"; then
            return 1
        fi
    fi
    return 0
}

terminate_child_group() {
    if [ -n "${CHILD_PID:-}" ] && is_alive "$CHILD_PID"; then
        log "正在终止子进程组 $CHILD_PID"
        kill -TERM "-$CHILD_PID" 2>/dev/null || kill -TERM "$CHILD_PID" 2>/dev/null || true
        sleep 5
        kill -KILL "-$CHILD_PID" 2>/dev/null || kill -KILL "$CHILD_PID" 2>/dev/null || true
    fi
}

release_lock() {
    local lock_pid=""
    if [ -f "$LOCKFILE" ]; then
        lock_pid="$(cat "$LOCKFILE" 2>/dev/null || true)"
    fi

    if [ "$lock_pid" = "$SCRIPT_PID" ]; then
        rm -f "$LOCKFILE" "$LOCK_META_FILE"
        log "锁已释放 (PID: $SCRIPT_PID)"
    fi
}

cleanup() {
    local exit_code=$?
    if [ "$exit_code" -ne 0 ]; then
        terminate_child_group
    fi
    release_lock
    exit "$exit_code"
}

trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

log "当前进程PID: $SCRIPT_PID | source=$RUN_SOURCE | mode=$RUN_MODE | accountMode=$RUN_ACCOUNT_MODE | accountIndex=${RUN_ACCOUNT_INDEX:-all}"

self_heal_lockfile

if ! check_orphan_runner; then
    [ "$RUN_FAIL_ON_LOCK" = "true" ] && exit 75
    exit 0
fi

if ! acquire_lock; then
    [ "$RUN_FAIL_ON_LOCK" = "true" ] && exit 75
    exit 0
fi

MINWAIT=${MIN_SLEEP_MINUTES:-5}
MAXWAIT=${MAX_SLEEP_MINUTES:-50}
MINWAIT_SEC=$((MINWAIT * 60))
MAXWAIT_SEC=$((MAXWAIT * 60))

if [ "${SKIP_RANDOM_SLEEP:-false}" != "true" ]; then
    if [ "$MAXWAIT_SEC" -le "$MINWAIT_SEC" ]; then
        SLEEPTIME="$MINWAIT_SEC"
    else
        SLEEPTIME=$((MINWAIT_SEC + RANDOM % (MAXWAIT_SEC - MINWAIT_SEC)))
    fi
    log "休眠 $((SLEEPTIME / 60)) 分钟 ($SLEEPTIME 秒)"
    sleep "$SLEEPTIME"
else
    log "跳过随机休眠"
fi

log "开始脚本..."
mkdir -p "$(dirname "$RUNTIME_LOG_FILE")"

set +e
setsid bash -lc 'npm start' > >(tee -a "$RUNTIME_LOG_FILE") 2>&1 &
CHILD_PID=$!
wait "$CHILD_PID"
RESULT=$?
set -e
CHILD_PID=""

if [ "$RESULT" -eq 0 ]; then
    log "脚本成功完成。"
else
    log "错误: 脚本失败！退出码: $RESULT" >&2
    exit "$RESULT"
fi

log "脚本完成"
