#!/usr/bin/env node

import puppeteer from 'puppeteer';
import { existsSync, readdirSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import readline from 'readline';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));

function getDefaultProfilePath() {
  if (process.platform === 'darwin') {
    return resolve(os.homedir(), 'Library/Application Support/Google/Chrome');
  }
  if (process.platform === 'win32') {
    return resolve(process.env.LOCALAPPDATA, 'Google/Chrome/User Data');
  }
  return null;
}

function findWeightsInProfile(profilePath) {
  if (!profilePath || !existsSync(profilePath)) return null;
  
  // Common relative paths for the on-device model
  const subdirs = [
    'OptGuideOnDeviceModel',
    'OptimizationGuidePredictionModels'
  ];

  for (const subdir of subdirs) {
    const fullPath = resolve(profilePath, subdir);
    if (!existsSync(fullPath)) continue;

    // Search for weights.bin in any versioned subdirectory
    const files = readdirSync(fullPath, { recursive: true });
    const weightsFile = files.find(f => f.endsWith('weights.bin'));
    if (weightsFile) {
      return resolve(fullPath, weightsFile);
    }
  }
  return null;
}

function getChromePath() {
  if (process.platform === 'darwin') {
    return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  }
  if (process.platform === 'win32') {
    const paths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    for (const p of paths) {
      if (existsSync(p)) return p;
    }
    return 'chrome.exe'; // fallback
  }
  return 'google-chrome'; // linux fallback
}

const CHROME_PATH = getChromePath();

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { prompt: null, stream: true, profile: getDefaultProfilePath(), modelPath: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prompt' && args[i + 1]) {
      opts.prompt = args[i + 1];
      i++;
    } else if (args[i] === '--profile' && args[i + 1]) {
      opts.profile = args[i + 1];
      i++;
    } else if (args[i] === '--model-path' && args[i + 1]) {
      opts.modelPath = args[i + 1];
      i++;
    } else if (args[i] === '--no-stream') {
      opts.stream = false;
    } else if (args[i] === '--help' || args[i] === '-h') {
      console.log(`Usage: node chat.mjs [options]

Options:
  --prompt <text>   Send a single prompt and exit
  --profile <path>  Use a specific Chrome profile
  --model-path <p>  Path to weights.bin (bypasses profile requirements)
  --no-stream       Wait for full response instead of streaming
  -h, --help        Show this help message

Without --prompt, runs in interactive mode (type prompts, press Enter).`);
      process.exit(0);
    }
  }
  return opts;
}

async function launchChrome(opts) {
  console.error('Attempting to connect to the running Chrome instance on port 9222...');
  try {
    const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222' });
    console.error('Successfully connected to the running Chrome instance.');
    browser.__isConnectedToExisting = true;
    return browser;
  } catch (connectErr) {
    console.error('Failed to connect to the existing Chrome instance.');
    console.error('Please ensure Chrome is running with the --remote-debugging-port=9222 and a non-default --user-data-dir flag.');
    console.error(`Example: "${CHROME_PATH}" --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug-profile`);
    process.exit(1);
  }
}

async function initSession(page) {
  const htmlPath = resolve(__dirname, 'page.html');
  await page.goto(pathToFileURL(htmlPath).href);

  const result = await page.evaluate(() => window.initModel());
  if (result.error) {
    throw new Error(`Failed to initialize model: ${result.error}`);
  }
  console.error('Model ready.');
}

async function sendPrompt(page, prompt, stream) {
  console.error(`Sending prompt: "${prompt}" (stream: ${stream})`);
  if (stream) {
    return sendPromptStreaming(page, prompt);
  }

  const result = await page.evaluate(
    (p) => window.sendPrompt(p),
    prompt,
  );
  if (result.error) {
    throw new Error(result.error);
  }
  return result.response;
}

async function sendPromptStreaming(page, prompt) {
  console.error('Starting stream in browser...');
  // Start the streaming prompt in the browser
  const streamDone = page.evaluate(
    (p) => window.sendPromptStreaming(p),
    prompt,
  );

  let lastChunkTime = 0;
  let fullResponse = '';

  // Poll for chunks until the stream completes
  while (true) {
    const state = await page.evaluate(() => ({
      chunk: window.__lastChunk || '',
      full: window.__fullResponse || '',
      ready: window.__chunkReady || 0,
    }));

    if (state.ready > lastChunkTime) {
      const newContent = state.full.slice(fullResponse.length);
      if (newContent) {
        process.stdout.write(newContent);
        fullResponse = state.full;
      }
      lastChunkTime = state.ready;
    }

    // Check if the evaluate has resolved
    const race = await Promise.race([
      streamDone.then(() => 'done'),
      new Promise((r) => setTimeout(() => r('wait'), 100)),
    ]);

    if (race === 'done') {
      // One final drain
      const finalState = await page.evaluate(() => ({
        full: window.__fullResponse || '',
      }));
      const remaining = finalState.full.slice(fullResponse.length);
      if (remaining) {
        process.stdout.write(remaining);
      }
      break;
    }
  }

  process.stdout.write('\n');
  return fullResponse;
}

async function interactiveMode(page, stream) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const askQuestion = () => {
    rl.question('> ', async (prompt) => {
      if (!prompt.trim()) {
        askQuestion();
        return;
      }
      if (prompt.trim() === 'exit' || prompt.trim() === 'quit') {
        rl.close();
        process.exit(0);
      }

      try {
        await sendPrompt(page, prompt, stream);
      } catch (e) {
        console.error(`Error: ${e.message}`);
      }
      askQuestion();
    });
  };

  console.error('Interactive mode. Type a prompt and press Enter. Type "exit" to quit.');
  askQuestion();
}

async function main() {
  const opts = parseArgs();

  let browser;
  console.error('Connecting to Chrome...');
  browser = await launchChrome(opts);

  let page;
  try {
    const pages = await browser.pages();
    page = pages[0] || await browser.newPage();
  } catch {
    page = await browser.newPage();
  }

  // Expose browser logs to the terminal
  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') {
      console.error(`[browser error] ${text}`);
    } else {
      console.error(`[browser] ${text}`);
    }
  });

  // Graceful shutdown
  const cleanup = async () => {
    console.error('\nShutting down...');
    try { 
      if (browser.__isConnectedToExisting) {
        browser.disconnect();
      } else {
        await browser.close(); 
      }
    } catch { }
    process.exit(0);
  };
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  try {
    console.error('Initializing model (this may take a moment)...');
    await initSession(page);
    console.error('Model initialized successfully.');
  } catch (e) {
    console.error(`Error: ${e.message}`);
    console.error('Make sure Chrome flags are enabled:');
    console.error('  chrome://flags/#optimization-guide-on-device-model');
    console.error('  chrome://flags/#prompt-api-for-gemini-nano-multimodal-input');
    if (browser.__isConnectedToExisting) browser.disconnect();
    else await browser.close();
    process.exit(1);
  }

  if (opts.prompt) {
    try {
      await sendPrompt(page, opts.prompt, opts.stream);
    } catch (e) {
      console.error(`Error: ${e.message}`);
    }
    if (browser.__isConnectedToExisting) browser.disconnect();
    else await browser.close();
  } else {
    await interactiveMode(page, opts.stream);
  }
}

main();
