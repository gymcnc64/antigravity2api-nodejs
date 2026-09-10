import assert from 'assert';
import { ProxyPoolManager } from '../src/utils/proxyManager.js';
import { buildProxySetup, buildAxiosRequestConfig } from '../src/utils/httpClient.js';

console.log('🚀 开始执行 ProxyPoolManager 与代理池调度全链路单元测试...\n');

let totalTests = 0;
let passedTests = 0;

function test(name, fn) {
  totalTests++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

async function asyncTest(name, fn) {
  totalTests++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passedTests++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    throw err;
  }
}

// 1. 规范化与格式解析测试
test('1.1 代理 URL 规范化与协议补全', () => {
  const pm = new ProxyPoolManager();
  assert.strictEqual(pm.normalizeProxyUrl('127.0.0.1:1080'), 'socks5://127.0.0.1:1080');
  assert.strictEqual(pm.normalizeProxyUrl('socks5h://user:pass@127.0.0.1:1080'), 'socks5://user:pass@127.0.0.1:1080');
  assert.strictEqual(pm.normalizeProxyUrl('http://127.0.0.1:7890'), 'http://127.0.0.1:7890');
  assert.strictEqual(pm.normalizeProxyUrl('socks5://192.168.1.1:8888'), 'socks5://192.168.1.1:8888');
  assert.strictEqual(pm.normalizeProxyUrl('   '), null);
  assert.strictEqual(pm.normalizeProxyUrl(null), null);
});

test('1.2 静态代理列表多分隔符解析与去重', () => {
  const pm = new ProxyPoolManager();
  const input = `
    socks5://127.0.0.1:40000, socks5://127.0.0.1:40001;
    127.0.0.1:40002
    socks5://127.0.0.1:40000
  `;
  const nodes = pm.parseProxyList(input, 'static');
  assert.strictEqual(nodes.length, 3);
  assert.strictEqual(nodes[0].url, 'socks5://127.0.0.1:40000');
  assert.strictEqual(nodes[1].url, 'socks5://127.0.0.1:40001');
  assert.strictEqual(nodes[2].url, 'socks5://127.0.0.1:40002');
  assert.strictEqual(nodes[0].port, 40000);
});

test('1.3 密码脱敏功能', () => {
  const pm = new ProxyPoolManager();
  const masked = pm.maskProxyUrl('socks5://admin:SuperSecret123@1.2.3.4:1080');
  assert.strictEqual(masked, 'socks5://admin:******@1.2.3.4:1080');
  assert.strictEqual(pm.maskProxyUrl('socks5://127.0.0.1:40000'), 'socks5://127.0.0.1:40000');
});

// 2. 多节点调度与轮询测试
test('2.1 Round-Robin 多节点轮询调度', () => {
  const pm = new ProxyPoolManager();
  pm.init({
    proxyList: 'socks5://127.0.0.1:1001, socks5://127.0.0.1:1002, socks5://127.0.0.1:1003',
    strategy: 'round_robin'
  });

  const p1 = pm.getProxy();
  assert.strictEqual(p1, 'socks5://127.0.0.1:1001');

  const p2 = pm.rotateProxy('测试轮询');
  assert.strictEqual(p2, 'socks5://127.0.0.1:1002');

  const p3 = pm.rotateProxy('测试轮询');
  assert.strictEqual(p3, 'socks5://127.0.0.1:1003');

  const p4 = pm.rotateProxy('测试轮询回到首个');
  assert.strictEqual(p4, 'socks5://127.0.0.1:1001');
});

test('2.2 Failover 主备故障转移调度', () => {
  const pm = new ProxyPoolManager();
  pm.init({
    proxyList: 'socks5://127.0.0.1:2001, socks5://127.0.0.1:2002',
    strategy: 'failover',
    maxFailures: 2,
    cooldownMs: 5000
  });

  // 正常情况下始终返回主节点
  assert.strictEqual(pm.getProxy(), 'socks5://127.0.0.1:2001');
  assert.strictEqual(pm.getProxy(), 'socks5://127.0.0.1:2001');

  // 主节点失败 1 次，仍未熔断
  pm.markProxyFailed('socks5://127.0.0.1:2001', '连接超时');
  assert.strictEqual(pm.getProxy(), 'socks5://127.0.0.1:2001');

  // 主节点达到 2 次连续失败，触发熔断，自动切换到备用节点
  pm.markProxyFailed('socks5://127.0.0.1:2001', '连接被拒');
  assert.strictEqual(pm.getProxy(), 'socks5://127.0.0.1:2002');
});

