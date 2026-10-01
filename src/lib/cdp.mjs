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
  } catch (e) {
    // Surface one actionable sentence instead of a raw undici TypeError with a
    // four-frame cause chain. Every caller (probes, daemon, launchers) already
    // relies on this throwing, so the contract is preserved -- only the message
    // changes. The DevToolsActivePort hint matters: that file routinely outlives
    // the browser it names, so "the file exists" is not "the port is listening".
    if (e && typeof e.message === 'string' && e.message.startsWith('CDP HTTP ')) throw e;
    if (e && e.name === 'AbortError') {
      throw new Error(`CDP 127.0.0.1:${port} 3 秒内无响应（超时）`);
    }
    const why = e && e.message ? e.message : String(e);
    throw new Error(
      `连不上 CDP 127.0.0.1:${port}：${why}。` +
        `该端口的实例可能已退出——注意 DevToolsActivePort 文件存在不代表端口在监听。`
    );
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
    // Timers armed by send(). A settled request must drop its timer right
    // away: the old code never cleared it, so every successful call left a
    // live 30s timer behind (and the whole guard in daemon.mjs leaked one per
    // tick). Exposed so tests can assert "no timer survives a settle".
    this.activeTimeouts = new Set();
    this.closed = false;
    this.closeReason = null;
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        this._clearTimer(timer);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
    // A dead socket used to leave every pending request hanging until its own
    // timeout fired, i.e. one dead renderer cost a full 30s wait per request
    // and a wall of "CDP 超时" noise. Fail them the instant the socket dies.
    this.ws.addEventListener('close', () => this._failAllPending('WebSocket 已关闭'));
    this.ws.addEventListener('error', () => this._failAllPending('WebSocket 错误'));
  }

  _clearTimer(timer) {
    if (!timer) return;
    clearTimeout(timer);
    this.activeTimeouts.delete(timer);
  }

  /** Reject everything still in flight, with the reason the socket died. */
  _failAllPending(reason) {
    this.closed = true;
    this.closeReason = reason;
    if (!this.pending.size) return;
    const entries = [...this.pending.entries()];
    this.pending.clear();
    for (const [id, entry] of entries) {
      this._clearTimer(entry.timer);
      entry.reject(new Error(`${reason}，未决请求 #${id} 被拒绝`));
    }
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
    // A request issued on a dead socket can never be answered; fail fast
    // instead of parking the caller for the full timeout.
    if (this.closed) {
      return Promise.reject(
        new Error(`${this.closeReason || '会话已关闭'}，无法发送 ${method}（请求 #${id}）`)
      );
    }
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          this.activeTimeouts.delete(timer);
          reject(new Error(`CDP 超时(${timeoutMs}ms): ${method}`));
        }
      }, timeoutMs);
      this.activeTimeouts.add(timer);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(payload);
      } catch (e) {
        this.pending.delete(id);
        this._clearTimer(timer);
        reject(new Error(`WebSocket 发送失败: ${method}: ${e.message}`));
      }
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
