import axios from 'axios';
import http from 'http';
import https from 'https';
import dns from 'dns';
import { SocksProxyAgent } from 'socks-proxy-agent';
import logger from './logger.js';

/**
 * 代理节点健康状态管理与多节点智能调度器
 */
class ProxyPoolManager {
  constructor() {
    this._staticProxies = [];    // 静态配置的代理节点列表
    this._apiProxies = [];       // 从 API 动态拉取的代理节点列表
    this._currentIndex = 0;      // 轮询当前游标
    this._apiUrl = null;         // 动态代理 API 地址
    this._apiIntervalMs = 5 * 60 * 1000; // 默认 5 分钟拉取一次
    this._apiTimer = null;       // 定时器引用
    this._strategy = 'round_robin'; // round_robin | random | failover
    this._maxFailures = 3;       // 触发熔断的连续失败次数阈值
    this._cooldownMs = 60 * 1000;// 熔断后冷却时长（默认 1 分钟）
    this._fetchInProgress = false;
    this._lastFetchTime = null;
    this._lastFetchStatus = '未拉取';
    this._initialized = false;
  }

  /**
   * 规范化代理地址字符串
   * 1. 去除首尾空格及回车
   * 2. 自动补充 socks5:// 前缀（当用户仅输入 ip:port 时）
   * 3. 规范化 socks5h:// 为 socks5://
   * @param {string} raw
   * @returns {string|null}
   */
  normalizeProxyUrl(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let trimmed = raw.trim();
    if (!trimmed) return null;

    // 替换 socks5h:// 为 socks5://
    if (trimmed.startsWith('socks5h://')) {
      trimmed = 'socks5://' + trimmed.slice(10);
    }

    // 如果没有协议前缀，且符合 host:port 格式，默认添加 socks5://
    if (!/^[a-zA-Z0-9+-.]+:\/\//.test(trimmed)) {
      trimmed = 'socks5://' + trimmed;
    }

    try {
      const parsed = new URL(trimmed);
      const validProtocols = ['socks5:', 'socks5h:', 'socks4:', 'socks4a:', 'socks:', 'http:', 'https:'];
      if (!validProtocols.includes(parsed.protocol)) {
        return null;
      }
      return trimmed;
    } catch {
      return null;
    }
  }

  /**
   * 将字符串或数组解析并提取为标准的代理节点对象列表
   * @param {string|Array<string>} input 
   * @param {'static'|'api'} source 
   * @returns {Array<Object>}
   */
  parseProxyList(input, source = 'static') {
    if (!input) return [];
    let rawList = [];

    if (Array.isArray(input)) {
      rawList = input;
    } else if (typeof input === 'string') {
      // 支持逗号、分号、换行符分隔
      rawList = input.split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
    }

    const result = [];
    const seen = new Set();

    for (const item of rawList) {
      const normalized = this.normalizeProxyUrl(item);
      if (normalized && !seen.has(normalized)) {
        seen.add(normalized);
        result.push(this._createNodeObject(normalized, source));
      }
    }

    return result;
  }

  /**
   * 创建节点描述对象
   */
  _createNodeObject(url, source = 'static') {
    let protocol = 'socks5';
    let host = '';
    let port = 0;
    try {
      const u = new URL(url);
      protocol = u.protocol.replace(':', '');
      host = u.hostname;
      port = parseInt(u.port, 10) || (protocol.startsWith('http') ? 80 : 1080);
    } catch { /* ignore */ }

    return {
      url,
      source,
      protocol,
      host,
      port,
      failures: 0,
      successes: 0,
      consecutiveFailures: 0,
      lastUsed: 0,
      lastError: null,
      cooldownUntil: 0,
      latency: null,
      created: Date.now()
    };
  }

