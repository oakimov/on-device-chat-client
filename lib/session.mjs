const AUTO_COMPACT_RATIO = 0.85;

export class SessionManager {
  constructor(page, { port } = {}) {
    this.page = page;
    this.port = port;
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

  async ensureSession(systemPrompt, config) {
    const opts = {};
    if (systemPrompt) opts.systemPrompt = systemPrompt;
    if (config?.topK != null) opts.topK = config.topK;
    if (config?.temperature != null) opts.temperature = config.temperature;

    const result = await this.page.evaluate(
      (o) => window.ensureSession(o),
      opts
    );
    if (result.error) {
      throw new Error(`[${result.step}] ${result.error}`);
    }
    return result;
  }

  async resetSession(systemPrompt, config) {
    const opts = {};
    if (systemPrompt) opts.systemPrompt = systemPrompt;
    if (config?.topK != null) opts.topK = config.topK;
    if (config?.temperature != null) opts.temperature = config.temperature;

    const result = await this.page.evaluate(
      (o) => window.resetSession(o),
      opts
    );
    if (result.error) {
      throw new Error(`[${result.step}] ${result.error}`);
    }
    return result;
  }

  async prompt(promptText, { stream = true } = {}) {
    const fnName = stream ? 'promptSession' : 'promptSessionNonStreaming';
    return await this.page.evaluate(
      (args) => window[args.fn](args.text),
      { fn: fnName, text: promptText }
    );
  }

  async getContextInfo() {
    try {
      return await this.page.evaluate(() => window.getContextInfo());
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

  async checkAutoCompact(systemPrompt, config) {
    const ctx = await this.getContextInfo();
    if (ctx.window <= 0) return ctx;

    const ratio = ctx.usage / ctx.window;
    if (ratio < AUTO_COMPACT_RATIO) return ctx;

    const compactedPrompt = systemPrompt
      ? systemPrompt + '\n[Earlier conversation compacted to save context.]'
      : '[Earlier conversation compacted to save context.]';

    const result = await this.resetSession(compactedPrompt, config);
    return { usage: result.contextUsage || 0, window: result.contextWindow || 0 };
  }

  async destroySession() {
    try {
      await this.page.evaluate(() => {
        if (window.conversationSession) {
          try { window.conversationSession.destroy(); } catch (e) {}
          window.conversationSession = null;
        }
      });
    } catch {}
  }
}
