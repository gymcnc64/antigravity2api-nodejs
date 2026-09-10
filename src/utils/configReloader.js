import config, { getConfigJson, getUpstreamConfig, buildConfig } from '../config/config.js';
import requesterManager from './requesterManager.js';
import proxyPoolManager from './proxyManager.js';

/**
 * 重新加载配置到 config 对象
 * 同时重置请求器，使新的 useNativeAxios / proxy / proxyPool / timeout 配置生效
 */
export function reloadConfig() {
  const newConfig = buildConfig(getConfigJson(), getUpstreamConfig());
  Object.assign(config, newConfig);
  proxyPoolManager.reload({
    proxy: config.proxy,
    proxyList: config.proxyPool?.proxyList,
    apiUrl: config.proxyPool?.apiUrl,
    apiIntervalMs: config.proxyPool?.apiIntervalMs,
    strategy: config.proxyPool?.strategy,
    maxFailures: config.proxyPool?.maxFailures,
    cooldownMs: config.proxyPool?.cooldownMs
  });
  requesterManager.reload();
}
