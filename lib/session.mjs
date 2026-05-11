const AUTO_COMPACT_RATIO = 0.85;

class Mutex {
  constructor() {
    this._queue = [];
    this._locked = false;
  }

  async acquire() {
    if (!this._locked) {
      this._locked = true;
      return;
    }
    await new Promise(resolve => this._queue.push(resolve));
  }

  release() {
    if (this._queue.length > 0) {
      const next = this._queue.shift();
      next();
    } else {
      this._locked = false;
    }
  }
}

export class SessionManager {
  constructor(page, { port } = {}) {
    this.page = page;
    this.port = port;
    this._mutexes = new Map();
  }

  _getMutex(sessionId) {
    const id = sessionId || 'cli';
    if (!this._mutexes.has(id)) {
      this._mutexes.set(id, new Mutex());
    }
    return this._mutexes.get(id);
  }

  async ensureReady() {
    let ready = false;
    try {
      ready = await this.page.evaluate(
        () => typeof window.ensureSession === 'function'
      );
    } catch {}
    if (ready) return;

    // Reload the page (server serves page.html at /)
    try {
      await this.page.goto(`http://localhost:${this.port}/`, { timeout: 10000 });
    } catch (e) {
      throw new Error(`Bridge page failed to load: ${e.message}`);
    }

    // Poll for readiness
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const hasFn = await this.page.evaluate(
          () => typeof window.ensureSession
        );
        if (hasFn === 'function') return;
      } catch {}
    }

    throw new Error('Bridge page failed to initialize after reload');
  }

  async ensureSession(systemPrompt, config, sessionId) {
    const opts = {};
    if (systemPrompt) opts.systemPrompt = systemPrompt;
    if (config?.topK != null) opts.topK = config.topK;
    if (config?.temperature != null) opts.temperature = config.temperature;

    const sid = sessionId || 'cli';
    const result = await this.page.evaluate(
      (args) => window.ensureSession(args.sid, args.opts),
      { sid, opts }
    );
    if (result.error) {
      throw new Error(`[${result.step}] ${result.error}`);
    }
    return result;
  }

  async resetSession(systemPrompt, config, sessionId) {
    const opts = {};
    if (systemPrompt) opts.systemPrompt = systemPrompt;
    if (config?.topK != null) opts.topK = config.topK;
    if (config?.temperature != null) opts.temperature = config.temperature;

    const sid = sessionId || 'cli';
    const result = await this.page.evaluate(
      (args) => window.resetSession(args.sid, args.opts),
      { sid, opts }
    );
    if (result.error) {
      throw new Error(`[${result.step}] ${result.error}`);
    }
    return result;
  }

  async prompt(promptText, { stream = true, sessionId } = {}) {
    const fnName = stream ? 'promptSession' : 'promptSessionNonStreaming';
    const sid = sessionId || 'cli';
    return await this.page.evaluate(
      (args) => window[args.fn](args.sid, args.text),
      { fn: fnName, sid, text: promptText }
    );
  }

  async getContextInfo(sessionId) {
    const sid = sessionId || 'cli';
    try {
      return await this.page.evaluate(
        (s) => window.getContextInfo(s),
        sid
      );
    } catch {
      return { usage: 0, window: 0 };
    }
  }

  async getModelParams() {
    try {
      return await this.page.evaluate(() => window.getModelParams());
    } catch {
      return null;
    }
  }

  async checkAutoCompact(systemPrompt, config, sessionId) {
    const ctx = await this.getContextInfo(sessionId);
    if (ctx.window <= 0) return ctx;

    const ratio = ctx.usage / ctx.window;
    if (ratio < AUTO_COMPACT_RATIO) return ctx;

    const compactedPrompt = systemPrompt
      ? systemPrompt + '\n[Earlier conversation compacted to save context.]'
      : '[Earlier conversation compacted to save context.]';

    const result = await this.resetSession(compactedPrompt, config, sessionId);
    return { usage: result.contextUsage || 0, window: result.contextWindow || 0 };
  }

  async destroySession(sessionId) {
    const sid = sessionId || 'cli';
    try {
      await this.page.evaluate(
        (s) => window.destroySession(s),
        sid
      );
    } catch {}
    this._mutexes.delete(sid);
  }

  async promptSerialized(systemPrompt, config, promptText, options = {}) {
    const sessionId = options.sessionId || 'cli';
    const mutex = this._getMutex(sessionId);
    await mutex.acquire();
    try {
      await this.ensureReady();
      const sessionResult = await this.ensureSession(systemPrompt, config, sessionId);
      if (sessionResult.error) {
        return { error: `[${sessionResult.step}] ${sessionResult.error}` };
      }
      const ctxInfo = await this.checkAutoCompact(systemPrompt, config, sessionId);
      const result = await this.prompt(promptText, { stream: options.stream, sessionId });
      return { ...result, ctxInfo, sessionResult };
    } catch (e) {
      return { error: e.message };
    } finally {
      mutex.release();
    }
  }
}
