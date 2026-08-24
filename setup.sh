#!/usr/bin/env bash

echo "========================================"
echo "Antigravity2API 一键克隆、部署与 PM2 守护脚本"
echo "========================================"
echo

# 1. 配置仓库与程序运行主路径
REPO_URL="https://github.com/gymcnc64/antigravity2api-nodejs.git"
BRANCH="custom/http-port-8045"
TARGET_DIR="antigravity2api-nodejs"
APP_NAME="antigravity2api"

# 2. 自动检测与安装系统基础依赖 (curl, git)
echo "[1/7] 检查系统基础依赖 (curl, git)..."
if ! command -v curl &> /dev/null || ! command -v git &> /dev/null; then
    echo "正在安装基础系统依赖..."
    if command -v apt-get &> /dev/null; then
        sudo apt-get update -y && sudo apt-get install -y curl git
    elif command -v yum &> /dev/null; then
        sudo yum install -y curl git
    elif command -v dnf &> /dev/null; then
        sudo dnf install -y curl git
    elif command -v apk &> /dev/null; then
        sudo apk add curl git
    fi
fi

# 3. 自动克隆或进入确切的项目目录
echo
echo "[2/7] 获取项目代码与定位工作目录..."
if [ -f "package.json" ] && grep -q "antigravity" package.json 2>/dev/null; then
    echo "✓ 当前目录已被识别为 Antigravity 项目目录: $(pwd)"
elif [ -d "$TARGET_DIR" ]; then
    echo "发现已存在固定目录 ${TARGET_DIR}，进入该目录..."
    cd "$TARGET_DIR" || exit 1
else
    echo "正在克隆分支 [${BRANCH}] 代码到固定目录 ./${TARGET_DIR}..."
    git clone -b "$BRANCH" "$REPO_URL" "$TARGET_DIR"
    if [ $? -ne 0 ]; then
        echo "❌ 项目克隆失败，请检查网络或 Git 配置"
        exit 1
    fi
    cd "$TARGET_DIR" || exit 1
fi

# 动态获取当前绝对路径，确保 PM2 始终绑定该绝对路径
PROJECT_ABS_PATH="$(pwd)"
echo "✓ 确立程序绝对工作目录: ${PROJECT_ABS_PATH}"

# 自动为指纹二进制分配执行权限
if [ -d "src/bin" ]; then
    chmod +x src/bin/fingerprint_* 2>/dev/null || true
fi

# 4. 自动检测与安装 Node.js (如缺失，自动安装 Node.js LTS)
echo
echo "[3/7] 检查 Node.js 环境..."
if ! command -v node &> /dev/null; then
    echo "⚠️ 未检测到 Node.js，正在自动为您安装 Node.js LTS (v20)..."
    if command -v apt-get &> /dev/null; then
        curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
        sudo apt-get install -y nodejs
    elif command -v yum &> /dev/null || command -v dnf &> /dev/null; then
        curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
        sudo yum install -y nodejs 2>/dev/null || sudo dnf install -y nodejs
    else
        echo "❌ 无法自动安装 Node.js，请手动安装 Node.js v18+ 后重试。"
        exit 1
    fi
fi

NODE_VER=$(node -v)
echo "✓ Node.js 环境正常: ${NODE_VER}"

# 5. 安装 Node.js 项目依赖
echo
echo "[4/7] 安装项目 NPM 依赖..."
npm install
if [ $? -ne 0 ]; then
    echo "❌ NPM 依赖安装失败，请检查网络或源配置。"
    exit 1
fi

# 6. 配置管理员信息与凭据
echo
echo "[5/8] 配置管理员信息与凭据..."

SERVER_PUBLIC_IP=$(curl -s --connect-timeout 3 https://api.ipify.org || curl -s --connect-timeout 3 https://ifconfig.me || curl -s --connect-timeout 3 https://ipinfo.io/ip || echo "")

if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
    else
        touch .env
    fi
fi
read -p "请输入管理员用户名 (默认: admin): " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-admin}

read -p "请输入管理员密码 (默认: admin123): " ADMIN_PASS
ADMIN_PASS=${ADMIN_PASS:-admin123}

# 生成随机 API Key
DEFAULT_GEN_KEY="sk-$(head /dev/urandom | tr -dc a-z0-9 | head -c 24 2>/dev/null || echo "key_$(date +%s)")"
read -p "请输入初始 API 密钥 (按回车自动生成随机 Key): " API_KEY_INPUT
FINAL_API_KEY=${API_KEY_INPUT:-$DEFAULT_GEN_KEY}

