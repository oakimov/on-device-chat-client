#!/usr/bin/env node

import puppeteer from 'puppeteer-core';
import { existsSync, readFileSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { spawn } from 'child_process';
import os from 'os';
import { marked } from 'marked';
import { markedTerminal } from 'marked-terminal';
import { SessionManager } from './lib/session.mjs';
import { createServer } from './lib/server.mjs';

marked.use(markedTerminal({
  unescape: true,
  tab: 2,
}));

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_CDP_PORT = 9222;
const DEFAULT_PORT = 3457;
const CHROME_USER_DATA_DIR = join(os.tmpdir(), "chrome-debug-profile");

// ── CLI flags ──

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { prompt: null, stream: true, port: DEFAULT_PORT, cdp: DEFAULT_CDP_PORT, noLaunch: false, topK: undefined, temperature: undefined };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompt' && args[i + 1]) {
      opts.prompt = args[i + 1];
      i++;
    } else if (args[i] === '--port' && args[i + 1]) {
      opts.port = parseInt(args[i + 1], 10) || DEFAULT_PORT;
      i++;
    } else if (args[i] === '--cdp' && args[i + 1]) {
      opts.cdp = parseInt(args[i + 1], 10) || DEFAULT_CDP_PORT;
      i++;
    } else if (args[i] === '--no-stream') {
      opts.stream = false;
    } else if (args[i] === '--no-launch') {
      opts.noLaunch = true;
    } else if (args[i] === '--top-k' && args[i + 1]) {
      opts.topK = parseInt(args[i + 1], 10);
      if (isNaN(opts.topK)) { console.error(`Invalid --top-k value: ${args[i + 1]}`); process.exit(1); }
      i++;
    } else if (args[i] === '--temperature' && args[i + 1]) {
      opts.temperature = parseFloat(args[i + 1]);
      if (isNaN(opts.temperature)) { console.error(`Invalid --temperature value: ${args[i + 1]}`); process.exit(1); }
      i++;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: node chat.mjs [options]

Options:
  --prompt <text>     Send a single prompt and exit
  --port <n>          HTTP port for dashboard (default: 3457)
  --cdp <n>           Chrome DevTools Protocol port (default: 9222)
  --top-k <n>         Top-K sampling parameter (default: model default)
  --temperature <n>   Temperature parameter (default: model default)
  --no-stream         Wait for full response instead of streaming
  --no-launch         Don't auto-launch Chrome (require it running)
  -h, --help          Show this help`);
      process.exit(0);
    }
  }
  return opts;
}

// ── Chrome lifecycle ──

function getChromePath() {
  if (process.platform === "darwin") {
    return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  }
  if (process.platform === "win32") {
    const candidates = [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    for (const p of candidates) {
      if (existsSync(p)) return p;
    }
    return "chrome.exe";
  }
  // Linux: try common paths, fall back to PATH lookup
  const linuxCandidates = [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ];
  for (const p of linuxCandidates) {
    if (existsSync(p)) return p;
  }
  return "google-chrome";
}

async function isChromeRunning(cdpPort) {
  try {
    const resp = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
    return resp.ok;
  } catch {
    return false;
  }
}

async function launchChrome(cdpPort) {
  const chromePath = getChromePath();

  if (!existsSync(chromePath)) {
    throw new Error(`Chrome not found at ${chromePath}. Please install Google Chrome.`);
  }

  process.stderr.write(`Launching Chrome: ${chromePath}\n`);
  process.stderr.write(`Flags: --remote-debugging-port=${cdpPort} --user-data-dir=${CHROME_USER_DATA_DIR}\n`);

  const proc = spawn(
    chromePath,
    [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${CHROME_USER_DATA_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-background-networking",
    ],
    { detached: true, stdio: "ignore" }
  );

  proc.unref();
  return proc;
}

async function waitForChrome(cdpPort, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isChromeRunning(cdpPort)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Timeout waiting for Chrome to start");
}

// ── Connect to Chrome ──

async function connectOrLaunch(opts) {
  const running = await isChromeRunning(opts.cdp);
  if (!running) {
    if (opts.noLaunch) {
      console.error("Chrome is not running and --no-launch is set. Start Chrome with:");
      console.error(`  "${getChromePath()}" --remote-debugging-port=${opts.cdp} --user-data-dir=${CHROME_USER_DATA_DIR}`);
      process.exit(1);
    }
    process.stderr.write(`Chrome not running on port ${opts.cdp}, launching...\n`);
    await launchChrome(opts.cdp);
    process.stderr.write("Waiting for Chrome to start...\n");
    await waitForChrome(opts.cdp);
  }

  process.stderr.write("Connecting to Chrome via CDP...\n");
  const browser = await puppeteer.connect({
    browserURL: `http://127.0.0.1:${opts.cdp}`,
    defaultViewport: null,
    protocolTimeout: 300_000,
  });
  return browser;
}

