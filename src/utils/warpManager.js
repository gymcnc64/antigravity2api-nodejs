import { exec } from 'child_process';
import axios from 'axios';
import log from './logger.js';
import config from '../config/config.js';
import { buildProxySetup } from './httpClient.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * WARP 代理管理模块
 * 负责 Cloudflare WARP 客户端的状态检测、出口 IP 查询与智能自愈重启
 */
class WarpManager {
  constructor() {
    this.lastRestartTime = 0;
    this.cooldownMs = 60 * 1000; // 60秒冷却时间，防止高并发下频繁重启
    this.isRestarting = false;
    this.defaultPort = 40000;
    this._probeTimer = null;
    this._probing = false;
    this.lastProbeResult = null;
  }

  /**
   * 执行 Shell 命令辅助工具
   * @param {string} cmd
   * @param {number} timeoutMs
   * @returns {Promise<{ success: boolean, stdout: string, stderr: string }>}
   */
  _execCmd(cmd, timeoutMs = 15000) {
    return new Promise((resolve) => {
      exec(cmd, { timeout: timeoutMs }, (error, stdout, stderr) => {
        if (error) {
          resolve({ success: false, stdout: stdout?.toString() || '', stderr: (stderr?.toString() || error.message).trim() });
        } else {
          resolve({ success: true, stdout: stdout?.toString()?.trim() || '', stderr: stderr?.toString()?.trim() || '' });
        }
      });
    });
  }

  /**
   * 检查系统是否安装了 WARP 客户端
   * @returns {Promise<boolean>}
   */
  async isInstalled() {
    const res = await this._execCmd('which warp-cli || which warp');
    return res.success && !!res.stdout;
  }

  /**
   * 通过 WARP SOCKS5 代理探测当前出口 IP 与国家位置
   * @param {string} proxyUrl - 默认使用 socks5://127.0.0.1:40000
   * @returns {Promise<{ ip: string, loc: string, colo: string, country: string, fullData: any }>}
   */
  async getOutboundIpInfo(proxyUrl = `socks5://127.0.0.1:${this.defaultPort}`) {
    const proxySetup = buildProxySetup(proxyUrl);
    const result = { ip: '', loc: '', colo: '', country: '', fullData: null };

    // 1. 首选请求 Cloudflare 自家 trace 端点（最快且最准确反映 WARP 节点）
    try {
      const traceRes = await axios({
        method: 'GET',
        url: 'https://www.cloudflare.com/cdn-cgi/trace',
        timeout: 6000,
        validateStatus: () => true,
        ...proxySetup
      });

      if (traceRes.status === 200 && typeof traceRes.data === 'string') {
        const lines = traceRes.data.split('\n');
        for (const line of lines) {
          const [k, v] = line.split('=');
          if (k === 'ip') result.ip = v?.trim() || '';
          if (k === 'loc') {
            result.loc = v?.trim() || '';
            result.country = result.loc;
          }
          if (k === 'colo') result.colo = v?.trim() || '';
        }
        if (result.ip) {
          return result;
        }
      }
    } catch {
      // trace 失败，回退尝试备用 IP 查询
    }

    // 2. 备选请求 ipinfo.io
    try {
      const ipRes = await axios({
        method: 'GET',
        url: 'https://ipinfo.io/json',
        timeout: 6000,
        validateStatus: () => true,
        ...proxySetup
      });
      if (ipRes.status === 200 && ipRes.data?.ip) {
        result.ip = ipRes.data.ip;
        result.country = ipRes.data.country || '';
        result.loc = ipRes.data.country || '';
        result.fullData = ipRes.data;
        return result;
      }
    } catch {
      // 忽略备选错误
    }

    return result;
  }