# 生成随机 JWT 密钥
RANDOM_JWT_SECRET=$(head /dev/urandom | tr -dc A-Za-z0-9 | head -c 32 2>/dev/null || echo "secret_$(date +%s)")

if grep -q "^# ADMIN_USERNAME=" .env 2>/dev/null || grep -q "^ADMIN_USERNAME=" .env 2>/dev/null; then
    sed -i.bak "s/^#\? ADMIN_USERNAME=.*/ADMIN_USERNAME=$ADMIN_USER/" .env
    sed -i.bak "s/^#\? ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$ADMIN_PASS/" .env
    sed -i.bak "s/^#\? API_KEY=.*/API_KEY=$FINAL_API_KEY/" .env
    sed -i.bak "s/^#\? JWT_SECRET=.*/JWT_SECRET=$RANDOM_JWT_SECRET/" .env
    rm -f .env.bak
else
    echo "ADMIN_USERNAME=$ADMIN_USER" >> .env
    echo "ADMIN_PASSWORD=$ADMIN_PASS" >> .env
    echo "API_KEY=$FINAL_API_KEY" >> .env
    echo "JWT_SECRET=$RANDOM_JWT_SECRET" >> .env
fi

# 7. Cloudflare WARP 一键集成与自动配置（可选）
echo
echo "[6/8] 检查 Cloudflare WARP 代理与 Google 地区解锁..."
INSTALL_WARP_CHOICE="n"
if command -v warp-cli &> /dev/null; then
    echo "✓ 检测到系统已安装 Cloudflare WARP 客户端"
    # 清理历史遗留的干扰定时器
    sudo systemctl stop warp-google-update.timer warp-google-update.service 2>/dev/null || true
    sudo systemctl disable warp-google-update.timer warp-google-update.service 2>/dev/null || true

    # 确保设置纯净 SOCKS5 代理模式与端口 40000，并切换抗抖动能力最强的 wireguard 协议
    warp-cli --accept-tos mode proxy 2>/dev/null || warp-cli mode proxy 2>/dev/null || true
    warp-cli --accept-tos proxy port 40000 2>/dev/null || warp-cli proxy port 40000 2>/dev/null || true
    warp-cli --accept-tos tunnel protocol set wireguard 2>/dev/null || warp-cli tunnel protocol set wireguard 2>/dev/null || warp-cli set-protocol wireguard 2>/dev/null || true
    warp-cli --accept-tos set-log-level warn 2>/dev/null || warp-cli set-log-level warn 2>/dev/null || true
    warp-cli --accept-tos connect 2>/dev/null || warp-cli connect 2>/dev/null || true
    
    # 自动在 .env 中设置 PROXY
    if ! grep -q "^PROXY=" .env 2>/dev/null || grep -q "^PROXY=$" .env 2>/dev/null; then
        echo "✓ 自动配置 PROXY=socks5://127.0.0.1:40000 到 .env"
        sed -i.bak 's|^#\? PROXY=.*|PROXY=socks5://127.0.0.1:40000|' .env 2>/dev/null || echo "PROXY=socks5://127.0.0.1:40000" >> .env
        rm -f .env.bak
    fi
else
    echo "💡 Cloudflare WARP 可用于解锁 Google 地区限制（提供纯净 SOCKS5 代理 127.0.0.1:40000，配备 200MB 内存防溢出保护）。"
    read -p "是否需要自动安装并配置 Cloudflare WARP？(y/N, 默认 N): " INSTALL_WARP_CHOICE
    if [[ "$INSTALL_WARP_CHOICE" =~ ^[Yy]$ ]]; then
        echo "正在安装 Cloudflare WARP 客户端..."
        if command -v apt-get &> /dev/null; then
            curl -fsSL https://pkg.cloudflareclient.com/pubkey.gpg | sudo gpg --yes --dearmor --output /usr/share/keyrings/cloudflare-warp-archive-keyring.gpg 2>/dev/null || true
            echo "deb [signed-by=/usr/share/keyrings/cloudflare-warp-archive-keyring.gpg] https://pkg.cloudflareclient.com/ $(lsb_release -cs 2>/dev/null || echo 'bookworm') main" | sudo tee /etc/apt/sources.list.d/cloudflare-client.list > /dev/null
            sudo apt-get update -y && sudo apt-get install -y cloudflare-warp
        elif command -v yum &> /dev/null || command -v dnf &> /dev/null; then
            sudo rpm -ivh http://pkg.cloudflareclient.com/cloudflare-release-el8.rpm 2>/dev/null || sudo rpm -ivh http://pkg.cloudflareclient.com/cloudflare-release-el9.rpm 2>/dev/null || true
            sudo yum install -y cloudflare-warp 2>/dev/null || sudo dnf install -y cloudflare-warp
        fi

        # 配置 systemd 内存保护
        if [ -d "/etc/systemd/system" ]; then
            sudo mkdir -p /etc/systemd/system/warp-svc.service.d
            cat << 'EOF_WARP_CONF' | sudo tee /etc/systemd/system/warp-svc.service.d/override.conf > /dev/null
