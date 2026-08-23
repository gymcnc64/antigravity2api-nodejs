import { exec } from 'child_process';
import axios from 'axios';
import log from './logger.js';
import config from '../config/config.js';
import { buildProxySetup } from './httpClient.js';

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
}

const warpManager = new WarpManager();
export default warpManager;
