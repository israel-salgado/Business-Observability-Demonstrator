/**
 * AI Generate Route — Proxies calls to GitHub Models API with OTel GenAI tracing
 * 
 * This route runs on the EC2 Express server where the OTel SDK is active,
 * so every call gets a proper GenAI span exported to Dynatrace AI Observability.
 * 
 * Endpoint: POST /api/ai-generate/github
 * Body: { prompt, model?, systemPrompt?, temperature?, maxTokens? }
 * Auth: GitHub PAT passed in x-github-token header or GITHUB_PAT env var
 */

import express from 'express';
import { trace, SpanKind, SpanStatusCode, metrics } from '@opentelemetry/api';

const router = express.Router();

// ── OTel GenAI instrumentation ───────────────────────────────────────────
const _tracer = trace.getTracer('bizobs-ai-engine', '2.0.0');
const _meter = metrics.getMeter('bizobs-ai-engine', '2.0.0');

const _tokenCounter = _meter.createCounter('gen_ai.client.token.usage', {
  description: 'Tokens consumed by LLM calls',
  unit: 'token',
});
const _durationHist = _meter.createHistogram('gen_ai.client.operation.duration', {
  description: 'Duration of LLM requests',
  unit: 'ms',
});
const _requestCounter = _meter.createCounter('gen_ai.client.operation.count', {
  description: 'Total LLM requests',
  unit: '{request}',
});

const GITHUB_MODELS_URL = 'https://models.inference.ai.azure.com/chat/completions';
const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434';
const OLLAMA_OBSERVER_MODEL = process.env.OLLAMA_OBSERVER_MODEL || process.env.OLLAMA_MODEL || 'llama3.2:1b';
const OLLAMA_OBSERVER_ENABLED = String(process.env.OLLAMA_OBSERVER_ENABLED || 'true').toLowerCase() !== 'false';
const DYNATRACE_ASSIST_MODEL = process.env.DYNATRACE_ASSIST_MODEL || 'gpt-4.1';

// ── Provider registry — agnostic AI backend ──────────────────────────────
// One place that knows how to talk to each supported provider. Adding a new
// OpenAI-compatible vendor needs no code change: pick "openai-compatible" and
// pass a baseUrl. Anthropic and Ollama use their own request/response shapes.
// fallbackModels stays within each provider's own family: falling back from
// Claude to gpt-4o would just 404 against api.anthropic.com. maxOutputTokens is
// a hard ceiling, since Anthropic caps output well below the OpenAI-shaped models.
const PROVIDER_REGISTRY = {
  'openai':            { baseUrl: 'https://api.openai.com/v1',              system: 'openai',            shape: 'openai',    fallbackModels: ['gpt-4o', 'gpt-4.1-mini'], maxOutputTokens: 16000 },
  'openai-compatible': { baseUrl: '',                                       system: 'openai_compatible', shape: 'openai',    fallbackModels: [],                         maxOutputTokens: 8000 },
  'azure-openai':      { baseUrl: '',                                       system: 'azure_openai',      shape: 'openai',    fallbackModels: [],                         maxOutputTokens: 16000 },
  'github-models':     { baseUrl: 'https://models.inference.ai.azure.com',  system: 'github_models',     shape: 'openai',    fallbackModels: ['gpt-4o', 'gpt-4.1-mini'], maxOutputTokens: 8000 },
  'anthropic':         { baseUrl: 'https://api.anthropic.com',              system: 'anthropic',         shape: 'anthropic', fallbackModels: ['claude-3-5-haiku-latest'], maxOutputTokens: 8192 },
  'ollama':            { baseUrl: OLLAMA_ENDPOINT,                          system: 'ollama',            shape: 'ollama',    fallbackModels: [],                         maxOutputTokens: 4096 },
};

function resolveProvider(provider) {
  const key = String(provider || 'github-models').toLowerCase().trim();
  return PROVIDER_REGISTRY[key] ? key : 'openai-compatible';
}