  /**
   * 解析外部 API 返回的内容（自适应 JSON 或多行纯文本）
   * @param {string|object} data
   * @returns {Array<string>} 提取出的代理 URL 列表
   */
  parseApiResponse(data) {
    if (!data) return [];
    const urls = [];

    if (typeof data === 'string') {
      // 尝试是否是 JSON 字符串
      try {
        const json = JSON.parse(data);
        return this.parseApiResponse(json);
      } catch {
        // 纯文本按行切分
        const lines = data.split(/[\r\n,;]+/).map(s => s.trim()).filter(Boolean);
        for (const line of lines) {
          const norm = this.normalizeProxyUrl(line);
          if (norm) urls.push(norm);
        }
      }
    } else if (Array.isArray(data)) {
      for (const item of data) {
        if (typeof item === 'string') {
          const norm = this.normalizeProxyUrl(item);
          if (norm) urls.push(norm);
        } else if (item && typeof item === 'object') {
          // 处理形如 { ip: '1.2.3.4', port: 1080, type: 'socks5', ... }
          const host = item.ip || item.host || item.server;
          const port = item.port || item.server_port;
          const protocol = item.protocol || item.type || 'socks5';
          const user = item.user || item.username || item.auth_user;
          const pass = item.pass || item.password || item.auth_pass;
          if (host && port) {
            let authStr = '';
            if (user && pass) authStr = `${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`;
            else if (user) authStr = `${encodeURIComponent(user)}@`;
            const raw = `${protocol}://${authStr}${host}:${port}`;
            const norm = this.normalizeProxyUrl(raw);
            if (norm) urls.push(norm);
          }
        }
      }
    } else if (data && typeof data === 'object') {
      // 常见代理 API 返回包装：{ code: 200, data: [...] } 或 { proxies: [...] } 或 { list: [...] }
      const candidateList = data.data || data.proxies || data.list || data.proxy_list || data.rows || data.result;
      if (Array.isArray(candidateList)) {
        return this.parseApiResponse(candidateList);
      }
    }

    return urls;
  }

  /**
   * 初始化与参数加载
   * @param {Object} options
   */
  init(options = {}) {
    const {
      proxy = null,
      proxyList = null,
      apiUrl = null,
      apiIntervalMs = 5 * 60 * 1000,
      strategy = 'round_robin',
      maxFailures = 3,
      cooldownMs = 60 * 1000
    } = options;

    this._strategy = strategy || 'round_robin';
    this._maxFailures = Number.isFinite(maxFailures) && maxFailures > 0 ? maxFailures : 3;
    this._cooldownMs = Number.isFinite(cooldownMs) && cooldownMs > 0 ? cooldownMs : 60 * 1000;
    this._apiUrl = apiUrl ? String(apiUrl).trim() : null;
    this._apiIntervalMs = Number.isFinite(apiIntervalMs) && apiIntervalMs >= 10000 ? apiIntervalMs : 5 * 60 * 1000;

    // 静态代理列表合并：同时支持单 PROXY 与多 PROXY_LIST
    const staticItems = [];
    if (proxyList) {
      staticItems.push(...this.parseProxyList(proxyList, 'static'));
    }
    if (proxy) {
      const single = this.parseProxyList(proxy, 'static');
      for (const node of single) {
        if (!staticItems.some(n => n.url === node.url)) {
          staticItems.unshift(node);
        }
      }
    }

    // 保留旧节点的统计数据（如果存在）
    const oldNodeMap = new Map();
    for (const n of [...this._staticProxies, ...this._apiProxies]) {
      oldNodeMap.set(n.url, n);
    }

    this._staticProxies = staticItems.map(node => {
      const old = oldNodeMap.get(node.url);
      if (old) {
        node.failures = old.failures;
        node.successes = old.successes;
        node.consecutiveFailures = old.consecutiveFailures;
        node.lastUsed = old.lastUsed;
        node.cooldownUntil = old.cooldownUntil;
        node.latency = old.latency;
      }
      return node;
    });

    this.startApiPolling();
    this._initialized = true;

    logger.info(`[ProxyManager] 代理池初始化完成: 静态节点 ${this._staticProxies.length} 个, 策略: ${this._strategy}, 故障阈值: ${this._maxFailures}次`);
  }