  /**
   * 获取 WARP 综合运行状态
   * @returns {Promise<Object>}
   */
  async getStatus() {
    const installed = await this.isInstalled();
    const proxyUrl = `socks5://127.0.0.1:${this.defaultPort}`;

    if (!installed) {
      return {
        installed: false,
        running: false,
        connected: false,
        statusText: '未安装',
        proxyUrl,
        ipInfo: null,
        autoRestartEnabled: config?.autoRestartWarp !== false
      };
    }

    // 检查 warp-cli 状态
    const statusCmd = await this._execCmd('warp-cli --accept-tos status 2>/dev/null || warp-cli status 2>/dev/null || warp status 2>/dev/null');
    const rawStatus = statusCmd.stdout || '';

    let connected = false;
    let statusText = '未知';

    if (rawStatus.includes('Connected') || rawStatus.includes('Success')) {
      connected = true;
      statusText = '已连接';
    } else if (rawStatus.includes('Connecting')) {
      statusText = '连接中';
    } else if (rawStatus.includes('Disconnected')) {
      statusText = '未连接';
    } else if (rawStatus.includes('Daemon Startup') || rawStatus.includes('Stopped')) {
      statusText = '已停止';
    } else if (statusCmd.success) {
      statusText = rawStatus.split('\n')[0] || '运行中';
    }

    // 探测出口 IP 信息
    let ipInfo = null;
    try {
      const outbound = await this.getOutboundIpInfo(proxyUrl);
      if (outbound.ip) {
        ipInfo = outbound;
        if (!connected) {
          // 如果能够通过 40000 端口连通外网，确认处于连接可用状态
          connected = true;
          statusText = '已连接';
        }
      }
    } catch {
      // 代理不可用
    }

    return {
      installed: true,
      running: true,
      connected,
      statusText,
      rawStatus,
      proxyUrl,
      ipInfo,
      autoRestartEnabled: config?.autoRestartWarp !== false,
      lastRestartTime: this.lastRestartTime ? new Date(this.lastRestartTime).toISOString() : null
    };
  }

  /**
   * 触发重启 WARP
   * @param {string} reason - 重启原因
   * @param {boolean} force - 是否强制重启（跳过冷却）
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async restartWarp(reason = '网络请求受阻', force = false) {
    if (!force && config?.autoRestartWarp === false) {
      log.debug(`[WARP] 已手动关闭自动重启 WARP 开关，跳过执行系统命令 (${reason})`);
      return { success: false, message: '已关闭自动重启 WARP' };
    }

    const now = Date.now();
    if (this.isRestarting) {
      log.warn(`[WARP] 已有 WARP 重启任务正在进行中，跳过重复请求 (${reason})`);
      return { success: false, message: 'WARP 重启任务已在进行中' };
    }

    if (!force && now - this.lastRestartTime < this.cooldownMs) {
      const remainSec = Math.ceil((this.cooldownMs - (now - this.lastRestartTime)) / 1000);
      log.warn(`[WARP] 触发重启过于频繁，冷却中 (还剩 ${remainSec} 秒) - 跳过重启`);
      return { success: false, message: `重启过于频繁，请等待 ${remainSec} 秒` };
    }

    this.isRestarting = true;
    this.lastRestartTime = now;

    log.warn(`[WARP] ⚡ 检测到异常: ${reason}，正在执行自动重启命令: warp restart ...`);

    try {
      // 优先尝试 warp restart 快捷命令
      let res = await this._execCmd('warp restart 2>/dev/null || warp-google restart 2>/dev/null');

      // 若快捷命令不可用，使用 systemctl 或 warp-cli 原生指令回退重启
      if (!res.success) {
        log.info('[WARP] 正在通过 systemctl 重启 warp-svc 服务...');
        res = await this._execCmd('systemctl restart warp-svc 2>/dev/null || (warp-cli --accept-tos disconnect && sleep 2 && warp-cli --accept-tos connect)');
      }

      this.isRestarting = false;

      if (res.success) {
        log.info(`[WARP] ✓ WARP 重启命令执行成功！${res.stdout ? res.stdout.substring(0, 100) : ''}`);
        return { success: true, message: 'WARP 重启成功' };
      } else {
        log.error(`[WARP] 重启失败: ${res.stderr || res.stdout}`);
        return { success: false, message: `重启失败: ${res.stderr || '未知错误'}` };
      }
    } catch (err) {
      this.isRestarting = false;
      log.error(`[WARP] 重启异常: ${err.message}`);
      return { success: false, message: err.message };
    }
  }

  /**
   * 优化 WARP 隧道协议（切换为抗丢包抖动性最强的 wireguard 协议）
   * @returns {Promise<{ success: boolean, message: string }>}
   */
  async optimizeProtocol() {
    try {
      const res = await this._execCmd(
        'warp-cli --accept-tos tunnel protocol set wireguard 2>/dev/null || ' +
        'warp-cli tunnel protocol set wireguard 2>/dev/null || ' +
        'warp-cli set-protocol wireguard 2>/dev/null'
      );
      if (res.success) {
        log.info('[WARP] 已成功将底层隧道协议设置为 WireGuard 模式');
        return { success: true, message: '已切换为 WireGuard 协议模式' };
      }
      return { success: false, message: res.stderr || '设置 WireGuard 协议失败' };
    } catch (err) {
      return { success: false, message: err.message };
    }
  }