// Normalizes any provider call to a single result shape:
// { content, promptTokens, completionTokens, finishReason, responseModel, system }
async function callChatProvider({ provider, model, baseUrl, apiKey, systemPrompt, prompt, temperature, maxTokens, timeoutMs = 120000 }) {
  const key = resolveProvider(provider);
  const def = PROVIDER_REGISTRY[key];
  const base = String(baseUrl || def.baseUrl || '').replace(/\/+$/, '');
  const sys = systemPrompt || 'You are a helpful AI assistant. Follow the output format instructions exactly.';

  if (def.shape !== 'ollama' && !apiKey) {
    throw new Error(`API key required for provider "${key}".`);
  }
  if ((key === 'openai-compatible' || key === 'azure-openai') && !base) {
    throw new Error(`Base URL required for provider "${key}".`);
  }

  // ── Anthropic (Messages API) ──
  if (def.shape === 'anthropic') {
    const resp = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      },
      body: JSON.stringify({
        model,
        system: sys,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      const errText = json ? JSON.stringify(json).slice(0, 300) : `HTTP ${resp.status}`;
      const e = new Error(`Anthropic API error (${resp.status}): ${errText}`);
      e.statusCode = resp.status;
      throw e;
    }
    const content = (json?.content || []).filter(b => b?.type === 'text').map(b => b.text).join('') || '';
    return {
      content,
      promptTokens: json?.usage?.input_tokens || 0,
      completionTokens: json?.usage?.output_tokens || 0,
      finishReason: json?.stop_reason || 'stop',
      responseModel: json?.model || model,
      system: def.system,
    };
  }

  // ── Ollama (local, native chat API) ──
  if (def.shape === 'ollama') {
    const resp = await fetch(`${base}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: prompt },
        ],
        stream: false,
        options: { temperature, num_predict: maxTokens },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await resp.json().catch(() => null);
    if (!resp.ok) {
      const e = new Error(`Ollama error (${resp.status}): ${json ? JSON.stringify(json).slice(0, 200) : resp.status}`);
      e.statusCode = resp.status;
      throw e;
    }
    return {
      content: json?.message?.content || '',
      promptTokens: json?.prompt_eval_count || 0,
      completionTokens: json?.eval_count || 0,
      finishReason: json?.done_reason || 'stop',
      responseModel: json?.model || model,
      system: def.system,
    };
  }

  // ── OpenAI-compatible (OpenAI, Azure OpenAI, GitHub Models, OpenRouter, etc.) ──
  const resp = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: prompt },
      ],
      temperature,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await resp.json().catch(() => null);
  if (!resp.ok) {
    const errText = json ? JSON.stringify(json).slice(0, 300) : `HTTP ${resp.status}`;
    const e = new Error(`${def.system} API error (${resp.status}): ${errText}`);
    e.statusCode = resp.status;
    throw e;
  }
  const usage = json?.usage || {};
  return {
    content: json?.choices?.[0]?.message?.content || '',
    promptTokens: usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    finishReason: json?.choices?.[0]?.finish_reason || 'stop',
    responseModel: json?.model || model,
    system: def.system,
  };
}

// ── POST /api/ai-generate/dynatrace-assist ──────────────────────────────
// Model-backed assistant path used by Step 1 (C-Suite analysis).
router.post('/dynatrace-assist', async (req, res) => {
  const { prompt, model = DYNATRACE_ASSIST_MODEL } = req.body || {};
  if (!prompt) {
    return res.status(400).json({ success: false, error: 'prompt is required' });
  }

  const ghToken = req.headers['x-github-token'] || req.body.token || process.env.GITHUB_PAT;
  if (!ghToken) {
    return res.status(401).json({
      success: false,
      error: 'GitHub PAT required for assist generation. Configure GitHub credential in Settings.',
      code: 'NO_CREDENTIAL',
    });
  }

  const boundedPrompt = String(prompt).substring(0, 12000);
  const started = Date.now();

  try {
    const resp = await fetch(GITHUB_MODELS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ghToken}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content: 'You are Dynatrace Assist for executive journey analysis. Be specific, concise, and output practical C-Suite recommendations with named journey candidates.',
          },
          { role: 'user', content: boundedPrompt },
        ],
        temperature: 0.2,
        max_tokens: 2200,
      }),
      signal: AbortSignal.timeout(70000),
    });

    const result = await resp.json().catch(() => null);
    if (!resp.ok) {
      const errText = typeof result === 'object' && result ? JSON.stringify(result).slice(0, 500) : `HTTP ${resp.status}`;
      return res.status(resp.status || 500).json({
        success: false,
        error: `Dynatrace Assist generation failed (${resp.status}): ${errText}`,
        code: 'ASSIST_MODEL_FAILED',
      });
    }

    const content = result?.choices?.[0]?.message?.content;
    if (!content) {
      return res.status(502).json({
        success: false,
        error: 'Dynatrace Assist generation returned no content.',
        code: 'ASSIST_EMPTY',
      });
    }

    const usage = result?.usage || {};
    const durationMs = Date.now() - started;
    return res.json({
      success: true,
      data: {
        content,
        model,
        usage,
        genai: {
          system: 'dynatrace_assist',
          model,
          promptTokens: usage?.prompt_tokens || 0,
          completionTokens: usage?.completion_tokens || 0,
          totalTokens: usage?.total_tokens || 0,
          durationMs,
          finishReason: result?.choices?.[0]?.finish_reason || 'stop',
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message || 'Dynatrace Assist failed' });
  }
});

async function getOllamaObserverNote({ prompt, responseContent, sourceModel, durationMs, promptTokens, completionTokens }) {
  if (!OLLAMA_OBSERVER_ENABLED) return null;

  const observerPrompt = [
    'You are an observer of an AI call.',
    'Summarize the request/response in 2 short bullet points.',
    'Include: intent, output quality, and any obvious risk.',
    'Do not include markdown code fences.',
    '',
    `Source provider: GitHub Models`,
    `Source model: ${sourceModel}`,
    `Duration (ms): ${durationMs}`,
    `Input tokens: ${promptTokens}`,
    `Output tokens: ${completionTokens}`,
    '',
    `Prompt:\n${String(prompt || '').substring(0, 2000)}`,
    '',
    `Response:\n${String(responseContent || '').substring(0, 2000)}`,
  ].join('\n');

  const started = Date.now();
  const resp = await fetch(`${OLLAMA_ENDPOINT}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_OBSERVER_MODEL,
      prompt: observerPrompt,
      stream: false,
      options: { temperature: 0.1, num_predict: 180, num_ctx: 4096 },
    }),
    signal: AbortSignal.timeout(12000),
  });

  if (!resp.ok) return null;
  const result = await resp.json();
  return {
    provider: 'ollama',
    model: OLLAMA_OBSERVER_MODEL,
    durationMs: Date.now() - started,
    note: String(result?.response || '').trim(),
  };
}