// ── Session init ──

async function initSession(page, port, config) {
  await page.goto(`http://localhost:${port}`, { timeout: 10_000 });

  const cfgArg = (config && (config.topK != null || config.temperature != null)) ? { topK: config.topK, temperature: config.temperature } : undefined;
  const result = await page.evaluate((cfg) => window.ensureSession(cfg), cfgArg);
  if (result.error) {
    throw new Error(`Failed to initialize model: [${result.step}] ${result.error}`);
  }

  const ctxWindow = result.contextWindow || 9216;
  const ctxUsage = result.contextUsage || 0;
  const pct = ctxWindow > 0 ? Math.round((ctxUsage / ctxWindow) * 100) : 0;
  process.stderr.write(`Model: Gemini Nano (via Chrome Prompt API)\n`);
  if (config) {
    const parts = [];
    if (config.topK != null) parts.push(`topK=${config.topK}`);
    if (config.temperature != null) parts.push(`temperature=${config.temperature}`);
    if (parts.length) process.stderr.write(`Config: ${parts.join(', ')}\n`);
  }
  process.stderr.write(`Context window: ${ctxUsage}/${ctxWindow} tokens (${pct}%)\n`);
  process.stderr.write("Ready. Type a prompt or /help for commands.\n");
}

// ── Prompt sending ──

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

async function sendPrompt(page, prompt, stream = true) {
  let frame = 0;
  process.stderr.write('\x1b[?25l'); // hide cursor
  const spinner = setInterval(() => {
    process.stderr.write(`\r\x1b[K${SPINNER[frame % SPINNER.length]} thinking...`);
    frame++;
  }, 120);
  let result;
  try {
    result = await page.evaluate(
      (p, s) => s ? window.promptSession(p) : window.promptSessionNonStreaming(p),
      prompt,
      stream,
    );
  } finally {
    clearInterval(spinner);
    process.stderr.write('\r\x1b[K'); // clear spinner line
    process.stderr.write('\x1b[?25h'); // show cursor
  }
  if (result.error) throw new Error(result.error);
  if (result.response) {
    process.stdout.write(marked.parse(result.response) + '\n');
  }
  return result;
}

function formatTime(ms) {
  if (ms >= 1000) return (ms / 1000).toFixed(1) + 's';
  return ms + 'ms';
}

// ── Interactive mode ──

async function interactiveMode(page, browser, opts, config) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = () => {
    rl.question('> ', async (input) => {
      input = input.trim();
      if (!input) {
        askQuestion();
        return;
      }

      // Handle commands
      if (input.startsWith('/')) {
        await handleCommand(input, page, browser, rl, config);
        askQuestion();
        return;
      }
      if (input === 'exit' || input === 'quit') {
        await cleanup(page, browser);
        rl.close();
        process.exit(0);
      }

      try {
        const result = await sendPrompt(page, input, opts.stream);
        const elapsed = result.elapsed || 0;
        const thinkMs = result.thinkMs || 0;
        const genMs = result.genMs || 0;
        const chars = result.response ? result.response.length : 0;
        const tokens = Math.round(chars / 4);
        const tokPerSec = genMs > 0 ? Math.round(tokens * 1000 / genMs) : 0;

        // Get context info for display
        let ctxStr = '';
        try {
          const ctx = await page.evaluate(() => window.getContextInfo());
          if (ctx.window > 0) {
            const pct = Math.round((ctx.usage / ctx.window) * 100);
            ctxStr = `context: ${pct}%`;
          }
        } catch { }

        process.stderr.write(
          `\n${formatTime(elapsed)}` +
          (thinkMs > 0 ? ` | prompt: ${formatTime(thinkMs)} | gen: ${formatTime(genMs)}, ~${tokens} tok (${tokPerSec} tok/s)` : ``) +
          (ctxStr ? ` | ${ctxStr}` : ``) +
          '\n'
        );
      } catch (e) {
        process.stderr.write(`Error: ${e.message}\n`);
      }
      askQuestion();
    });
  };

  process.stderr.write('Interactive mode. Type a prompt and press Enter. Type /help for commands.\n');
  askQuestion();
}

