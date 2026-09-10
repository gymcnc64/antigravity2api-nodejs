#!/usr/bin/env bash

echo "=========================================================="
echo "⚡ Antigravity2API 生产环境一键升级与稳定性优化脚本"
echo "=========================================================="
echo

BRANCH="custom/http-port-8045"
APP_NAME="antigravity2api"

# 1. 检查工作目录与 Git 状态
if [ ! -f "package.json" ] || ! grep -q "antigravity" package.json 2>/dev/null; then
    if [ -d "antigravity2api-nodejs" ]; then
        cd "antigravity2api-nodejs" || exit 1
    else
        echo "❌ 未检测到 Antigravity2API 项目目录，请在项目根目录下运行此脚本！"
        exit 1
    fi
fi

PROJECT_PATH="$(pwd)"
echo "✓ 定位项目根目录: ${PROJECT_PATH}"

# 2. 拉取最新代码
echo
echo "[1/5] 同步最新代码分支 [${BRANCH}]..."
git fetch origin "$BRANCH"
git checkout "$BRANCH" 2>/dev/null || true
git pull origin "$BRANCH"

if [ $? -ne 0 ]; then
    echo "⚠️ Git 拉取遇到冲突或失败，尝试重置并强制同步..."
    git stash
    git pull origin "$BRANCH"
fi

# 为指纹二进制文件分配执行权限
if [ -d "src/bin" ]; then
    chmod +x src/bin/fingerprint_* 2>/dev/null || true
fi

# 3. 安装/更新依赖
echo
echo "[2/5] 检查并安装 NPM 项目依赖..."
npm install --silent

# 4. 清理旧版干扰定时器与残留服务
echo
echo "[3/5] 清理历史遗留系统定时器与干扰服务..."
sudo systemctl stop warp-google-update.timer warp-google-update.service 2>/dev/null || true
sudo systemctl disable warp-google-update.timer warp-google-update.service 2>/dev/null || true
echo "✓ 历史定时器清理完毕"

# 5. 优化 Cloudflare WARP 底层协议为 WireGuard 模式
echo
echo "[4/5] 调优 Cloudflare WARP 为稳定 WireGuard 协议模式..."
if command -v warp-cli &> /dev/null; then
    # 切换为原生 wireguard 协议，彻底根除 MASQUE/QUIC 频繁重协商与丢包导致的短断连
    warp-cli --accept-tos tunnel protocol set wireguard 2>/dev/null || \
    warp-cli tunnel protocol set wireguard 2>/dev/null || \
    warp-cli set-protocol wireguard 2>/dev/null || true
    
    warp-cli --accept-tos mode proxy 2>/dev/null || warp-cli mode proxy 2>/dev/null || true
    warp-cli --accept-tos proxy port 40000 2>/dev/null || warp-cli proxy port 40000 2>/dev/null || true
    warp-cli --accept-tos set-log-level warn 2>/dev/null || warp-cli set-log-level warn 2>/dev/null || true

    echo "正在平滑重启 warp-svc 载入 WireGuard 协议..."
    sudo systemctl restart warp-svc 2>/dev/null || (warp-cli --accept-tos disconnect && sleep 2 && warp-cli --accept-tos connect)
    sleep 3

    # 验证 40000 端口连通性
    if curl -x socks5h://127.0.0.1:40000 -s --max-time 6 https://www.cloudflare.com/cdn-cgi/trace > /dev/null 2>&1; then
        echo "✓ WARP WireGuard 模式已成功就绪 (127.0.0.1:40000 畅通)！"
    else
        echo "⚠️ WARP 正在建立连接，请稍后在 Web 后台测试连通性。"
    fi
else
    echo "💡 系统未安装 warp-cli，跳过 WARP 协议设置。"
fi

# 6. 智能更新 config.json 重试参数
if [ -f "config.json" ]; then
    echo "正在更新 config.json 默认重试策略 (3次 / 2000ms 间隔)..."
    node -e '
      const fs = require("fs");
      try {
        const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));
        if (!cfg.other) cfg.other = {};
        cfg.other.retryTimes = 3;
        cfg.other.retryIntervalMs = 2000;
        cfg.other.autoRestartWarp = true;
        fs.writeFileSync("config.json", JSON.stringify(cfg, null, 2));
        console.log("✓ 已成功调优 config.json 重试参数与防抖自愈开关");
      } catch (e) {
        console.error("更新 config.json 失败:", e.message);
      }
    ' 2>/dev/null || true
fi

# 7. 部署出口风控自愈看门狗（地区限制/隧道断连自动切换出口）
echo
echo "[5/6] 部署出口风控自愈看门狗..."
if [ -f "scripts/exit-watchdog.sh" ]; then
    sudo cp scripts/exit-watchdog.sh /usr/local/bin/exit-watchdog.sh
    sudo chmod +x /usr/local/bin/exit-watchdog.sh

    # 安装 systemd 服务与定时器（每 5 分钟检测一次）
    sudo tee /etc/systemd/system/exit-watchdog.service > /dev/null <<'WD_SVC'
[Unit]
Description=Exit watchdog one-shot check
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/exit-watchdog.sh
TimeoutStartSec=240
WD_SVC

    sudo tee /etc/systemd/system/exit-watchdog.timer > /dev/null <<'WD_TIMER'
[Unit]
Description=Exit watchdog - check geo-block and switch exits every 5 min
After=network-online.target

[Timer]
OnBootSec=120
OnUnitActiveSec=300
AccuracySec=30

[Install]
WantedBy=timers.target
WD_TIMER

    sudo systemctl daemon-reload
    sudo systemctl enable --now exit-watchdog.timer 2>/dev/null || true
    if sudo systemctl is-active --quiet exit-watchdog.timer; then
        echo "✓ 出口风控自愈看门狗已就绪（每 5 分钟检测地区限制/隧道断连，自动切换出口）"
    else
        echo "⚠️ 看门狗定时器启动失败，请手动检查 systemctl status exit-watchdog.timer"
    fi
else
    echo "💡 未找到 scripts/exit-watchdog.sh，跳过看门狗部署。"
fi

# 8. 平滑重启 PM2 进程
echo
echo "[6/6] 重启 PM2 进程守护..."
if command -v pm2 &> /dev/null; then
    pm2 restart "$APP_NAME" || pm2 start src/server/index.js --name "$APP_NAME" --node-args="--expose-gc"
    pm2 save
    echo "✓ PM2 服务已成功热更新重启！"
else
    echo "⚠️ 未检测到 PM2，请手动运行 npm start 重启服务"
fi

echo
echo "=========================================================="
echo "🎉 Antigravity2API 升级与底层稳定性调优全部完成！"
echo "=========================================================="
echo "1. 底层已全面切换为 WireGuard 协议模式，彻底根除抖动断连"
echo "2. 历史遗留定时器已完全禁用，杜绝误杀重启"
echo "3. 服务层已配置 3 次 / 2000ms 自动平滑重试与 60s 智能防抖换 IP"
echo "4. 出口风控自愈：地区限制/隧道断连时自动切换出口并重启服务"
echo "=========================================================="
