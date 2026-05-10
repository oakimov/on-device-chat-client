import http from 'http';
import { randomBytes } from 'crypto';

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join('');
  }
  return '';
}

function messagesToPrompt(messages) {
  const parts = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const text = extractText(msg.content);
    if (!text) continue;
    if (msg.role === 'user') {
      parts.push(text);
    } else if (msg.role === 'assistant') {
      parts.push(text);
    }
  }
  return parts.join('\n\n');
}

function extractSystemPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'system') {
      return extractText(messages[i].content);
    }
  }
  return null;
}

function makeUsage(promptTokens, completionTokens) {
  return {
    prompt_tokens: promptTokens || 0,
    completion_tokens: completionTokens || 0,
    total_tokens: (promptTokens || 0) + (completionTokens || 0),
  };
}

function writeSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

export function createServer(sessionManager, { dashboardHtml } = {}) {
  let lastPromptTokens = 0;
  let lastCompletionTokens = 0;

  const server = http.createServer(async (req, res) => {
    // Serve dashboard page to Chrome
    if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml || '<html><body><h1>No dashboard configured</h1></body></html>');
      return;
    }

    if (req.url === '/favicon.ico') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.url === '/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.url === '/v1/models' && req.method === 'GET') {
      let contextInfo = { usage: 0, window: 0 };
      try {
        contextInfo = await sessionManager.getContextInfo();
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: [{
          id: 'gemini-nano',
          object: 'model',
          created: 1,
          owned_by: 'chrome',
          context_window: {
            context_window_size: contextInfo.window || 9216,
            current_usage: contextInfo.usage,
            used_percentage: contextInfo.window > 0
              ? Math.round((contextInfo.usage / contextInfo.window) * 100)
              : 0,
          },
        }],
      }));
      return;
    }

    if (req.url?.startsWith('/v1/models/') && req.method === 'GET') {
      const modelId = req.url.slice('/v1/models/'.length);
      let contextInfo = { usage: 0, window: 0 };
      try {
        contextInfo = await sessionManager.getContextInfo();
      } catch {}

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: modelId,
        type: 'model',
        display_name: 'Gemini Nano',
        created_at: '2024-05-14T00:00:00Z',
        max_input_tokens: contextInfo.window || 9216,
        max_tokens: 1200,
      }));
      return;
    }

    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        await handleChatRequest(body, res);
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        } else {
          try { res.end('data: [DONE]\n\n'); } catch {}
        }
      }
      return;
    }

    // Not handled — return false so caller can try other handlers
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  async function handleChatRequest(body, res) {
    const { messages, stream, model } = body;
    const isStreaming = stream === true;
    const modelName = model || 'gemini-nano';
    const chatId = 'chatcmpl-' + Date.now();
    const created = Math.floor(Date.now() / 1000);

    const systemPrompt = extractSystemPrompt(messages || []);
    const promptText = messagesToPrompt(messages || []);

    if (!promptText.trim()) {
      const emptyResp = {
        id: chatId, object: 'chat.completion', created, model: modelName,
        choices: [{ index: 0, message: { role: 'assistant', content: '' }, finish_reason: 'stop' }],
        usage: makeUsage(lastPromptTokens, lastCompletionTokens),
      };
      if (isStreaming) {
        res.writeHead(200, STREAM_HEADERS);
        writeSSE(res, { ...emptyResp, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        res.end('data: [DONE]\n\n');
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(emptyResp));
      }
      return;
    }

    // Ensure page is ready
    await sessionManager.ensureReady();

    // Ensure session exists with system prompt
    const config = {
      topK: body.top_k,
      temperature: body.temperature,
    };
    const sessionResult = await sessionManager.ensureSession(systemPrompt, config);
    if (sessionResult.error) {
      writeError(res, chatId, modelName, isStreaming, created, `[${sessionResult.step}] ${sessionResult.error}`);
      return;
    }

    // Auto-compact if near limit
    const ctxInfo = await sessionManager.checkAutoCompact(systemPrompt, config);

    // Track context for token estimation
    const preUsage = ctxInfo.usage || 0;
    const ctxWindow = ctxInfo.window || sessionResult.contextWindow || 9216;
    const usagePct = ctxWindow > 0 ? Math.round((preUsage / ctxWindow) * 100) : 0;
    if (usagePct > 0) {
      process.stderr.write(`[api] context: ${usagePct}% used\n`);
    }

    // Run the model
    if (isStreaming) {
      res.writeHead(200, STREAM_HEADERS);
    }

    // Send thinking heartbeat while model processes
    let thinkingTimer = null;
    if (isStreaming) {
      thinkingTimer = setInterval(() => {
        try {
          writeSSE(res, {
            id: chatId, object: 'chat.completion.chunk', created, model: modelName,
            choices: [{ index: 0, delta: {}, finish_reason: null }],
          });
        } catch {
          if (thinkingTimer) { clearInterval(thinkingTimer); thinkingTimer = null; }
        }
      }, 3000);
    }

    let result;
    try {
      result = await sessionManager.prompt(promptText, { stream: true });
    } catch (e) {
      if (thinkingTimer) clearInterval(thinkingTimer);
      writeError(res, chatId, modelName, isStreaming, created, e.message);
      return;
    }
    if (thinkingTimer) clearInterval(thinkingTimer);

    if (result.error) {
      writeError(res, chatId, modelName, isStreaming, created, result.error);
      return;
    }

    const responseText = result.response || '';
    lastCompletionTokens = Math.round(responseText.length / 4);

    // Estimate prompt tokens from context delta
    let postUsage = preUsage;
    try {
      const postCtx = await sessionManager.getContextInfo();
      postUsage = postCtx.usage || preUsage;
    } catch {}
    const deltaTokens = Math.max(0, postUsage - preUsage);
    lastPromptTokens = Math.max(0, deltaTokens - lastCompletionTokens);

    const usage = makeUsage(lastPromptTokens, lastCompletionTokens);

    if (isStreaming) {
      // Send content
      if (responseText) {
        writeSSE(res, {
          id: chatId, object: 'chat.completion.chunk', created, model: modelName,
          choices: [{ index: 0, delta: { role: 'assistant', content: responseText }, finish_reason: null }],
        });
      }
      // Send done
      writeSSE(res, {
        id: chatId, object: 'chat.completion.chunk', created, model: modelName,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage,
      });
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: chatId, object: 'chat.completion', created, model: modelName,
        choices: [{ index: 0, message: { role: 'assistant', content: responseText }, finish_reason: 'stop' }],
        usage,
      }));
    }
  }

  function writeError(res, chatId, modelName, isStreaming, created, message) {
    const usage = makeUsage(lastPromptTokens, lastCompletionTokens);
    if (isStreaming) {
      if (!res.headersSent) res.writeHead(200, STREAM_HEADERS);
      writeSSE(res, {
        id: chatId, object: 'chat.completion.chunk', created, model: modelName,
        choices: [{ index: 0, delta: { content: message }, finish_reason: 'error' }],
        usage,
      });
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: chatId, object: 'chat.completion', created, model: modelName,
        choices: [{ index: 0, message: { role: 'assistant', content: message }, finish_reason: 'error' }],
        usage,
      }));
    }
  }

  return server;
}
