import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { SocksProxyAgent } from 'socks-proxy-agent';

export function getProxyAgent(proxyUrl) {
  if (!proxyUrl || typeof proxyUrl !== 'string') return null;
  const lower = proxyUrl.toLowerCase().trim();
  if (lower.startsWith('socks5://') || lower.startsWith('socks4://')) {
    return new SocksProxyAgent(proxyUrl);
  }
  if (lower.startsWith('http://') || lower.startsWith('https://')) {
    return new HttpsProxyAgent(proxyUrl);
  }
  return null;
}

export class NetworkClient {
  async request(options = {}, retries = 2) {
    const { url, method = 'GET', headers = {}, data, proxy, timeout = 25000 } = options;

    const config = {
      url,
      method,
      headers: { ...headers },
      data,
      timeout,
      validateStatus: () => true // 捕获全部状态码以自行处理
    };

    if (proxy) {
      const agent = getProxyAgent(proxy);
      if (agent) {
        config.httpsAgent = agent;
        config.httpAgent = agent;
      }
    }

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await axios(config);
        return response.data;
      } catch (err) {
        lastError = err;
        if (attempt < retries) {
          const backoff = Math.pow(2, attempt) * 1000 + Math.random() * 500;
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    throw lastError || new Error(`Request failed for ${url}`);
  }
}

export const networkClient = new NetworkClient();
export default networkClient;