async function handleCommand(input, page, browser, rl, config) {
  const parts = input.slice(1).split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case 'help':
      console.log(`
Commands:
  /status              Show session stats
  /reset               Reset session (clear conversation history)
  /config <k> <v>      Set topK or temperature (recreates session)
  /exit                Exit gracefully (same as "exit")
  /quit                Exit gracefully (same as "quit")
  /help                Show this help

You can also type "exit" or "quit" to leave.
Conversation history persists across turns — use /reset to clear.`);
      break;
    case 'status':
      try {
        const ctx = await page.evaluate(() => window.getContextInfo());
        const stats = await page.evaluate(() => ({
          requests: window.stats?.requests || 0,
          lastPromptLen: window.stats?.lastPromptLen || 0,
          lastRespLen: window.stats?.lastRespLen || 0,
          lastTimeMs: window.stats?.lastTimeMs || 0,
          lastThinkMs: window.stats?.lastThinkMs || 0,
          lastGenMs: window.stats?.lastGenMs || 0,
          lastTokens: window.stats?.lastTokens || 0,
          lastTokensPerSec: window.stats?.lastTokensPerSec || 0,
          turnCount: window.turnCount || 0,
        }));
        const ctxPct = ctx.window > 0 ? Math.round((ctx.usage / ctx.window) * 100) : 0;
        console.log(`
Session Status
──────────────
Turns:       ${stats.requests}
Context:     ${ctx.usage}/${ctx.window} tokens (${ctxPct}%)
Last prompt: ${stats.lastPromptLen} chars
Last resp:   ${stats.lastRespLen} chars (~${stats.lastTokens} tok)
Total time:  ${formatTime(stats.lastTimeMs)}
Prompt:      ${formatTime(stats.lastThinkMs)}
Generation:  ${formatTime(stats.lastGenMs)} @ ${stats.lastTokensPerSec} tok/s`);
      } catch (e) {
        console.log(`Error getting status: ${e.message}`);
      }
      break;
    case 'reset':
      try {
        const cfg = (config.topK != null || config.temperature != null) ? { topK: config.topK, temperature: config.temperature } : undefined;
        const result = await page.evaluate((cfg) => window.resetSession(cfg), cfg);
        if (result.ready) {
          const ctx = result.contextWindow || 9216;
          const usage = result.contextUsage || 0;
          const pct = ctx > 0 ? Math.round((usage / ctx) * 100) : 0;
          console.log(`Session reset. Context: ${usage}/${ctx} tokens (${pct}%)`);
        } else {
          console.log(`Reset failed: ${result.error}`);
        }
      } catch (e) {
        console.log(`Error resetting session: ${e.message}`);
      }
      break;
    case 'config':
      {
        const param = parts[1]?.toLowerCase();
        const val = parts[2];
        if (!param || val == null) {
          console.log('Usage: /config <topK|temperature> <value>');
          if (!param) {
            const p = await page.evaluate(() => window.getModelParams());
            if (p) {
              console.log(`  topK: default=${p.defaultTopK}, max=${p.maxTopK}`);
              console.log(`  temperature: default=${p.defaultTemperature}, max=${p.maxTemperature}`);
            }
            console.log(`  Current: topK=${config.topK ?? '(default)'}, temperature=${config.temperature ?? '(default)'}`);
          }
          break;
        }
        const numVal = parseFloat(val);
        if (isNaN(numVal)) {
          console.log(`Invalid value: "${val}". Must be a number.`);
          break;
        }
        const p = await page.evaluate(() => window.getModelParams());
        if (param === 'topk' || param === 'top-k') {
          if (p && numVal < 1) {
            console.log(`topK must be >= 1 (got ${numVal})`);
            break;
          }
          if (p && numVal > p.maxTopK) {
            console.log(`topK must be <= ${p.maxTopK} (got ${numVal})`);
            break;
          }
          config.topK = numVal;
          console.log(`topK set to ${numVal}. Recreating session...`);
        } else if (param === 'temperature' || param === 'temp') {
          if (p && numVal < 0) {
            console.log(`Temperature must be >= 0 (got ${numVal})`);
            break;
          }
          if (p && numVal > p.maxTemperature) {
            console.log(`Temperature must be <= ${p.maxTemperature} (got ${numVal})`);
            break;
          }
          config.temperature = numVal;
          console.log(`Temperature set to ${numVal}. Recreating session...`);
        } else {
          console.log(`Unknown parameter: "${param}". Use topK or temperature.`);
          break;
        }
        const cfg = { topK: config.topK, temperature: config.temperature };
        const result = await page.evaluate((cfg) => window.resetSession(cfg), cfg);
        if (result.ready) {
          const ctx = result.contextWindow || 9216;
          const usage = result.contextUsage || 0;
          const pct = ctx > 0 ? Math.round((usage / ctx) * 100) : 0;
          console.log(`Session recreated. Context: ${usage}/${ctx} tokens (${pct}%)`);
        } else {
          console.log(`Failed: ${result.error}`);
        }
      }
      break;
    case 'exit':
    case 'quit':
      await cleanup(page, browser);
      rl.close();
      process.exit(0);
    default:
      console.log(`Unknown command: /${cmd}. Type /help for available commands.`);
  }
}

