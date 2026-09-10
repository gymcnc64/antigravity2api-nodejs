#!/bin/bash
# ============================================================
# 出口风控自愈看门狗 (exit-watchdog)
#
# 背景：Google 会周期性对出口 IP 触发"坏窗口"风控，
#       返回 400 FAILED_PRECONDITION "User location is not supported"。
#       两台服务器互为主备出口（交叉 SSH SOCKS5 隧道）。
#
# 逻辑：定期检查应用日志窗口内的信号：
#   1. 地区风控错误（geo）且无成功请求 → 切换到另一出口
#   2. 隧道断连错误且无成功请求 → 切回直连
# 冷却与频率限制防止抖动。
# ============================================================
set -uo pipefail

APP_DIR="/root/antigravity2api-nodejs"
ENV_FILE="$APP_DIR/.env"
APP_LOG="$APP_DIR/data/logs/app.log"
STATE_DIR="/var/lib/exit-watchdog"
WLOG="$STATE_DIR/watchdog.log"
STATE_FILE="$STATE_DIR/state"
TUNNEL_URL="socks5://127.0.0.1:40000"
TUNNEL_SVC="socks-tunnel.service"
WINDOW_MIN=8              # 日志检测窗口（分钟）
COOLDOWN_SEC=900          # 切换冷却（秒）
MAX_SWITCHES_PER_HOUR=2   # 一小时内最多切换次数

mkdir -p "$STATE_DIR"
log() { echo "[$(date '+%F %T')] $*" >> "$WLOG"; }

# ---- 状态读取 ----
get_mode() {
    if grep -qE "^PROXY=${TUNNEL_URL}" "$ENV_FILE"; then echo tunnel; else echo direct; fi
}

# ---- 日志信号统计 ----
since_iso() { date -u -d "-${WINDOW_MIN} minutes" '+%Y-%m-%dT%H:%M:%S'; }

count_geo_errors() {
    local since; since=$(since_iso)
    grep -h "所在地区不受支持" "$APP_LOG" 2>/dev/null | awk -v s="$since" 'substr($0,1,19) > s' | wc -l
}

count_tunnel_errors() {
    local since; since=$(since_iso)
    grep -hE "ECONNREFUSED 127.0.0.1:40000|socks connect|连接被拒绝" "$APP_LOG" 2>/dev/null | awk -v s="$since" 'substr($0,1,19) > s' | wc -l
}

count_success() {
    local since; since=$(since_iso)
    grep -h "chat/completions 200" "$APP_LOG" 2>/dev/null | awk -v s="$since" 'substr($0,1,19) > s' | wc -l
}

count_any_requests() {
    local since; since=$(since_iso)
    grep -h "chat/completions" "$APP_LOG" 2>/dev/null | awk -v s="$since" 'substr($0,1,19) > s' | wc -l
}

# ---- 隧道服务是否已部署 ----
tunnel_deployed() {
    systemctl cat "$TUNNEL_SVC" >/dev/null 2>&1
}

# ---- 出口切换（保证幂等，缺失行自动追加）----
apply_mode() {
    local mode="$1"
    if [ "$mode" = tunnel ] && ! tunnel_deployed; then
        log "未部署 $TUNNEL_SVC，无法切换到隧道出口"
        return 1
    fi
    # 先移除所有激活的 PROXY 行
    sed -i -E "s|^PROXY=.*|#&|" "$ENV_FILE" 2>/dev/null || true
    # 清理双重注释
    sed -i -E "s|^#+# *PROXY=|# PROXY=|" "$ENV_FILE" 2>/dev/null || true

    if [ "$mode" = tunnel ]; then
        if grep -qE "^# *PROXY=${TUNNEL_URL}" "$ENV_FILE"; then
            sed -i -E "s|^# *PROXY=${TUNNEL_URL}.*|PROXY=${TUNNEL_URL}|" "$ENV_FILE"
        else
            printf 'PROXY=%s\n' "$TUNNEL_URL" >> "$ENV_FILE"
        fi
        systemctl start "$TUNNEL_SVC" >/dev/null 2>&1 || true
    fi
    ( cd "$APP_DIR" && pm2 restart antigravity2api --update-env >/dev/null 2>&1 )
}