// 3. 故障熔断与健康自愈
test('3.1 连续故障熔断、冷却跳过与成功自愈', () => {
  const pm = new ProxyPoolManager();
  pm.init({
    proxyList: 'socks5://127.0.0.1:3001, socks5://127.0.0.1:3002',
    maxFailures: 3,
    cooldownMs: 10000
  });

  // 节点 1 连续失败 3 次
  pm.markProxyFailed('socks5://127.0.0.1:3001', '错误1');
  pm.markProxyFailed('socks5://127.0.0.1:3001', '错误2');
  assert.strictEqual(pm.getHealthyNodes().length, 2);

  pm.markProxyFailed('socks5://127.0.0.1:3001', '错误3');
  // 节点 1 熔断，健康节点仅剩 1 个
  const healthy = pm.getHealthyNodes();
  assert.strictEqual(healthy.length, 1);
  assert.strictEqual(healthy[0].url, 'socks5://127.0.0.1:3002');

  // 此时获取代理只能获得健康的节点 2
  assert.strictEqual(pm.getProxy(), 'socks5://127.0.0.1:3002');

  // 节点 1 恢复自愈（例如探测成功）
  pm.markProxySuccess('socks5://127.0.0.1:3001', 50);
  assert.strictEqual(pm.getHealthyNodes().length, 2);
  const status = pm.getStatus();
  const n1 = status.nodes.find(n => n.url === 'socks5://127.0.0.1:3001');
  assert.strictEqual(n1.healthy, true);
  assert.strictEqual(n1.latency, 50);
  assert.strictEqual(n1.consecutiveFailures, 0);
});

// 4. API 动态代理自适应解析
test('4.1 提取并解析各种常见 API 返回格式', () => {
  const pm = new ProxyPoolManager();

  // 4.1.1 纯文本格式
  const textApi = `
    104.28.1.1:1080
    socks5://admin:pass@104.28.1.2:1080
  `;
  const res1 = pm.parseApiResponse(textApi);
  assert.strictEqual(res1.length, 2);
  assert.strictEqual(res1[0], 'socks5://104.28.1.1:1080');
  assert.strictEqual(res1[1], 'socks5://admin:pass@104.28.1.2:1080');

  // 4.1.2 JSON 数组格式
  const jsonArr = [
    { ip: '192.168.1.100', port: 1080, type: 'socks5' },
    { host: '192.168.1.101', port: 1081, protocol: 'socks5', user: 'u', pass: 'p' },
    'socks5://192.168.1.102:1082'
  ];
  const res2 = pm.parseApiResponse(jsonArr);
  assert.strictEqual(res2.length, 3);
  assert.strictEqual(res2[0], 'socks5://192.168.1.100:1080');
  assert.strictEqual(res2[1], 'socks5://u:p@192.168.1.101:1081');
  assert.strictEqual(res2[2], 'socks5://192.168.1.102:1082');

  // 4.1.3 JSON 对象包装格式 (如 { code: 200, data: [...] })
  const jsonObj = {
    code: 200,
    msg: 'ok',
    data: [
      { ip: '10.0.0.1', port: 8080, type: 'socks5' },
      { ip: '10.0.0.2', port: 8081, type: 'socks5' }
    ]
  };
  const res3 = pm.parseApiResponse(jsonObj);
  assert.strictEqual(res3.length, 2);
  assert.strictEqual(res3[0], 'socks5://10.0.0.1:8080');
  assert.strictEqual(res3[1], 'socks5://10.0.0.2:8081');
});

// 5. 单代理与多代理混合初始化
test('5.1 单 PROXY 与 PROXY_LIST 合并兼容性', () => {
  const pm = new ProxyPoolManager();
  pm.init({
    proxy: 'socks5://127.0.0.1:40000',
    proxyList: 'socks5://127.0.0.1:40001, socks5://127.0.0.1:40000',
  });
  const nodes = pm.getAllNodes();
  assert.strictEqual(nodes.length, 2);
  assert.ok(nodes.some(n => n.url === 'socks5://127.0.0.1:40000'));
  assert.ok(nodes.some(n => n.url === 'socks5://127.0.0.1:40001'));
});

// 6. 网络层 buildProxySetup 动态绑定测试
test('6.1 buildProxySetup 与 buildAxiosRequestConfig 动态解析', () => {
  const setupSocks = buildProxySetup('socks5://127.0.0.1:40000');
  assert.strictEqual(setupSocks.proxy, false);
  assert.ok(setupSocks.httpAgent);
  assert.ok(setupSocks.httpsAgent);
  assert.strictEqual(setupSocks.currentProxyUrl, 'socks5://127.0.0.1:40000');

  const setupHttp = buildProxySetup('http://127.0.0.1:7890');
  assert.strictEqual(setupHttp.proxy.host, '127.0.0.1');
  assert.strictEqual(setupHttp.proxy.port, 7890);
  assert.strictEqual(setupHttp.proxy.protocol, 'http');

  const axiosCfg = buildAxiosRequestConfig({
    url: 'https://example.com',
    proxy: 'socks5://127.0.0.1:40000'
  });
  assert.strictEqual(axiosCfg.proxy, false);
  assert.ok(axiosCfg.httpAgent);
  assert.strictEqual(axiosCfg.currentProxyUrl, 'socks5://127.0.0.1:40000');
});

console.log(`\n🎉 自动化测试套件执行完毕：共 ${totalTests} 项测试全部通过 (${passedTests}/${totalTests})！\n`);