[Service]
MemoryMax=200M
MemoryHigh=150M
Restart=always
RestartSec=5s
EOF_WARP_CONF
            sudo systemctl daemon-reload 2>/dev/null || true
            sudo systemctl enable --now warp-svc 2>/dev/null || true
        fi

        # 注册与连接
        sleep 2
        warp-cli --accept-tos registration new 2>/dev/null || warp-cli register 2>/dev/null || true
        warp-cli --accept-tos mode proxy 2>/dev/null || warp-cli mode proxy 2>/dev/null || true
        warp-cli --accept-tos proxy port 40000 2>/dev/null || warp-cli proxy port 40000 2>/dev/null || true
        warp-cli --accept-tos set-log-level warn 2>/dev/null || warp-cli set-log-level warn 2>/dev/null || true
        warp-cli --accept-tos connect 2>/dev/null || warp-cli connect 2>/dev/null || true

        echo "✓ WARP 安装完成并配置为纯净 SOCKS5 代理 (127.0.0.1:40000)"
        sed -i.bak 's|^#\? PROXY=.*|PROXY=socks5://127.0.0.1:40000|' .env 2>/dev/null || echo "PROXY=socks5://127.0.0.1:40000" >> .env
        rm -f .env.bak
    fi
fi

# 8. 检测并自动全局安装 PM2
echo
echo "[7/8] 检查并安装 PM2 进程管理器..."
if ! command -v pm2 &> /dev/null; then
    echo "正在全局安装 PM2..."
    npm install -g pm2
    if [ $? -ne 0 ]; then
        echo "⚠️ PM2 全局安装失败，尝试以 sudo 权限安装..."
        sudo npm install -g pm2
    fi
else
    echo "✓ PM2 已安装"
fi

# 9. 加入 PM2 服务与开机自启动
echo
echo "[8/8] 启动 PM2 进程守护并配置自启动..."
# 清理死进程，确保以固定的绝对路径启动
pm2 delete "$APP_NAME" > /dev/null 2>&1 || true

echo "新建 PM2 服务实例 [工作路径: ${PROJECT_ABS_PATH}]..."
pm2 start "${PROJECT_ABS_PATH}/src/server/index.js" --name "$APP_NAME" --cwd "${PROJECT_ABS_PATH}" --node-args="--expose-gc"

pm2 save
pm2 startup 2>/dev/null || echo "💡 提示: 请复制下方系统提示的命令以完成开机自启安装"

# 构建 HTTP 访问地址 (默认 8045 端口)
PORT=8045
if [ -n "$SERVER_PUBLIC_IP" ]; then
    PUBLIC_URL="http://${SERVER_PUBLIC_IP}:${PORT}"
else
    PUBLIC_URL="http://您的服务器IP:${PORT}"
fi

echo
echo "=========================================================="
echo "🎉 Antigravity2API 部署成功并已提交 PM2 守护运行！"
echo "=========================================================="
echo
echo "📂 项目安装路径："
echo "   - 绝对路径: ${PROJECT_ABS_PATH}"
echo
echo "🌐 服务访问信息 (HTTP 8045 端口)："
echo "   - 公网管理后台: ${PUBLIC_URL}"
echo "   - 本地管理后台: http://127.0.0.1:${PORT}"
echo "   - API 基础地址: http://127.0.0.1:${PORT}/v1"
echo "   - 管理员账号:   $ADMIN_USER"
echo "   - 管理员密码:   $ADMIN_PASS"
echo "   - 初始 API 密钥: $FINAL_API_KEY"
echo
echo "🛠️ 常用 PM2 命令说明（非常重要）："
echo "   ┌───────────────────────────────────────────┐"
echo "   │ 查看服务运行状态:   pm2 status            │"
echo "   │ 查看实时日志:       pm2 logs ${APP_NAME} │"
echo "   │ 重启 API 服务:      pm2 restart ${APP_NAME}│"
echo "   │ 停止 API 服务:      pm2 stop ${APP_NAME}   │"
echo "   │ 保存当前进程状态:   pm2 save              │"
echo "   └───────────────────────────────────────────┘"
echo "=========================================================="
