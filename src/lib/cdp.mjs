// mmx-status :: lib/cdp.mjs
// Minimal zero-dependency Chrome DevTools Protocol client.
// Node 24 ships global WebSocket + fetch, so no npm packages are needed.

const HOST = '127.0.0.1';

export async function listTargets(port) {
  const url = `http://${HOST}:${port}/json/list`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`CDP HTTP ${res.status}`);
    const data = await res.json();
    return Array.isArray(data) ? data : [];
  } finally {
    clearTimeout(timer);
  }
}

export async function isCdpAvailable(port) {
  try {
    await listTargets(port);
    return true;
  } catch {
    return false;
  }
}

export async function version(port) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(`http://${HOST}:${port}/json/version`, { signal: ctrl.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Pick the MiniMax Code renderer page target. */
export function selectRenderer(targets) {
  const pages = targets.filter((t) => t.type === 'page');
  const exact = pages.find((t) => /^app:\/\/\.\/archon(?:[/#?]|$)/i.test(t.url || ''));
  if (exact) return exact;
  const anyApp = pages.find((t) => (t.url || '').startsWith('app://'));
  if (anyApp) return anyApp;
  throw new Error(
    '未找到 MiniMax Code 渲染进程 target。实际 target 列表：\n' +
      targets.map((t) => `  [${t.type}] ${t.url}`).join('\n')
  );
}

export class CdpSession {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }

  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败: ' + wsUrl)), {
        once: true,
      });
    });
    return new CdpSession(ws);
  }

  send(method, params = {}, timeoutMs = 30000) {
    const id = ++this.id;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload);
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时(${timeoutMs}ms): ${method}`));
        }
      }, timeoutMs);
    });
  }

  /**
   * Evaluate with retry. A freshly launched renderer can be busy fetching the
   * session list, and a single Runtime.evaluate may then exceed the timeout;
   * that must not take the whole tool down.
   */
  async evaluateWithRetry(expression, { attempts = 3, gapMs = 1500 } = {}) {
    let last;
    for (let i = 0; i < attempts; i++) {
      try {
        return await this.evaluate(expression);
      } catch (e) {
        last = e;
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, gapMs));
      }
    }
    throw last;
  }

  /** Evaluate an expression in the page and return the JSON value. */
  async evaluate(expression, { awaitPromise = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(
        '页面异常: ' + (d.exception?.description || d.text || JSON.stringify(d).slice(0, 300))
      );
    }
    return r.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export async function connectRenderer(port) {
  const targets = await listTargets(port);
  const target = selectRenderer(targets);
  const s = await CdpSession.connect(target.webSocketDebuggerUrl);
  // Enable Runtime so console/exception plumbing is live.
  await s.send('Runtime.enable').catch(() => {});
  return { session: s, target };
}
