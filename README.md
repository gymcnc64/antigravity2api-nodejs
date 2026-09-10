# Antigravity to OpenAI API 代理服务 (HTTP 8045 定制版)

将 Google Antigravity API 与 Gemini CLI 转换为 OpenAI / Gemini / Claude 兼容格式的轻量化高性能代理服务，支持流式响应、工具调用、多账号池轮询、SOCKS5 代理池调度与 shadcn/ui 现代管理面板。

本项目已深度定制与优化：**移除 HTTPS/SSL 域名证书签发与 DNS 校验开销，采用纯净轻量 HTTP 协议直接监听 8045 端口**，支持通过标准 HTTP 直接访问或搭配 Nginx / 反向代理灵活使用。

---

## ✨ 核心特性

| 特性 | 说明 |
| :--- | :--- |
| 🎨 **shadcn/ui 现代视觉设计** | 基于 Zinc 纯净中性色体系重构，精致胶囊 Tabs 导航、卡片微边框与表单聚焦环，完美适配 Light & Dark 模式 |
| 🌐 **多节点 SOCKS5 代理池** | 支持静态多节点列表（`PROXY_LIST`），内置 Round-Robin 轮询、Random 随机与 Failover 主备故障转移策略 |
| 🔄 **第三方 API 动态代理拉取** | 支持配置第三方代理提取 API（`PROXY_API_URL`），后台定时自动拉取并自适应解析纯文本或 JSON 格式 |
| 🛡️ **连续故障熔断与自愈机制** | 节点连续失败达到阈值自动进入冷却熔断状态，并无缝切换至下一健康节点；成功请求后自动恢复健康度 |
| ⚡ **Google 400 地区受限自愈** | 上游返回 400 地区限制（`FAILED_PRECONDITION`）或网络中断时，在重试中自动轮换健康代理节点重试 |
| ⚡ **原生轻量 HTTP 监听** | 默认直接监听 **8045 端口**，去除 SSL 上下文开销，极速启动与响应 |
| 🛠️ **一键 SOCKS5 服务端编译安装** | `setup.sh`（步骤 8/10）支持可选一键编译安装开源轻量 `microsocks` SOCKS5 服务端并配置守护自启 |
| 🔄 **多账号池管理与 Token 轮询** | 支持多 Google OAuth 账号池管理、Round-Robin 轮换、按请求数/额度耗尽切号与自动刷新 Token |
| 🔑 **2FA 双因素身份验证** | 支持使用 Google Authenticator 等动态口令 App 绑定 2FA，提供 10 个一次性备用恢复码防丢防护 |
| 🎛️ **CLI 功能开关控制** | 可在设置中开启或关闭 Gemini CLI (`/cli/*`) API 反代功能，关闭后自动隐藏 CLI 页面标签 |
| 🎯 **API 密钥 Token 消耗上限** | 支持为单个 API Key 设置最大 Token 消耗限制（如设置 1 亿 Token 阈值），用完后自动禁用防止超量使用 |
| 🔑 **多 API 密钥管理** | 支持创建、编辑、开启/禁用、删除多个 API Key，且每个 Key 独立记录请求数与 Token 使用明细 |
| 📊 **Token 消费统计** | 提供基于 API Key 维度的 Input / Output / Total Token 使用量实时仪表盘统计与百分比显示 |
| 🌐 **请求来源与明细日志** | 实时日志面板清晰标注客户端来源 IP，并高亮单次 API 请求消耗的 Token 数量 |
| 📦 **配置导入导出与全防护** | 支持全量配置与 Token 一键导入/导出；自动屏蔽敏感文件，防止推送 Git 泄露凭据 |
| ⚡ **一键自动化安装部署** | 脚本（`setup.sh` / `setup.bat`）支持 Node.js、PM2、基础依赖全自动检测安装与开机自启守护 |
| 🔐 **登录安全审计与 IP 封禁** | 实时记录管理员登录与退出日志（带来源 IP 与账号），支持自动 IP 封禁与白名单机制 |
| ✅ **全格式 API 兼容** | 完整兼容 OpenAI、Gemini v1beta 与 Claude 格式 API，支持 SSE 流式响应、结构化输出与 Function Calling |
| ✅ **思维链 (Thinking) 输出** | 兼容 OpenAI `reasoning_effort` 参数和 DeepSeek `reasoning_content` 格式 |
| ✅ **图片生成与多模态** | 支持 Base64 图片输入与 `gemini-3-pro-image` 图片生成（SD WebUI API 兼容） |

---

## 📋 环境要求

- **Node.js**: >= 18.0.0
- **操作系统**: Linux / macOS / Windows

---

## 🚀 快速开始

### 方式一：一键部署脚本（推荐）

#### Linux / macOS

使用 `curl`：
```bash
curl -O https://raw.githubusercontent.com/gymcnc64/antigravity2api-nodejs/feature/socks5-pool-and-api-fetch/setup.sh && chmod +x setup.sh && ./setup.sh
```

或使用 `wget`：
```bash
wget https://raw.githubusercontent.com/gymcnc64/antigravity2api-nodejs/feature/socks5-pool-and-api-fetch/setup.sh && chmod +x setup.sh && ./setup.sh
```

#### 🔄 生产环境一键平滑升级与调优脚本

如已部署运行，只需一行命令即可自动同步最新代码、清理旧定时器并平滑重启 PM2：

```bash
curl -fsSL https://raw.githubusercontent.com/gymcnc64/antigravity2api-nodejs/feature/socks5-pool-and-api-fetch/upgrade.sh | bash
```