  /**
   * 启动 API 定时拉取
   */
  startApiPolling() {
    this.stopApiPolling();
    if (!this._apiUrl) return;

    // 立即异步拉取一次
    this.fetchFromApi().catch(err => {
      logger.warn(`[ProxyManager] 首次拉取 API 代理失败: ${err.message}`);
    });

    // 设定定时器
    this._apiTimer = setInterval(() => {
      this.fetchFromApi().catch(err => {
        logger.warn(`[ProxyManager] 定时拉取 API 代理失败: ${err.message}`);
      });
    }, this._apiIntervalMs);

    if (this._apiTimer.unref) {
      this._apiTimer.unref();
    }
  }

  /**
   * 停止 API 定时器
   */
  stopApiPolling() {
    if (this._apiTimer) {
      clearInterval(this._apiTimer);
      this._apiTimer = null;
    }
  }

  /**
   * 从指定的 API URL 主动提取代理节点
   * @param {boolean} force 是否强制拉取
   */
  async fetchFromApi(force = false) {
    if (!this._apiUrl) {
      throw new Error('未配置 PROXY_API_URL');
    }
    if (this._fetchInProgress && !force) {
      return { success: false, message: '正在拉取中，请稍后' };
    }

    this._fetchInProgress = true;
    this._lastFetchTime = Date.now();
    try {
      logger.info(`[ProxyManager] 正在从 API 拉取代理列表: ${this._apiUrl}`);
      // 拉取 API 时使用纯直连请求，避免代理本身不可用导致死锁
      const resp = await axios.get(this._apiUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Antigravity2API/ProxyPool'
        },
        proxy: false,
        httpAgent: false,
        httpsAgent: false
      });

      const extractedUrls = this.parseApiResponse(resp.data);
      if (!extractedUrls.length) {
        this._lastFetchStatus = `拉取完成，未识别到有效代理 (HTTP ${resp.status})`;
        logger.warn(`[ProxyManager] API 返回内容未识别到有效代理: ${typeof resp.data === 'string' ? resp.data.slice(0, 100) : JSON.stringify(resp.data).slice(0, 100)}`);
        return { success: false, count: 0, message: this._lastFetchStatus };
      }

      // 保留老节点的历史健康统计
      const oldNodeMap = new Map();
      for (const n of this._apiProxies) {
        oldNodeMap.set(n.url, n);
      }

      const newApiProxies = [];
      const seen = new Set();
      for (const url of extractedUrls) {
        if (!seen.has(url)) {
          seen.add(url);
          const old = oldNodeMap.get(url);
          const node = this._createNodeObject(url, 'api');
          if (old) {
            node.failures = old.failures;
            node.successes = old.successes;
            node.consecutiveFailures = old.consecutiveFailures;
            node.lastUsed = old.lastUsed;
            node.cooldownUntil = old.cooldownUntil;
            node.latency = old.latency;
          }
          newApiProxies.push(node);
        }
      }