# ---- 探测（切换后验证）----
probe() {
    local key resp
    key=$(grep -E '^API_KEY=' "$ENV_FILE" | head -n1 | cut -d= -f2-)
    [ -z "$key" ] && { echo skip; return; }
    resp=$(curl -s -m 60 -X POST http://127.0.0.1:8045/v1/chat/completions \
        -H 'Content-Type: application/json' \
        -H "Authorization: Bearer $key" \
        -d '{"model":"gemini-3.7-flash-low","messages":[{"role":"user","content":"hi"}],"stream":false}' 2>/dev/null | head -c 600)
    if echo "$resp" | grep -q '"choices"'; then echo ok
    elif echo "$resp" | grep -q "所在地区不受支持\|User location is not supported"; then echo geo
    else echo other; fi
}

# ============================ 主流程 ============================
mode=$(get_mode)
geo=$(count_geo_errors)
terr=$(count_tunnel_errors)
ok=$(count_success)
total=$(count_any_requests)

IFS='|' read -r last_switch switch_count count_started < "$STATE_FILE" 2>/dev/null || { last_switch=0; switch_count=0; count_started=0; }
now=$(date +%s)

# 每小时重置切换计数
if [ $((now - count_started)) -ge 3600 ]; then
    switch_count=0; count_started=$now
fi

log "mode=$mode geo=$geo tunnel_err=$terr ok=$ok total=$total"

# 决策：确定是否需要切换
target=""
reason=""
if [ "$total" -eq 0 ]; then
    log "窗口内无请求，跳过"
    echo "${last_switch}|${switch_count}|${count_started}" > "$STATE_FILE"
    exit 0
fi

if [ "$geo" -gt 0 ] && [ "$ok" -eq 0 ]; then
    if [ "$mode" = direct ]; then target=tunnel; reason="直连出口被地区风控（geo=$geo ok=0）"
    else target=direct; reason="隧道出口也被地区风控（geo=$geo ok=0）"; fi
elif [ "$terr" -gt 0 ] && [ "$ok" -eq 0 ] && [ "$mode" = tunnel ]; then
    target=direct; reason="隧道断连（tunnel_err=$terr）"
elif [ "$geo" -gt 0 ] && [ "$ok" -gt 0 ]; then
    log "部分请求地区受限（geo=$geo ok=$ok），暂不切换"
fi

if [ -z "$target" ]; then
    echo "${last_switch}|${switch_count}|${count_started}" > "$STATE_FILE"
    exit 0
fi

if [ $((now - last_switch)) -lt "$COOLDOWN_SEC" ]; then
    log "switch -> $target 跳过（冷却中，距上次 $((now - last_switch))s）: $reason"
    echo "${last_switch}|${switch_count}|${count_started}" > "$STATE_FILE"
    exit 0
fi

if [ "$switch_count" -ge "$MAX_SWITCHES_PER_HOUR" ]; then
    log "switch -> $target 跳过（已达每小时上限 $MAX_SWITCHES_PER_HOUR 次）: $reason"
    echo "${last_switch}|${switch_count}|${count_started}" > "$STATE_FILE"
    exit 0
fi

# 执行切换
orig_mode="$mode"
if ! apply_mode "$target"; then
    log "切换 $target 失败（前置条件不满足），保持当前出口"
    echo "${last_switch}|${switch_count}|${count_started}" > "$STATE_FILE"
    exit 0
fi
log "switch -> $target: $reason"
sleep 12
p=$(probe)
log "switch -> $target 完成，探测: $p"
last_switch=$now; switch_count=$((switch_count + 1))

# 切换后探测失败 → 立即回退到原出口
if [ "$p" != "ok" ]; then
    log "切换后探测异常（$p），回退到 $orig_mode"
    apply_mode "$orig_mode"
    sleep 12
    p2=$(probe)
    log "回退完成，探测: $p2"
    switch_count=$((switch_count + 1))
fi

echo "${last_switch}|${switch_count}|${count_started}" > "$STATE_FILE"
exit 0