// ── POST /api/ai-generate/github ─────────────────────────────────────────
router.post('/github', async (req, res) => {
  const {
    prompt,
    model = 'gpt-4.1',
    systemPrompt = 'You are a business analyst AI assistant. Follow the output format instructions exactly.',
    temperature = 0.7,
    maxTokens = 4096,
  } = req.body || {};

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'prompt is required' });
  }

  // Token from header, body, or env
  const ghToken = req.headers['x-github-token'] || req.body.token || process.env.GITHUB_PAT;
  if (!ghToken) {
    return res.status(401).json({
      success: false,
      error: 'GitHub PAT required. Pass via x-github-token header or set GITHUB_PAT env var.',
    });
  }

  const startTime = Date.now();
  const spanName = `chat ${model}`;

  // Create a parent GenAI span
  const span = _tracer.startSpan(spanName, {
    kind: SpanKind.CLIENT,
    attributes: {
      'gen_ai.system': 'github_models',
      'gen_ai.provider.name': 'github_models',
      'gen_ai.operation.name': 'chat',
      'gen_ai.operation.kind': 'chat',
      'gen_ai.request.model': model,
      'gen_ai.request.max_tokens': maxTokens,
      'gen_ai.request.temperature': temperature,
      'gen_ai.prompt.0.role': 'system',
      'gen_ai.prompt.0.content': systemPrompt.substring(0, 4096),
      'gen_ai.prompt.1.role': 'user',
      'gen_ai.prompt.1.content': prompt.substring(0, 4096),
      'server.address': 'models.inference.ai.azure.com',
      'server.port': 443,
    },
  });

  // Log prompt as span event (Dynatrace captures full event content)
  span.addEvent('gen_ai.content.prompt', {
    'gen_ai.prompt': JSON.stringify([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prompt.substring(0, 8192) },
    ]),
  });

  try {
    const resp = await fetch(GITHUB_MODELS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ghToken}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt },
        ],
        temperature,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(120000),
    });

    const durationMs = Date.now() - startTime;

    if (!resp.ok) {
      const errText = await resp.text();
      span.setAttributes({
        'gen_ai.response.duration_ms': durationMs,
        'gen_ai.response.status': `error_${resp.status}`,
      });
      span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${resp.status}` });
      span.end();

      // Record metrics for failed requests too
      const metricAttrs = {
        'gen_ai.system': 'github_models',
        'gen_ai.provider.name': 'github_models',
        'gen_ai.request.model': model,
        'gen_ai.operation.name': 'chat',
      };
      _durationHist.record(durationMs, metricAttrs);
      _requestCounter.add(1, { ...metricAttrs, 'gen_ai.response.status': 'error' });

      console.log('[GenAI Span]', JSON.stringify({
        operation: 'chat', system: 'github_models', model, status: 'error',
        http_status: resp.status, duration_ms: durationMs,
      }));

      if (resp.status === 401) {
        return res.status(401).json({ success: false, error: 'GitHub token invalid or expired', code: 'AUTH_FAILED' });
      }
      if (resp.status === 429) {
        return res.status(429).json({ success: false, error: 'Rate limit reached. Try again in a few minutes.', code: 'RATE_LIMITED' });
      }
      return res.status(resp.status).json({ success: false, error: `GitHub Models API error (${resp.status}): ${errText.slice(0, 200)}` });
    }

    const result = await resp.json();
    const durationFinal = Date.now() - startTime;
    const content = result.choices?.[0]?.message?.content || '';
    const usage = result.usage || {};
    const promptTokens = usage.prompt_tokens || 0;
    const completionTokens = usage.completion_tokens || 0;
    const finishReason = result.choices?.[0]?.finish_reason || 'unknown';

    // Set span attributes with response data
    span.setAttributes({
      'gen_ai.response.model': result.model || model,
      'gen_ai.usage.input_tokens': promptTokens,
      'gen_ai.usage.output_tokens': completionTokens,
      'gen_ai.usage.prompt_tokens': promptTokens,
      'gen_ai.usage.completion_tokens': completionTokens,
      'gen_ai.completion.0.role': 'assistant',
      'gen_ai.completion.0.content': content.substring(0, 4096),
      'gen_ai.response.finish_reason': finishReason,
      'gen_ai.response.duration_ms': durationFinal,
    });

    // Log completion as span event (full content for DT AI Observability)
    span.addEvent('gen_ai.content.completion', {
      'gen_ai.completion': JSON.stringify([
        { role: 'assistant', content: content.substring(0, 8192) },
      ]),
    });

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    // Call Ollama observer AFTER span.end() so its timeout can't pollute the GenAI span
    let ollamaObserver = null;
    try {
      ollamaObserver = await getOllamaObserverNote({
        prompt,
        responseContent: content,
        sourceModel: result.model || model,
        durationMs: durationFinal,
        promptTokens,
        completionTokens,
      });
    } catch (observerErr) {
      console.warn('[ai-generate] Ollama observer unavailable:', observerErr.message);
    }

    // Record OTel metrics
    const metricAttrs = {
      'gen_ai.system': 'github_models',
      'gen_ai.provider.name': 'github_models',
      'gen_ai.request.model': model,
      'gen_ai.operation.name': 'chat',
    };
    _tokenCounter.add(promptTokens, { ...metricAttrs, 'gen_ai.token.type': 'input' });
    _tokenCounter.add(completionTokens, { ...metricAttrs, 'gen_ai.token.type': 'output' });
    _durationHist.record(durationFinal, metricAttrs);
    _requestCounter.add(1, { ...metricAttrs, 'gen_ai.response.status': 'ok' });

    console.log('[GenAI Span]', JSON.stringify({
      operation: 'chat', system: 'github_models', model: result.model || model,
      prompt_tokens: promptTokens, completion_tokens: completionTokens,
      duration_ms: durationFinal, finish_reason: finishReason,
    }));

    return res.json({
      success: true,
      data: {
        content,
        model: result.model || model,
        usage,
        genai: {
          system: 'github_models',
          model: result.model || model,
          promptTokens,
          completionTokens,
          totalTokens: promptTokens + completionTokens,
          durationMs: durationFinal,
          finishReason,
        },
        ollamaObserver,
      },
    });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.setAttributes({ 'gen_ai.response.duration_ms': durationMs });
    span.end();

    console.error('[ai-generate] GitHub Models error:', err.message);
    return res.status(500).json({ success: false, error: err.message || 'AI generation failed' });
  }
});

// ── POST /api/ai-generate/complete ───────────────────────────────────────
// Provider-agnostic, OTel-traced chat completion. Used by the AppEngine app
// when the "trace AI calls" option is on, and always for Ollama (which the
// app can't reach directly). Body: { provider, model, baseUrl?, prompt,
// systemPrompt?, temperature?, maxTokens? }. API key via x-ai-api-key header.
router.post('/complete', async (req, res) => {
  const {
    provider = 'github-models',
    model,
    baseUrl,
    prompt,
    systemPrompt = 'You are a helpful AI assistant. Follow the output format instructions exactly.',
    temperature = 0.7,
    maxTokens = 4096,
  } = req.body || {};

  if (!prompt) return res.status(400).json({ success: false, error: 'prompt is required' });
  if (!model) return res.status(400).json({ success: false, error: 'model is required' });

  const apiKey = req.headers['x-ai-api-key'] || req.body.apiKey || req.headers['x-github-token'] || req.body.token;
  const providerKey = resolveProvider(provider);
  const def = PROVIDER_REGISTRY[providerKey];

  // Validate config up front. These can never succeed on retry, so catching them
  // here keeps the retry ladder below from burning attempts on them.
  if (def.shape !== 'ollama' && !apiKey) {
    return res.status(400).json({ success: false, error: `API key required for provider "${providerKey}".`, code: 'NO_CREDENTIAL' });
  }
  if ((providerKey === 'openai-compatible' || providerKey === 'azure-openai') && !String(baseUrl || def.baseUrl || '')) {
    return res.status(400).json({ success: false, error: `Base URL required for provider "${providerKey}".`, code: 'NO_BASE_URL' });
  }

  const serverAddress = (() => {
    try { return new URL(baseUrl || def.baseUrl).host; } catch { return def.system; }
  })();

  const startTime = Date.now();
  const span = _tracer.startSpan(`chat ${model}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'gen_ai.system': def.system,
      'gen_ai.provider.name': def.system,
      'gen_ai.operation.name': 'chat',
      'gen_ai.request.model': model,
      'gen_ai.request.max_tokens': maxTokens,
      'gen_ai.request.temperature': temperature,
      'gen_ai.prompt.0.role': 'system',
      'gen_ai.prompt.0.content': String(systemPrompt).substring(0, 4096),
      'gen_ai.prompt.1.role': 'user',
      'gen_ai.prompt.1.content': String(prompt).substring(0, 4096),
      'server.address': serverAddress,
    },
  });
  span.addEvent('gen_ai.content.prompt', {
    'gen_ai.prompt': JSON.stringify([
      { role: 'system', content: String(systemPrompt) },
      { role: 'user', content: String(prompt).substring(0, 8192) },
    ]),
  });

  // Retry ladder: each model gets a full and a compact profile before we swap
  // models, and 429s back off. Mirrors callAiProvider() in the AppEngine
  // function so both routes behave the same. The whole ladder lives inside one
  // span, and gen_ai.response.model records which model actually served it.
  const runLadder = async () => {
    const cappedMaxTokens = Math.min(maxTokens, def.maxOutputTokens || maxTokens);
    const profiles = [
      { maxTokens: cappedMaxTokens, timeoutMs: 120000, label: 'primary' },
      { maxTokens: Math.max(700, Math.floor(cappedMaxTokens * 0.6)), timeoutMs: 60000, label: 'compact' },
    ];
    const modelChain = [...new Set([model, ...(def.fallbackModels || [])])];
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let lastErr = null;

    for (const candidate of modelChain) {
      for (let p = 0; p < profiles.length; p++) {
        const profile = profiles[p];
        try {
          const out = await callChatProvider({
            provider: providerKey, model: candidate, baseUrl, apiKey, systemPrompt, prompt,
            temperature, maxTokens: profile.maxTokens, timeoutMs: profile.timeoutMs,
          });
          if (candidate !== model) {
            console.log(`[ai-generate] fallback succeeded on ${candidate} (requested ${model})`);
          }
          return out;
        } catch (err) {
          lastErr = err;
          const status = err?.statusCode || 0;
          const timedOut = /timed out|timeout|abort|signal/i.test(String(err?.message || ''));

          // Auth failures never recover by retrying or swapping models.
          if (status === 401 || status === 403) throw err;

          if (status === 429) {
            if (p < profiles.length - 1) {
              const waitMs = 1500 * (p + 1);
              console.warn(`[ai-generate] ${candidate} rate-limited, retrying compact in ${waitMs}ms`);
              await sleep(waitMs);
              continue;
            }
            console.warn(`[ai-generate] ${candidate} exhausted by rate limit, trying next model`);
            break;
          }

          // Model rejected outright: no point retrying it smaller.
          if (status === 400 || status === 404 || status === 422) {
            console.warn(`[ai-generate] ${candidate} rejected (${status}), trying next model`);
            break;
          }

          // Server-side or timeout: one compact retry, then next model.
          if (timedOut || status >= 500 || status === 0) {
            if (p < profiles.length - 1) {
              console.warn(`[ai-generate] ${candidate} ${profile.label} failed (${timedOut ? 'timeout' : status}), retrying compact`);
              continue;
            }
            break;
          }
          break;
        }
      }
    }
    throw lastErr || new Error('AI generation failed');
  };

  try {
    const out = await runLadder();
    const durationMs = Date.now() - startTime;

    span.setAttributes({
      'gen_ai.response.model': out.responseModel,
      'gen_ai.usage.input_tokens': out.promptTokens,
      'gen_ai.usage.output_tokens': out.completionTokens,
      'gen_ai.completion.0.role': 'assistant',
      'gen_ai.completion.0.content': String(out.content).substring(0, 4096),
      'gen_ai.response.finish_reason': out.finishReason,
      'gen_ai.response.duration_ms': durationMs,
    });
    span.addEvent('gen_ai.content.completion', {
      'gen_ai.completion': JSON.stringify([{ role: 'assistant', content: String(out.content).substring(0, 8192) }]),
    });
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();

    const metricAttrs = {
      'gen_ai.system': out.system,
      'gen_ai.provider.name': out.system,
      'gen_ai.request.model': model,
      'gen_ai.operation.name': 'chat',
    };
    _tokenCounter.add(out.promptTokens, { ...metricAttrs, 'gen_ai.token.type': 'input' });
    _tokenCounter.add(out.completionTokens, { ...metricAttrs, 'gen_ai.token.type': 'output' });
    _durationHist.record(durationMs, metricAttrs);
    _requestCounter.add(1, { ...metricAttrs, 'gen_ai.response.status': 'ok' });

    return res.json({
      success: true,
      data: {
        content: out.content,
        model: out.responseModel,
        usage: { prompt_tokens: out.promptTokens, completion_tokens: out.completionTokens, total_tokens: out.promptTokens + out.completionTokens },
        genai: {
          system: out.system,
          model: out.responseModel,
          promptTokens: out.promptTokens,
          completionTokens: out.completionTokens,
          totalTokens: out.promptTokens + out.completionTokens,
          durationMs,
          finishReason: out.finishReason,
        },
      },
    });
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const status = err?.statusCode || 500;
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.setAttributes({ 'gen_ai.response.duration_ms': durationMs, 'gen_ai.response.status': `error_${status}` });
    span.end();
    _requestCounter.add(1, {
      'gen_ai.system': def.system,
      'gen_ai.provider.name': def.system,
      'gen_ai.request.model': model,
      'gen_ai.operation.name': 'chat',
      'gen_ai.response.status': 'error',
    });
    console.error(`[ai-generate] ${def.system} error:`, err.message);
    // GEN_TIMEOUT and RATE_LIMITED are the codes the UI's retry loop keys on,
    // so keep them distinct from a generic provider failure.
    const timedOut = /timed out|timeout|abort|signal/i.test(String(err?.message || ''));
    const code = (status === 401 || status === 403) ? 'AUTH_FAILED'
      : status === 429 ? 'RATE_LIMITED'
      : timedOut ? 'GEN_TIMEOUT'
      : 'PROVIDER_FAILED';
    // Timeouts surface as 504 so the caller can distinguish them from a 500.
    const httpStatus = timedOut && status === 500 ? 504 : status;
    return res.status(httpStatus).json({ success: false, error: err.message || 'AI generation failed', code });
  }
});

