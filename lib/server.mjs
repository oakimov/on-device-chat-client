import http from 'http';
import { createHash } from 'crypto';

const STREAM_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

const MAX_BODY_SIZE = 1024 * 1024; // 1MB
const REQUEST_TIMEOUT_MS = 120_000; // 2 minutes

function fingerprintClient(req) {
  const ip = req.socket?.remoteAddress || 'unknown';
  const ua = req.headers['user-agent'] || 'unknown';
  return createHash('sha256').update(ip + '|' + ua).digest('hex').slice(0, 12);
}

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

export function createServer(sessionManager, { dashboardHtml, corsOrigin } = {}) {
  let lastPromptTokens = 0;
  let lastCompletionTokens = 0;

  const server = http.createServer(async (req, res) => {
    // CORS headers
    const origin = corsOrigin || '*';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');

    // Handle preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

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
        // Reject oversized bodies before reading
        const contentLength = parseInt(req.headers['content-length'] || '0', 10);
        if (contentLength > MAX_BODY_SIZE) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Request body too large (max 1MB)', type: 'invalid_request_error' } }));
          return;
        }

        const chunks = [];
        let totalSize = 0;
        for await (const chunk of req) {
          totalSize += chunk.length;
          if (totalSize > MAX_BODY_SIZE) {
            req.destroy();
            res.writeHead(413, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Request body too large (max 1MB)', type: 'invalid_request_error' } }));
            return;
          }
          chunks.push(chunk);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString());
        await handleChatRequest(req, body, res);
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
        } else {
          try {
            writeSSE(res, {
              id: 'chatcmpl-' + Date.now(),
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: 'gemini-nano',
              choices: [{ index: 0, delta: { content: `Error: ${e.message}` }, finish_reason: 'stop' }],
            });
            res.end('data: [DONE]\n\n');
          } catch {}
        }
      }
      return;
    }

    // Not handled — return false so caller can try other handlers
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  async function handleChatRequest(req, body, res) {
    const timeoutId = setTimeout(() => {
      if (!res.headersSent) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Request timed out', type: 'timeout' } }));
      } else {
        try { res.end('data: [DONE]\n\n'); } catch {}
      }
    }, REQUEST_TIMEOUT_MS);

    try {
      const { messages, stream, model } = body;
      const isStreaming = stream === true;
      const modelName = model || 'gemini-nano';
      const chatId = 'chatcmpl-' + Date.now();
      const created = Math.floor(Date.now() / 1000);

      // Validate messages
      if (!Array.isArray(messages) || messages.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'messages must be a non-empty array', type: 'invalid_request_error' } }));
        return;
      }

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || typeof msg !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `messages[${i}] must be an object`, type: 'invalid_request_error' } }));
          return;
        }
        if (!['system', 'user', 'assistant'].includes(msg.role)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `messages[${i}].role must be one of 'system', 'user', 'assistant'`, type: 'invalid_request_error' } }));
          return;
        }
        if (msg.content !== undefined && typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `messages[${i}].content must be a string or array`, type: 'invalid_request_error' } }));
          return;
        }
      }

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

      // Use serialized prompt to prevent race conditions
      const config = {
        topK: body.top_k,
        temperature: body.temperature,
      };

      const sessionId = fingerprintClient(req);
      const result = await sessionManager.promptSerialized(systemPrompt, config, promptText, { stream: isStreaming, sessionId });

      if (result.error) {
        writeError(res, chatId, modelName, isStreaming, created, result.error);
        return;
      }

      const ctxInfo = result.ctxInfo || { usage: 0, window: 0 };
      const sessionResult = result.sessionResult || {};

      const preUsage = ctxInfo.usage || 0;
      const ctxWindow = ctxInfo.window || sessionResult.contextWindow || 9216;

      if (isStreaming) {
        res.writeHead(200, STREAM_HEADERS);
      }

      const responseText = result.response || '';
      lastCompletionTokens = Math.round(responseText.length / 4);

      // Estimate prompt tokens from context delta
      let postUsage = preUsage;
      try {
        const postCtx = await sessionManager.getContextInfo(sessionId);
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
    } finally {
      clearTimeout(timeoutId);
    }
  }

  function writeError(res, chatId, modelName, isStreaming, created, message) {
    const usage = makeUsage(lastPromptTokens, lastCompletionTokens);
    if (isStreaming) {
      if (!res.headersSent) res.writeHead(200, STREAM_HEADERS);
      writeSSE(res, {
        id: chatId, object: 'chat.completion.chunk', created, model: modelName,
        choices: [{ index: 0, delta: { content: `Error: ${message}` }, finish_reason: 'stop' }],
        usage,
      });
      res.end('data: [DONE]\n\n');
    } else {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message, type: 'server_error' } }));
    }
  }

  return server;
}