      this._apiProxies = newApiProxies;
      this._lastFetchStatus = `成功拉取 ${newApiProxies.length} 个代理节点`;
      logger.info(`[ProxyManager] API 代理列表已更新，共计 ${newApiProxies.length} 个节点`);
      return { success: true, count: newApiProxies.length, message: this._lastFetchStatus };
    } catch (err) {
      this._lastFetchStatus = `拉取失败: ${err.message}`;
      logger.error(`[ProxyManager] 拉取 API 代理异常: ${err.message}`);
      throw err;
    } finally {
      this._fetchInProgress = false;
    }
  }

  /**
   * 获取所有注册的节点列表（静态 + API）
   * @returns {Array<Object>}
   */
  getAllNodes() {
    return [...this._staticProxies, ...this._apiProxies];
  }

  /**
   * 获取当前可用的健康节点列表（未处于熔断冷却期）
   * @returns {Array<Object>}
   */
  getHealthyNodes() {
    const now = Date.now();
    const all = this.getAllNodes();
    return all.filter(node => node.cooldownUntil <= now);
  }

  /**
   * 获取下一个用于发起请求的代理 URL
   * @param {boolean} forceRotate 是否强制轮换下一个
   * @returns {string|null}
   */
  getProxy(forceRotate = false) {
    const allNodes = this.getAllNodes();
    if (allNodes.length === 0) {
      return null;
    }

    // 仅有 1 个节点直接返回
    if (allNodes.length === 1) {
      const single = allNodes[0];
      single.lastUsed = Date.now();
      return single.url;
    }

    const healthyNodes = this.getHealthyNodes();
    const pool = healthyNodes.length > 0 ? healthyNodes : allNodes; // 全部熔断时降级使用全部节点

    let selectedNode = null;

    if (this._strategy === 'random') {
      const idx = Math.floor(Math.random() * pool.length);
      selectedNode = pool[idx];
    } else if (this._strategy === 'failover') {
      // 故障转移策略：优先始终使用第一个健康节点
      selectedNode = pool[0];
    } else {
      // 默认 round_robin 轮询
      if (forceRotate) {
        this._currentIndex = (this._currentIndex + 1) % pool.length;
      }
      if (this._currentIndex >= pool.length) {
        this._currentIndex = 0;
      }
      selectedNode = pool[this._currentIndex];
    }

    if (selectedNode) {
      selectedNode.lastUsed = Date.now();
      return selectedNode.url;
    }

    return null;
  }

  /**
   * 轮换并切换到下一个可用健康节点
   * @param {string} reason 切换原因
   * @returns {string|null} 切换后的代理 URL
   */
  rotateProxy(reason = '') {
    const allNodes = this.getAllNodes();
    if (allNodes.length <= 1) {
      return allNodes[0]?.url || null;
    }

    const nextProxy = this.getProxy(true);
    if (reason) {
      logger.info(`[ProxyManager] 触发代理轮换 (${reason}) -> 当前选用: ${this.maskProxyUrl(nextProxy)}`);
    }
    return nextProxy;
  }

  /**
   * 上报某个代理节点请求失败
   * @param {string} proxyUrl 
   * @param {Error|string} error 
   */
  markProxyFailed(proxyUrl, error = null) {
    if (!proxyUrl) return;
    const all = this.getAllNodes();
    const node = all.find(n => n.url === proxyUrl);
    if (!node) return;

    node.failures += 1;
    node.consecutiveFailures += 1;
    const errMsg = typeof error === 'string' ? error : (error?.message || '未知错误');
    node.lastError = errMsg;

    // 检查是否达到连续失败熔断阈值
    if (node.consecutiveFailures >= this._maxFailures) {
      node.cooldownUntil = Date.now() + this._cooldownMs;
      const cooldownSec = Math.round(this._cooldownMs / 1000);
      logger.warn(`[ProxyManager] 节点 ${this.maskProxyUrl(node.url)} 连续失败 ${node.consecutiveFailures} 次，触发熔断冷却 ${cooldownSec} 秒 (最后错误: ${errMsg})`);
      // 自动触发轮换
      this.rotateProxy('节点熔断故障转移');
    }
  }

  /**
   * 上报某个代理节点请求成功
   * @param {string} proxyUrl 
   * @param {number} latencyMs 延迟（可选）
   */
  markProxySuccess(proxyUrl, latencyMs = null) {
    if (!proxyUrl) return;
    const all = this.getAllNodes();
    const node = all.find(n => n.url === proxyUrl);
    if (!node) return;

    node.successes += 1;
    node.consecutiveFailures = 0;
    node.cooldownUntil = 0; // 成功即恢复健康
    node.lastError = null;
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      node.latency = latencyMs;
    }
  }

  /**
   * 对代理 URL 中的账号密码进行脱敏
   * @param {string} url
   * @returns {string}
   */
  maskProxyUrl(url) {
    if (!url) return '';
    try {
      const u = new URL(url);
      if (u.password) {
        u.password = '******';
      }
      return u.toString();
    } catch {
      return url;
    }
  }

  /**
   * 测试单个代理节点的连通性与延迟
   * @param {string} proxyUrl 
   * @param {number} timeoutMs 
   * @returns {Promise<{ success: boolean, latency: number, ip?: string, error?: string }>}
   */
  async testNode(proxyUrl, timeoutMs = 8000) {
    const normalized = this.normalizeProxyUrl(proxyUrl);
    if (!normalized) {
      return { success: false, latency: 0, error: '无效的代理地址' };
    }

    const start = Date.now();
    try {
      const isSocks = /^socks(4|4a|5|5h):\/\//i.test(normalized);
      let requestConfig = {
        timeout: timeoutMs,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
      };

      if (isSocks) {
        const agent = new SocksProxyAgent(normalized, {
          timeout: timeoutMs
        });
        requestConfig.httpAgent = agent;
        requestConfig.httpsAgent = agent;
        requestConfig.proxy = false;
      } else {
        const u = new URL(normalized);
        requestConfig.proxy = {
          protocol: u.protocol.replace(':', ''),
          host: u.hostname,
          port: parseInt(u.port, 10)
        };
        if (u.username && u.password) {
          requestConfig.proxy.auth = {
            username: decodeURIComponent(u.username),
            password: decodeURIComponent(u.password)
          };
        }
      }

      // 探测出口 IP 与连通性
      const resp = await axios.get('https://api.ipify.org?format=json', requestConfig);
      const latency = Date.now() - start;
      const ip = resp.data?.ip || 'connected';
      this.markProxySuccess(normalized, latency);
      return { success: true, latency, ip };
    } catch (err) {
      const latency = Date.now() - start;
      this.markProxyFailed(normalized, err);
      return { success: false, latency, error: err.message || '连接超时或失败' };
    }
  }

  /**
   * 获取当前代理池全景状态与健康度度量
   */
  getStatus() {
    const now = Date.now();
    const all = this.getAllNodes();
    const healthy = this.getHealthyNodes();

    const nodes = all.map(n => ({
      url: n.url,
      maskedUrl: this.maskProxyUrl(n.url),
      source: n.source,
      protocol: n.protocol,
      host: n.host,
      port: n.port,
      healthy: n.cooldownUntil <= now,
      failures: n.failures,
      successes: n.successes,
      consecutiveFailures: n.consecutiveFailures,
      lastError: n.lastError,
      cooldownRemainingSec: n.cooldownUntil > now ? Math.ceil((n.cooldownUntil - now) / 1000) : 0,
      latency: n.latency,
      lastUsed: n.lastUsed ? new Date(n.lastUsed).toISOString() : null
    }));

    return {
      enabled: all.length > 0,
      totalCount: all.length,
      healthyCount: healthy.length,
      staticCount: this._staticProxies.length,
      apiCount: this._apiProxies.length,
      strategy: this._strategy,
      maxFailures: this._maxFailures,
      cooldownMs: this._cooldownMs,
      apiUrl: this._apiUrl ? this.maskProxyUrl(this._apiUrl) : null,
      apiIntervalMs: this._apiIntervalMs,
      lastFetchTime: this._lastFetchTime ? new Date(this._lastFetchTime).toISOString() : null,
      lastFetchStatus: this._lastFetchStatus,
      nodes
    };
  }

  /**
   * 重载并应用新配置
   * @param {Object} options
   */
  reload(options = {}) {
    this.init(options);
  }
}

// 导出单例
const proxyPoolManager = new ProxyPoolManager();
export default proxyPoolManager;
export { ProxyPoolManager };