或者在已克隆的目录内执行：
```bash
chmod +x upgrade.sh && ./upgrade.sh
```

#### Windows

**CMD**:
```cmd
curl -O https://raw.githubusercontent.com/gymcnc64/antigravity2api-nodejs/feature/socks5-pool-and-api-fetch/setup.bat && setup.bat
```

**PowerShell**:
```powershell
irm https://raw.githubusercontent.com/gymcnc64/antigravity2api-nodejs/feature/socks5-pool-and-api-fetch/setup.bat -OutFile setup.bat; .\setup.bat
```

> **自动化脚本包含步骤**：
> 1. 检测并自动安装 git, curl, Node.js, PM2 等运行依赖
> 2. 克隆项目仓库并在当前目录准备运行环境
> 3. 安装 NPM 项目依赖包
> 4. 交互式配置管理员账号密码与 API Key（回车可自动生成随机强密钥）
> 5. 可选一键编译安装本地 `microsocks` SOCKS5 代理服务端
> 6. 自动启动 PM2 守护进程并注册开机自启（默认监听 HTTP 8045 端口）

---

### 方式二：手动部署

#### 1. 克隆项目与安装依赖

```bash
git clone -b feature/socks5-pool-and-api-fetch https://github.com/gymcnc64/antigravity2api-nodejs.git
cd antigravity2api-nodejs
npm install
```

#### 2. 配置环境变量与参数

首次启动时，如果 `.env` 和 `config.json` 不存在，系统会自动创建默认配置文件。也可以手动复制示例文件：

```bash
cp .env.example .env
cp config.json.example config.json
```

编辑 `.env` 文件配置必要参数：

```env
# 基础凭据配置（留空则启动时自动生成随机凭据）
API_KEY=sk-your-custom-api-key
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
JWT_SECRET=your-jwt-secret-key-change-this-in-production

# 单代理配置（向后兼容）
# PROXY=socks5://127.0.0.1:40000

# 多节点 SOCKS5 代理池配置（支持逗号或换行分隔多个节点，自动轮询与熔断）
PROXY_LIST=socks5://127.0.0.1:40000,socks5://127.0.0.1:40001,socks5://user:pass@1.2.3.4:1080

# 代理池调度策略：round_robin (轮询) | random (随机) | failover (主备故障转移)
PROXY_STRATEGY=round_robin

# 第三方代理提取 API（定时自动拉取更新代理池，支持纯文本或 JSON 返回）
# PROXY_API_URL=https://api.example.com/get_proxies?type=socks5
# PROXY_API_INTERVAL_MS=300000

# 故障熔断与冷却参数
PROXY_MAX_FAILURES=3
PROXY_COOLDOWN_MS=300000
```

`config.json` 默认监听端口已设定为 `8045`：
```json
{
  "server": {
    "port": 8045,
    "host": "0.0.0.0",
    "maxRequestSize": "500mb",
    "heartbeatInterval": 15000,
    "memoryThreshold": 50
  }
}
```

#### 3. 登录并绑定账号

```bash
npm run login
```

浏览器会自动打开 Google 授权页面，授权后 Token 会自动保存至 `data/accounts.json`。

#### 4. 启动服务

**直接运行**：
```bash
npm start
```

**后台 PM2 守护运行**：
```bash
pm2 start src/server/index.js --name "antigravity2api"
```

服务将在 `http://<您的服务器IP>:8045` 启动运行。

---

## 🔌 API 接口与使用端点

服务启动后，可以通过以下端点进行调用：

| 接口类型 | 请求端点 | 兼容格式 / 说明 |
| :--- | :--- | :--- |
| **后台 Web 管理面板** | `http://<IP>:8045` | 基于 shadcn/ui 的现代化管理后台（账号、代理池、设置、日志） |
| **代理池状态接口** | `http://<IP>:8045/admin/proxy-pool` | 获取当前代理池节点健康度、活跃节点及调度统计 |
| **Antigravity - OpenAI** | `http://<IP>:8045/v1` | 兼容 OpenAI `/v1/chat/completions`, `/v1/models` |
| **Antigravity - Gemini** | `http://<IP>:8045/v1beta` | 兼容 Google Gemini 原生 SDK 接口格式 |
| **Antigravity - Claude** | `http://<IP>:8045/v1` | 兼容 Anthropic Claude 格式调用 |
| **Gemini CLI - OpenAI** | `http://<IP>:8045/cli/v1` | Gemini CLI 模式 OpenAI 格式接口 |
| **Gemini CLI - Gemini** | `http://<IP>:8045/cli/v1beta` | Gemini CLI 模式原生 SDK 接口 |

> 请求时需在请求头携带 `Authorization: Bearer <您的_API_KEY>`。

---

## 🛠️ 服务管理命令

- **快速启动**：
  - Linux/macOS: `./start.sh`
  - Windows: `start.bat`
- **更新项目**：
  - Linux/macOS: `./update.sh`
  - Windows: `update.bat`
- **运行单元测试套件**：
  ```bash
  npm test
  ```
- **PM2 常用管理**：
  ```bash
  pm2 status antigravity2api    # 查看运行状态
  pm2 logs antigravity2api      # 查看实时日志
  pm2 restart antigravity2api   # 重启服务
  pm2 stop antigravity2api      # 停止服务
  ```

---

## 📄 开源许可

本项目遵循 MIT 开源许可证。
