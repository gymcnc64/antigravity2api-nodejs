import axios from 'axios';
import dns from 'dns';
import http from 'http';
import https from 'https';
import { Readable } from 'stream';
import { SocksProxyAgent } from 'socks-proxy-agent';
import config from '../config/config.js';

// ==================== DNS & 代理统一配置 ====================

// 自定义 DNS 解析：优先 IPv4，失败则回退 IPv6
// 当 config.forceIPv4 开启时（WARP 出口固定走 IPv4，规避 Google 对 WARP IPv6 段不稳定的地区判定），只解析 IPv4
function customLookup(hostname, options, callback) {
  if (config.forceIPv4) {
    return dns.lookup(hostname, { ...options, family: 4 }, callback);
  }
  dns.lookup(hostname, { ...options, family: 4 }, (err4, address4, family4) => {
    if (!err4 && address4) {
      return callback(null, address4, family4);
    }
    dns.lookup(hostname, { ...options, family: 6 }, (err6, address6, family6) => {
      if (!err6 && address6) {
        return callback(null, address6, family6);
      }
      callback(err4 || err6);
    });
  });
}

// 使用自定义 DNS 解析的 Agent（优先 IPv4，失败则 IPv6）
const httpAgent = new http.Agent({
  lookup: customLookup,
  keepAlive: true
});

const httpsAgent = new https.Agent({
  lookup: customLookup,
  keepAlive: true
});

// 统一构建代理配置
// 返回覆盖项：{ proxy: {...} } 用于 http/https 代理；{ proxy: false, httpAgent, httpsAgent } 用于 SOCKS 代理
export function buildProxySetup(proxyUrl = config.proxy) {
  if (!proxyUrl) return { proxy: false };
  const normalized = String(proxyUrl).trim();
  const isSocks = /^socks(4|4a|5|5h):\/\//i.test(normalized);

  if (isSocks) {
    // axios 原生不支持 SOCKS 代理，使用 SocksProxyAgent 建立隧道
    try {
      const agent = new SocksProxyAgent(normalized, {
        keepAlive: true,
        timeout: Number(config.timeout) || 30000,
        // 强制优先 IPv4 解析：WARP 的 IPv6 出口段被 Google 间歇性判定为
        // 不支持地区（400），IPv4 出口（104.28.x.x / 162.159.x.x）判定稳定
        lookup: customLookup
      });
      return { proxy: false, httpAgent: agent, httpsAgent: agent };
    } catch {
      return { proxy: false };
    }
  }

  try {
    const u = new URL(normalized);
    return {
      proxy: {
        protocol: u.protocol.replace(':', ''),
        host: u.hostname,
        port: parseInt(u.port, 10)
      }
    };
  } catch {
    return { proxy: false };
  }
}

// 将数据转换为流以启用 chunked 编码
function createChunkedStream(data) {
  const jsonStr = typeof data === 'string' ? data : JSON.stringify(data);
  return Readable.from([jsonStr]);
}

// 为 axios 构建统一请求配置
export function buildAxiosRequestConfig({
  method = 'POST',
  url,
  headers,
  data = null,
  timeout = config.timeout,
  responseType,
  useChunked = false
}) {
  const axiosConfig = {
    method,
    url,
    headers: { ...headers },
    timeout,
    httpAgent,
    httpsAgent,
    // 代理配置（SOCKS 代理会同时覆盖 httpAgent/httpsAgent）
    ...buildProxySetup(),
    // 禁用自动设置 Content-Length，让 axios 使用 Transfer-Encoding: chunked
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  };

  if (responseType) axiosConfig.responseType = responseType;
  
  if (data !== null) {
    if (useChunked) {
      // 使用流式数据以启用 chunked 编码
      axiosConfig.data = createChunkedStream(data);
      // 删除 Content-Length 头，强制使用 chunked
      delete axiosConfig.headers['Content-Length'];
    } else {
      axiosConfig.data = data;
    }
  }
  return axiosConfig;
}

// 简单封装 axios 调用，方便后续统一扩展（重试、打点等）
export async function httpRequest(configOverrides) {
  // 默认启用 chunked 编码以匹配官方客户端行为
  const axiosConfig = buildAxiosRequestConfig({ ...configOverrides, useChunked: true });
  return axios(axiosConfig);
}

// 流式请求封装
export async function httpStreamRequest(configOverrides) {
  // 默认启用 chunked 编码以匹配官方客户端行为
  const axiosConfig = buildAxiosRequestConfig({ ...configOverrides, useChunked: true });
  axiosConfig.responseType = 'stream';
  return axios(axiosConfig);
}