// ── GET /api/ai-generate/models — informational model reference ──────────
// Informational only: any model string the configured provider accepts will
// work, so this is a convenience list rather than a constraint. Note the model
// IDs differ per provider: Anthropic's own API uses 'claude-3-5-sonnet-latest',
// while the same family is exposed as 'claude-3.5-sonnet' through GitHub Models.
router.get('/models', (_req, res) => {
  res.json({
    success: true,
    data: {
      // Per-provider retry/ceiling behaviour, derived from the registry.
      providers: Object.fromEntries(Object.entries(PROVIDER_REGISTRY).map(([id, d]) => [
        id,
        { shape: d.shape, fallbackModels: d.fallbackModels, maxOutputTokens: d.maxOutputTokens },
      ])),
      openai: [
        { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'OpenAI' },
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
        { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'OpenAI' },
      ],
      anthropic: [
        { id: 'claude-3-5-sonnet-latest', name: 'Claude 3.5 Sonnet', provider: 'Anthropic' },
        { id: 'claude-3-5-haiku-latest', name: 'Claude 3.5 Haiku', provider: 'Anthropic' },
      ],
      github_models: [
        { id: 'gpt-4.1', name: 'GPT-4.1', provider: 'OpenAI' },
        { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', provider: 'OpenAI' },
        { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', provider: 'OpenAI' },
        { id: 'gpt-4o', name: 'GPT-4o', provider: 'OpenAI' },
        { id: 'gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI' },
        { id: 'o4-mini', name: 'o4-mini', provider: 'OpenAI' },
        { id: 'o3-mini', name: 'o3-mini', provider: 'OpenAI' },
        { id: 'claude-sonnet-4', name: 'Claude Sonnet 4 (GitHub naming)', provider: 'Anthropic' },
        { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (GitHub naming)', provider: 'Anthropic' },
      ],
      ollama: [
        { id: process.env.OLLAMA_MODEL || 'llama3.2:1b', name: 'Llama 3.2 1B', provider: 'Ollama (local)' },
      ],
    },
  });
});

export default router;