// ── Cleanup ──

async function cleanup(page, browser) {
  process.stderr.write('\nShutting down...\n');
  if (page) {
    try {
      await page.evaluate(() => {
        if (window.conversationSession) {
          try { window.conversationSession.destroy(); } catch (e) {}
          window.conversationSession = null;
        }
      });
      process.stderr.write('Session destroyed.\n');
    } catch (e) {
      process.stderr.write(`Session cleanup error: ${e.message}\n`);
    }
  }
  if (browser) {
    try {
      await browser.disconnect();
      process.stderr.write('Disconnected from Chrome.\n');
    } catch (e) {
      process.stderr.write(`Disconnect error: ${e.message}\n`);
    }
  }
}

// ── HTTP server (dashboard + OpenAI API) ──

function startServer(port, sessionManager) {
  const htmlPath = resolve(__dirname, 'page.html');
  let dashboardHtml;
  try {
    dashboardHtml = readFileSync(htmlPath, 'utf-8');
  } catch (e) {
    process.stderr.write(`Warning: could not read page.html: ${e.message}\n`);
  }

  const server = createServer(sessionManager, { port, dashboardHtml });

  return new Promise((resolve) => {
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        process.stderr.write(`Warning: port ${port} in use, server not available\n`);
        resolve(null);
      } else {
        throw err;
      }
    });
    server.listen(port, '127.0.0.1', () => {
      process.stderr.write(`Server: http://localhost:${port} (dashboard + OpenAI API)\n`);
      resolve(server);
    });
  });
}

// ── Main ──

async function main() {
  const opts = parseArgs();

  const browser = await connectOrLaunch(opts);
  const pages = await browser.pages();
  const page = pages[0] || await browser.newPage();

  page.on("pageerror", (err) => {
    process.stderr.write(`[browser] PAGE ERROR: ${err.message}\n`);
  });

  // Create session manager and start server (dashboard + OpenAI API)
  const sessionManager = new SessionManager(page, { port: opts.port });
  const httpServer = await startServer(opts.port, sessionManager);

  // Keep-alive to prevent CDP timeout
  const keepAlive = setInterval(async () => {
    try { await page.evaluate(() => true); } catch { clearInterval(keepAlive); }
  }, 15000);
  keepAlive.unref?.();

  // Graceful shutdown
  const shutdown = async () => {
    clearInterval(keepAlive);
    await cleanup(page, browser);
    if (httpServer) httpServer.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGHUP', shutdown);
  process.on('uncaughtException', (err) => {
    process.stderr.write(`Fatal: ${err.message}\n`);
    shutdown();
  });

  const modelConfig = { topK: opts.topK, temperature: opts.temperature };

  try {
    await initSession(page, opts.port, modelConfig);
  } catch (e) {
    clearInterval(keepAlive);
    process.stderr.write(`Error: ${e.message}\n`);
    process.stderr.write('Make sure Chrome flags are enabled:\n');
    process.stderr.write('  chrome://flags/#optimization-guide-on-device-model\n');
    process.stderr.write('  chrome://flags/#prompt-api-for-gemini-nano-multimodal-input\n');
    await cleanup(page, browser);
    if (httpServer) httpServer.close();
    process.exit(1);
  }

  if (opts.prompt) {
    try {
      await sendPrompt(page, opts.prompt, opts.stream);
    } catch (e) {
      process.stderr.write(`Error: ${e.message}\n`);
    }
    await cleanup(page, browser);
    if (httpServer) httpServer.close();
    process.exit(0);
  } else if (!process.stdin.isTTY) {
    // Pipe mode: read stdin, send as prompt, write response to stdout
    let input = '';
    process.stdin.setEncoding('utf-8');
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    input = input.trim();
    if (input) {
      try {
        const result = await sendPrompt(page, input, opts.stream);
        if (result.error) {
          process.stderr.write(`Error: ${result.error}\n`);
        }
      } catch (e) {
        process.stderr.write(`Error: ${e.message}\n`);
      }
    }
    await cleanup(page, browser);
    if (httpServer) httpServer.close();
    process.exit(0);
  } else {
    await interactiveMode(page, browser, opts, modelConfig);
  }
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