  /**
   * 清理历史遗留的定时器干扰（如 warp-google-update.timer）
   */
  async cleanupLegacyServices() {
    try {
      await this._execCmd('systemctl stop warp-google-update.timer warp-google-update.service 2>/dev/null || true');
      await this._execCmd('systemctl disable warp-google-update.timer warp-google-update.service 2>/dev/null || true');
      log.debug('[WARP] 已完成历史遗留定时服务检查与清理');
    } catch { }
  }

  // ==================== 出口健康自动探测 ====================

  /**
   * 探测当前 WARP 出口是否被 Google 接受（无 400 地区限制）
   * 使用轻量级 fetchAvailableModels 请求，与真实聊天请求走同一地区校验链路
   * @returns {Promise<{ healthy: boolean, reason?: string, message?: string }>}
   */
  async probeExitHealth() {
    const proxyUrl = `socks5://127.0.0.1:${this.defaultPort}`;

    try {
      // 动态导入避免循环依赖
      const { default: tokenManager } = await import('../auth/token_manager.js');
      const { default: requesterManager } = await import('./requesterManager.js');

      const token = await tokenManager.getToken();
      if (!token) {
        return { healthy: true, reason: 'no-token', message: '暂无可用 token，跳过探测' };
      }

      const headers = {
        'Host': config.api.host,
        'User-Agent': config.api.userAgent,
        'Authorization': `Bearer ${token.access_token}`,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'gzip'
      };

      await requesterManager.fetch(config.api.modelsUrl, {
        method: 'POST',
        headers,
        body: {},
        okStatus: [200]
      });

      // 探测通过：记录出口 IP（低频，避免日志刷屏）
      this.lastProbeResult = { healthy: true, checkedAt: Date.now() };
      return { healthy: true };
    } catch (error) {
      const message = error?.message || '';
      if (error?.status === 400 && /location is not supported/i.test(message)) {
        log.warn('[WARP-Health] ⚠️ 出口被 Google 判定为不支持地区 (400)');
        this.lastProbeResult = { healthy: false, reason: 'geo-blocked', checkedAt: Date.now() };
        return { healthy: false, reason: 'geo-blocked', message: message.slice(0, 120) };
      }
      // 网络抖动/其他错误不判定为地区问题（避免误重启出口），视为健康继续运行
      if (error?.status || /dial tcp|connection refused|ECONNREFUSED/i.test(message)) {
        log.debug(`[WARP-Health] 探测未通过但非地区问题: ${message.slice(0, 100)}`);
      }
      return { healthy: true, reason: 'unknown', message: message.slice(0, 120) };
    }
  }

  /**
   * 启动出口健康定时探测
   * 探测到 400 地区限制时自动重启 WARP 换出口，换完后再次探测确认
   */
  startHealthProbe() {
    if (this._probeTimer) return;
    if (config.autoProbeWarp === false) {
      log.info('[WARP-Health] 已关闭出口健康自动探测 (autoProbeWarp=false)');
      return;
    }

    const intervalMs = Number(config.warpProbeIntervalMs) > 0
      ? config.warpProbeIntervalMs
      : 60 * 1000;

    const runProbe = async () => {
      if (this._probing || this.isRestarting) return;
      this._probing = true;
      try {
        const result = await this.probeExitHealth();
        if (result.healthy === false && result.reason === 'geo-blocked') {
          log.warn('[WARP-Health] 🔄 出口地区受限，自动重启 WARP 换出口...');
          await this.restartWarp('出口地区受限自动换出口');
          // 等待 WARP 重建隧道后再确认一次
          await sleep(10000);
          const retryResult = await this.probeExitHealth();
          if (retryResult.healthy === false && retryResult.reason === 'geo-blocked') {
            log.error('[WARP-Health] ❌ 换出口后仍被判定地区受限，等待下轮探测');
          } else {
            log.info('[WARP-Health] ✓ 换出口后探测通过');
          }
        }
      } catch (err) {
        log.debug('[WARP-Health] 探测流程异常:', err.message);
      } finally {
        this._probing = false;
      }
    };

    // 启动 30 秒后先执行一次，之后按配置间隔循环
    setTimeout(() => {
      runProbe();
      this._probeTimer = setInterval(runProbe, intervalMs);
      this._probeTimer.unref?.();
    }, 30000);
    log.info(`[WARP-Health] 出口健康自动探测已启动 (间隔 ${Math.round(intervalMs / 1000)}s)`);
  }

  /**
   * 停止出口健康定时探测
   */
  stopHealthProbe() {
    if (this._probeTimer) {
      clearInterval(this._probeTimer);
      this._probeTimer = null;
      log.info('[WARP-Health] 出口健康自动探测已停止');
    }
  }
}

const warpManager = new WarpManager();
export default warpManager;
