/**
 * Serverless proxy function for Business Observability Demonstrator API calls.
 * Runs server-side to bypass browser CSP restrictions.
 */

import { edgeConnectClient } from '@dynatrace-sdk/client-app-engine-edge-connect';
import { workflowsClient } from '@dynatrace-sdk/client-automation';
import { settingsObjectsClient, credentialVaultClient } from '@dynatrace-sdk/client-classic-environment-v2';
import { documentsClient, environmentSharesClient } from '@dynatrace-sdk/client-document';
import { queryExecutionClient } from '@dynatrace-sdk/client-query';
import {
  buildDashboardGenerationPrompt,
  extractDashboardJson,
  validateDashboardJson,
} from './dashboard-generator';

interface ProxyPayload {
  action: 'simulate-journey' | 'simulate-vcarb-race' | 'vcarb-race-status' | 'stop-vcarb-race' | 'get-saved-config' | 'test-connection' | 'get-services' | 'stop-all-services' | 'stop-company-services' | 'get-dormant-services' | 'clear-dormant-services' | 'clear-company-dormant' | 'chaos-get-active' | 'chaos-get-recipes' | 'chaos-inject' | 'chaos-revert' | 'chaos-revert-all' | 'chaos-get-targeted' | 'chaos-remove-target' | 'chaos-smart' | 'ec-create' | 'ec-update-patterns' | 'detect-builtin-settings' | 'deploy-builtin-settings' | 'deploy-workflow' | 'debug-builtin-schema' | 'generate-dashboard' | 'generate-dashboard-async' | 'get-dashboard-status' | 'deploy-dashboard' | 'mcp-generate-deploy-dashboard' | 'generate-deploy-dashboard' | 'preflight-dtctl' | 'list-saved-dashboards' | 'load-saved-dashboard' | 'delete-saved-dashboard' | 'deploy-business-flow' | 'list-business-flows' | 'delete-business-flows' | 'generate-pdf' | 'generate-doc' | 'load-app-settings' | 'save-app-settings' | 'check-journey-assets' | 'create-notebook' | 'execute-dql' | 'demonstrator-ai-tiles' | 'demonstrator-tiles-status' | 'field-repo-get' | 'librarian-history' | 'librarian-stats' | 'librarian-analyze' | 'system-health' | 'system-cleanup' | 'dynatrace-assist-generate' | 'github-copilot-generate' | 'github-copilot-check-credential' | 'github-copilot-save-credential' | 'github-copilot-list-models' | 'ai-provider-status' | 'ai-provider-save-key' | 'github-journey-commit' | 'github-create-issue' | 'ui-audit' | 'repair-dashboard-sharing' | 'list-generated-dashboards' | 'delete-generated-dashboard' | 'transfer-dashboard-ownership';
  apiHost: string;
  apiPort: string;
  apiProtocol: string;
  userName?: string;
  userEmail?: string;
  body?: unknown;
}

// ── Grail Field Discovery: query which additionalfields.* exist for a company/journey ──
// Returns array of {name, type} objects — type is inferred from actual data values
async function discoverBizEventFieldsViaSDK(company: string, journeyType: string): Promise<{name: string, type: 'string'|'numeric', sampleValue?: string|number}[] | null> {
  try {
    const safeCompany = company.replace(/["\\]/g, '');
    const safeJourney = journeyType.replace(/["\\]/g, '');
    // Fetch recent bizevents WITHOUT a | fields clause — this returns ALL columns
    // including every additionalfields.* the customer has, no matter what they named them.
    // Use multiple records so sparse fields still get discovered.
    const dql = `fetch bizevents
| filter event.kind == "BIZ_EVENT"
| filter json.companyName == "${safeCompany}"
| filter json.journeyType == "${safeJourney}"
| sort timestamp desc
  | limit 5`;

    console.log(`[proxy-api] Discovering bizevent fields for ${company} / ${journeyType}...`);

    const queryResult = await queryExecutionClient.queryExecute({
      body: {
        query: dql,
        requestTimeoutMilliseconds: 15000,
        maxResultRecords: 5,
      },
    });

    const records = queryResult?.result?.records || [];
    if (records.length === 0) {
      console.log('[proxy-api] No bizevent records found for field discovery');
      return [];
    }

    // Extract field names, types, and sample values across sampled records.
    const discovered = new Map<string, {name: string, type: 'string'|'numeric', sampleValue?: string|number}>();
    for (const record of records) {
      if (!record || typeof record !== 'object') continue;
      for (const [key, value] of Object.entries(record)) {
        if (value === null || value === undefined || value === '' || !key.startsWith('additionalfields.')) continue;
        const fieldName = key.replace('additionalfields.', '');
        const strVal = String(value);
        const isNumeric = !isNaN(Number(strVal)) && strVal.trim() !== '';
        const existing = discovered.get(fieldName);
        if (!existing) {
          discovered.set(fieldName, {
            name: fieldName,
            type: isNumeric ? 'numeric' : 'string',
            sampleValue: isNumeric ? Number(strVal) : strVal,
          });
        } else if (existing.sampleValue === undefined) {
          existing.sampleValue = isNumeric ? Number(strVal) : strVal;
        }
      }
    }
    const result = Array.from(discovered.values());

    console.log(`[proxy-api] Discovered ${result.length} fields: ${result.map(f => `${f.name}(${f.type}=${f.sampleValue})`).join(', ')}`);
    return result;
  } catch (e: any) {
    console.warn(`[proxy-api] Field discovery error: ${e.message}`);
    return null;
  }
}

export default async function (payload: ProxyPayload) {
  if (!payload || !payload.action) {
    return { success: false, error: 'Missing action in payload' };
  }

  const { action, apiHost, apiPort, apiProtocol, body } = payload;
  const baseUrl = `${apiProtocol}://${apiHost}:${apiPort}`;

  const sanitizeAuditToken = (value?: string): string =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

  const bodyObj = (body && typeof body === 'object') ? (body as Record<string, unknown>) : {};
  const topLevelUserEmail = String(payload.userEmail || '').trim().toLowerCase();
  const topLevelUserName = String(payload.userName || '').trim();
  const journeyData = (bodyObj.journeyData && typeof bodyObj.journeyData === 'object') ? (bodyObj.journeyData as Record<string, unknown>) : {};
  const auditCompanyName = String(
    bodyObj.companyName ||
    bodyObj.company ||
    journeyData.companyName ||
    journeyData.company ||
    'Dynatrace Internal'
  ).trim() || 'Dynatrace Internal';
  const auditJourneyType = String(
    bodyObj.journeyType ||
    bodyObj.journey ||
    journeyData.journeyType ||
    journeyData.domain ||
    'Application Usage'
  ).trim() || 'Application Usage';
  const userEmail = String(topLevelUserEmail || bodyObj.userEmail || bodyObj.email || '').trim().toLowerCase();
  const userName = String(topLevelUserName || bodyObj.userName || (userEmail.includes('@') ? userEmail.split('@')[0] : 'unknown')).trim() || 'unknown';
  const requestedAuditFeature = String(bodyObj.feature || '').trim();
  const requestedAuditAction = String(bodyObj.auditAction || bodyObj.event || '').trim();
  const auditFeature = sanitizeAuditToken(requestedAuditFeature) || sanitizeAuditToken(action.split('-')[0]) || 'app';
  const auditAction = sanitizeAuditToken(requestedAuditAction) || sanitizeAuditToken(action) || 'request';
  const auditEventType = `bizevents.audit.usage.${auditFeature}.${auditAction}`;
  const shouldEmitUsageAudit = action === 'ui-audit';
  const pagePath = String(bodyObj.pagePath || bodyObj.page || '').trim();
  const pageQuery = String(bodyObj.pageQuery || '').trim();
  const targetPath = String(bodyObj.targetPath || '').trim();

  const emitProxyUsageAudit = async (stage: string, status: 'started' | 'success' | 'warning' | 'failure', httpStatus: number, errorMessage = ''): Promise<void> => {
    const payloadData = {
      companyName: auditCompanyName,
      journeyType: auditJourneyType,
      stepName: auditEventType,
      serviceName: 'BizObsAppEngineProxy',
      correlationId: '',
      domain: apiHost || 'unknown-host',
      eventType: auditEventType,
      userName,
      userEmail,
      feature: auditFeature,
      auditAction,
      pagePath,
      pageQuery,
      targetPath,
      journeyStatus: status === 'failure' ? 'Failed' : status === 'warning' ? 'Warning' : status === 'started' ? 'InProgress' : 'Success',
      additionalFields: {
        hasError: status === 'failure',
        auditStage: stage,
        auditStatus: status,
        httpStatus,
        action,
        apiHost,
        apiPort,
        apiProtocol,
        source: 'appengine-proxy',
        errorMessage,
        userName,
        userEmail,
        companyName: auditCompanyName,
        journeyType: auditJourneyType,
        feature: auditFeature,
        auditAction,
        pagePath,
        pageQuery,
        targetPath,
      },
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-biz-event-type': auditEventType,
      'x-biz-step-name': auditEventType,
      'x-biz-company-name': payloadData.companyName,
      'x-biz-journey-type': payloadData.journeyType,
      'x-biz-service-name': payloadData.serviceName,
      'x-biz-user-name': userName,
      'x-biz-user-email': userEmail,
      'x-biz-feature': auditFeature,
      'x-biz-additional-action': action.substring(0, 100),
      'x-biz-additional-audit-stage': stage.substring(0, 100),
      'x-biz-additional-audit-status': status,
      'x-biz-additional-http-status': String(httpStatus),
    };

    try {
      await fetch(`${baseUrl}/process`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payloadData),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Best effort only: action flow should never fail because audit emission failed
    }
  };

  // Best-effort EdgeConnect host-pattern registration.
  // This prevents traced EC2 calls from failing when the server host was configured
  // in the app but not yet added to EdgeConnect host patterns.
  const ensureEdgeConnectHostPattern = async (host?: string): Promise<boolean> => {
    if (!host || host === 'localhost' || host === '127.0.0.1') return false;
    try {
      const listResult = await edgeConnectClient.listEdgeConnects({ addFields: 'metadata' });
      const ecs = listResult.edgeConnects || [];
      if (ecs.length === 0) return false;

      const targetEc = ecs.find((ec: any) => (ec.metadata?.instances || []).length > 0) || ecs[0];
      const existing: string[] = targetEc.hostPatterns || [];
      if (existing.includes(host)) return false;

      await edgeConnectClient.updateEdgeConnect({
        edgeConnectId: targetEc.id!,
        body: { name: targetEc.name!, hostPatterns: [...existing, host] },
      });
      // Allow route propagation before first request.
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log(`[proxy-api] EdgeConnect host pattern auto-added: ${host}`);
      return true;
    } catch (ecErr: any) {
      console.error('[proxy-api] EdgeConnect host-pattern auto-register failed:', ecErr.message);
      return false;
    }
  };

  // Retry-aware fetch — handles EdgeConnect reconnection gaps (server disconnects every ~3 min)
  const fetchWithRetry = async (url: string, init?: RequestInit, attempts = 4, delayMs = 2000): Promise<Response> => {
    let lastErr: any;
    for (let i = 1; i <= attempts; i++) {
      try {
        const mergedHeaders = new Headers(init?.headers as HeadersInit | undefined);
        if (userEmail) mergedHeaders.set('x-user-email', userEmail);
        if (userName) mergedHeaders.set('x-user-name', userName);

        return await fetch(url, {
          ...init,
          headers: mergedHeaders,
          signal: init?.signal || AbortSignal.timeout(15000),
        });
      } catch (err: any) {
        lastErr = err;
        const msg = String(err?.message || '').toLowerCase();
        const isEC =
          msg.includes('connection error') ||
          msg.includes('edgeconnect') ||
          msg.includes('timed out') ||
          msg.includes('timeout') ||
          msg.includes('signal') ||
          msg.includes('abort');
        if (!isEC || i === attempts) throw err;
        console.warn(`[proxy-api] fetch retry ${i}/${attempts} for ${url}: ${err.message}`);
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  };

  // ════════════════════════════════════════════════════════════════════
  // Agnostic AI provider — config, key, allowlist, and one unified call.
  // Cloud providers are called directly from this app function; Ollama and
  // the optional "trace AI calls" mode are routed through the VM gateway.
  // ════════════════════════════════════════════════════════════════════
  type AiShape = 'openai' | 'anthropic' | 'ollama';
  interface AiProviderDef {
    baseUrl: string;
    host: string;
    shape: AiShape;
    system: string;
    defaultModel: string;
    // Models tried, in order, if the selected one is rejected or rate-limited.
    // Must stay within the provider's own family: falling back from Claude to
    // gpt-4o would just 404 on api.anthropic.com.
    fallbackModels: string[];
    // Hard ceiling on requested output tokens. Anthropic requires max_tokens and
    // caps output far below what the OpenAI-shaped models accept, so an
    // unclamped 7000-token dashboard request fails outright on Claude.
    maxOutputTokens: number;
  }
  const AI_PROVIDERS: Record<string, AiProviderDef> = {
    'openai':            { baseUrl: 'https://api.openai.com/v1',             host: 'api.openai.com',                shape: 'openai',    system: 'openai',            defaultModel: 'gpt-4.1',                  fallbackModels: ['gpt-4o', 'gpt-4.1-mini'],                    maxOutputTokens: 16000 },
    'openai-compatible': { baseUrl: '',                                      host: '',                              shape: 'openai',    system: 'openai_compatible', defaultModel: 'gpt-4.1',                  fallbackModels: [],                                            maxOutputTokens: 8000 },
    'azure-openai':      { baseUrl: '',                                      host: '',                              shape: 'openai',    system: 'azure_openai',      defaultModel: 'gpt-4.1',                  fallbackModels: [],                                            maxOutputTokens: 16000 },
    'github-models':     { baseUrl: 'https://models.inference.ai.azure.com', host: 'models.inference.ai.azure.com', shape: 'openai',    system: 'github_models',     defaultModel: 'gpt-4.1',                  fallbackModels: ['gpt-4o', 'gpt-4.1-mini'],                    maxOutputTokens: 8000 },
    'anthropic':         { baseUrl: 'https://api.anthropic.com',             host: 'api.anthropic.com',             shape: 'anthropic', system: 'anthropic',         defaultModel: 'claude-3-5-sonnet-latest', fallbackModels: ['claude-3-5-haiku-latest'],                   maxOutputTokens: 8192 },
    'ollama':            { baseUrl: '',                                      host: '',                              shape: 'ollama',    system: 'ollama',            defaultModel: 'llama3.2',                 fallbackModels: [],                                            maxOutputTokens: 4096 },
  };
  const AI_KEY_CREDENTIAL_NAME = 'bizobs-ai-provider-key';
  const LEGACY_GITHUB_CREDENTIAL_NAME = 'bizobs-github-pat';
  const AI_SETTINGS_DOC_CANDIDATES = ['bizobs-demonstrator-app-settings-v2', 'bizobs-demonstrator-app-settings'];

  const normalizeAiProvider = (p?: string): string => {
    const k = String(p || 'github-models').toLowerCase().trim();
    return AI_PROVIDERS[k] ? k : 'openai-compatible';
  };

  const hostOf = (url: string): string => { try { return new URL(url).host; } catch { return ''; } };

  // Reads provider/model/baseUrl/routeViaVm from the shared app-settings document.
  const loadAiConfig = async (): Promise<{ provider: string; model: string; baseUrl: string; routeViaVm: boolean }> => {
    let raw: any = {};
    for (const id of AI_SETTINGS_DOC_CANDIDATES) {
      try {
        const doc = await documentsClient.getDocument({ id });
        if (doc.content) { raw = JSON.parse(await doc.content.get('text')); break; }
      } catch { /* try next candidate */ }
    }
    const ai = (raw?.ai || raw?.aiProvider || {}) as Record<string, any>;
    const provider = normalizeAiProvider(ai.provider);
    const def = AI_PROVIDERS[provider];
    return {
      provider,
      model: String(ai.model || def.defaultModel),
      baseUrl: String(ai.baseUrl || def.baseUrl || ''),
      routeViaVm: ai.routeViaVm === true || provider === 'ollama',
    };
  };

  // Resolves the provider API key from the vault; falls back to the legacy GitHub PAT for github-models.
  const resolveAiApiKey = async (provider: string): Promise<string> => {
    const byName = async (name: string): Promise<string> => {
      try {
        const creds = await credentialVaultClient.listCredentials({ type: 'TOKEN' });
        const hit = (creds.credentials || []).find((c: any) => c.name === name);
        if (!hit) return '';
        const d = await credentialVaultClient.getCredentialsDetails({ id: hit.id });
        return String((d as any).token || '');
      } catch { return ''; }
    };
    let key = await byName(AI_KEY_CREDENTIAL_NAME);
    if (!key && provider === 'github-models') key = await byName(LEGACY_GITHUB_CREDENTIAL_NAME);
    return key;
  };

  // Ensures a host is in the AppEngine outbound allowlist (no-op if enforcement is off or already listed).
  const ensureOutboundHost = async (host: string): Promise<void> => {
    if (!host) return;
    try {
      const existing = await settingsObjectsClient.getSettingsObjects({
        schemaIds: 'builtin:dt-javascript-runtime.allowed-outbound-connections',
        fields: 'objectId,value', pageSize: 1,
      });
      const item = existing.items?.[0];
      const aoc = (item?.value as any)?.allowedOutboundConnections;
      if (aoc) {
        if (aoc.enforced === false) return;
        const hostList: string[] = aoc.hostList || [];
        if (hostList.includes(host)) return;
        await settingsObjectsClient.putSettingsObjectByObjectId({
          objectId: item!.objectId,
          body: { value: { allowedOutboundConnections: { enforced: aoc.enforced !== false, hostList: [...hostList, host] } } },
        });
      } else {
        await settingsObjectsClient.postSettingsObjects({
          body: [{
            schemaId: 'builtin:dt-javascript-runtime.allowed-outbound-connections',
            scope: 'environment',
            value: { allowedOutboundConnections: { enforced: true, hostList: [host] } },
          }],
        });
      }
    } catch (e: any) {
      console.warn('[proxy-api] ensureOutboundHost failed:', e?.message);
    }
  };

  // One unified provider call. Returns { success, data: { content, model, usage, genai }, ... }.
  const callAiProvider = async (args: {
    prompt: string;
    systemPrompt?: string;
    temperature?: number;
    maxTokens?: number;
    configOverride?: Partial<{ provider: string; model: string; baseUrl: string; routeViaVm: boolean }>;
  }): Promise<{ success: boolean; data?: any; error?: string; code?: string; routedVia?: string; details?: string }> => {
    const cfg = { ...(await loadAiConfig()), ...(args.configOverride || {}) };
    const provider = normalizeAiProvider(cfg.provider);
    const def = AI_PROVIDERS[provider];
    const base = String(cfg.baseUrl || def.baseUrl || '').replace(/\/+$/, '');
    const model = cfg.model || def.defaultModel;
    const systemPrompt = args.systemPrompt || 'You are a helpful AI assistant. Follow the output format instructions exactly.';
    const temperature = args.temperature ?? 0.4;
    const maxTokens = args.maxTokens ?? 2000;

    const apiKey = provider === 'ollama' ? '' : await resolveAiApiKey(provider);
    if (provider !== 'ollama' && !apiKey) {
      return { success: false, error: 'AI provider API key not configured. Open Settings → AI Provider.', code: 'NO_CREDENTIAL' };
    }
    if ((provider === 'openai-compatible' || provider === 'azure-openai') && !base) {
      return { success: false, error: 'Base URL is required for this provider. Set it in Settings → AI Provider.', code: 'NO_BASE_URL' };
    }

    const viaVm = cfg.routeViaVm || provider === 'ollama';

    // VM-traced path (OTel GenAI spans; required for Ollama since the app can't reach localhost).
    // fetchWithRetry covers transport-level retries; the VM gateway runs its own
    // model/profile ladder (see /api/ai-generate/complete), so we deliberately do
    // not also run the ladder here and multiply the attempts.
    if (viaVm) {
      try {
        const resp = await fetchWithRetry(`${baseUrl}/api/ai-generate/complete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(apiKey ? { 'x-ai-api-key': apiKey } : {}) },
          body: JSON.stringify({
            provider, model, baseUrl: base,
            prompt: args.prompt, systemPrompt, temperature,
            maxTokens: Math.min(maxTokens, def.maxOutputTokens),
          }),
          signal: AbortSignal.timeout(240000),
        }, 2, 1500);
        const json = await resp.json().catch(() => null);
        if (resp.ok && json?.success) return { ...json, routedVia: 'vm-traced' };
        const vmCode = json?.code
          || (resp.status === 401 || resp.status === 403 ? 'AUTH_FAILED' : resp.status === 429 ? 'RATE_LIMITED' : 'VM_GATEWAY_FAILED');
        return { success: false, error: json?.error || `VM AI gateway failed (${resp.status})`, code: vmCode, routedVia: 'vm-traced' };
      } catch (e: any) {
        const msg = String(e?.message || 'VM AI gateway unreachable');
        const timedOut = /timed out|timeout|abort|signal/i.test(msg);
        return { success: false, error: msg, code: timedOut ? 'GEN_TIMEOUT' : 'VM_UNREACHABLE', routedVia: 'vm-traced' };
      }
    }

    // Direct call from the app function — make sure the provider host is allowlisted first.
    await ensureOutboundHost(def.host || hostOf(base));

    // ── One attempt against one model with one token/timeout profile ──
    type AttemptOutcome =
      | { ok: true; data: any }
      | { ok: false; status: number; message: string; timedOut: boolean };

    const attempt = async (attemptModel: string, attemptMaxTokens: number, timeoutMs: number): Promise<AttemptOutcome> => {
      const started = Date.now();
      try {
        if (def.shape === 'anthropic') {
          const resp = await fetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: attemptModel, system: systemPrompt, messages: [{ role: 'user', content: args.prompt }], temperature, max_tokens: attemptMaxTokens }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          const json = await resp.json().catch(() => null);
          if (!resp.ok) {
            return { ok: false, status: resp.status, message: `Anthropic error (${resp.status}): ${json ? JSON.stringify(json).slice(0, 300) : resp.status}`, timedOut: false };
          }
          const content = (json?.content || []).filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('');
          const usage = json?.usage || {};
          return {
            ok: true,
            data: { content, model: json?.model || attemptModel, usage, genai: { system: def.system, model: json?.model || attemptModel, promptTokens: usage.input_tokens || 0, completionTokens: usage.output_tokens || 0, durationMs: Date.now() - started, finishReason: json?.stop_reason || 'stop' } },
          };
        }
        // OpenAI-compatible (OpenAI, Azure OpenAI, GitHub Models, OpenRouter, etc.)
        const resp = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
          body: JSON.stringify({ model: attemptModel, messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: args.prompt }], temperature, max_tokens: attemptMaxTokens }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const json = await resp.json().catch(() => null);
        if (!resp.ok) {
          return { ok: false, status: resp.status, message: `${def.system} error (${resp.status}): ${json ? JSON.stringify(json).slice(0, 300) : resp.status}`, timedOut: false };
        }
        const content = json?.choices?.[0]?.message?.content || '';
        const usage = json?.usage || {};
        return {
          ok: true,
          data: { content, model: json?.model || attemptModel, usage, genai: { system: def.system, model: json?.model || attemptModel, promptTokens: usage.prompt_tokens || 0, completionTokens: usage.completion_tokens || 0, durationMs: Date.now() - started, finishReason: json?.choices?.[0]?.finish_reason || 'stop' } },
        };
      } catch (e: any) {
        const msg = String(e?.message || 'AI request failed');
        const timedOut = /timed out|timeout|abort|signal/i.test(msg);
        return { ok: false, status: 0, message: msg, timedOut };
      }
    };

    // ── Retry ladder: models x profiles, with a wall-clock budget ──
    // Ordered so the chosen model gets both profiles before we swap models.
    // Clamped to the provider's output ceiling so a 7000-token dashboard
    // request doesn't get rejected outright by Claude.
    const primaryMaxTokens = Math.min(maxTokens, def.maxOutputTokens);
    const profiles = [
      { maxTokens: primaryMaxTokens, timeoutMs: 120000, label: 'primary' },
      { maxTokens: Math.max(700, Math.floor(primaryMaxTokens * 0.6)), timeoutMs: 60000, label: 'compact' },
    ];
    const modelChain = Array.from(new Set([model, ...def.fallbackModels]));

    // AppEngine functions have a finite execution window; stop starting new
    // attempts once we're close so we return a useful error instead of being killed.
    const ladderStarted = Date.now();
    const TOTAL_BUDGET_MS = 240000;
    const budgetLeft = () => TOTAL_BUDGET_MS - (Date.now() - ladderStarted);
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    let lastMessage = 'AI generation failed';
    let lastStatus = 0;
    let sawTimeout = false;
    let sawRateLimit = false;

    for (let m = 0; m < modelChain.length; m++) {
      const candidate = modelChain[m]!;
      for (let p = 0; p < profiles.length; p++) {
        const profile = profiles[p]!;
        if (budgetLeft() < 15000) {
          return {
            success: false,
            error: sawTimeout || sawRateLimit
              ? 'AI generation ran out of time after retries. Try again, or shorten the requirements/context.'
              : `${lastMessage}. Ran out of time before completing.`,
            code: 'GEN_TIMEOUT',
            routedVia: 'direct',
          };
        }

        const out = await attempt(candidate, profile.maxTokens, Math.min(profile.timeoutMs, Math.max(15000, budgetLeft() - 5000)));

        if (out.ok) {
          if (candidate !== model) {
            console.log(`[proxy-api] AI fallback succeeded on ${candidate} (requested ${model}, profile ${profile.label})`);
          }
          return { success: true, data: out.data, routedVia: 'direct' };
        }

        lastMessage = out.message;
        lastStatus = out.status;

        // Auth problems will never recover by retrying or swapping models.
        if (out.status === 401 || out.status === 403) {
          return {
            success: false,
            error: `${out.message}. Check the key in Settings → AI Provider.`,
            code: 'AUTH_FAILED',
            routedVia: 'direct',
          };
        }

        // Rate limited: back off, retry the compact profile, then move on to the next model.
        if (out.status === 429) {
          sawRateLimit = true;
          const hasAnotherProfile = p < profiles.length - 1;
          if (hasAnotherProfile) {
            const waitMs = Math.min(8000, 1500 * (p + 1));
            console.warn(`[proxy-api] ${candidate} rate-limited, retrying compact in ${waitMs}ms`);
            if (budgetLeft() > waitMs + 20000) { await sleep(waitMs); continue; }
          }
          console.warn(`[proxy-api] ${candidate} exhausted by rate limit, trying next model`);
          break;
        }

        // Model rejected (unknown name, bad request, unsupported params): next model.
        if (out.status === 400 || out.status === 404 || out.status === 422) {
          console.warn(`[proxy-api] ${candidate} rejected (${out.status}), trying next model`);
          break;
        }

        // Server-side or timeout: retry the same model compact, then next model.
        if (out.timedOut || out.status >= 500 || out.status === 0) {
          if (out.timedOut) sawTimeout = true;
          if (p < profiles.length - 1) {
            console.warn(`[proxy-api] ${candidate} ${profile.label} failed (${out.timedOut ? 'timeout' : out.status}), retrying compact`);
            continue;
          }
          break;
        }

        // Anything else is not obviously retryable.
        break;
      }
    }

    const exhaustedCode = sawTimeout ? 'GEN_TIMEOUT' : sawRateLimit ? 'RATE_LIMITED' : 'PROVIDER_FAILED';
    return {
      success: false,
      error: modelChain.length > 1
        ? `${lastMessage} (tried: ${modelChain.join(', ')})`
        : lastMessage,
      code: exhaustedCode,
      routedVia: 'direct',
      ...(lastStatus ? { details: `Last HTTP status ${lastStatus}` } : {}),
    };
  };

  // Deploy dashboard via Documents SDK so ownership is the active AppEngine principal.
  const deployDashboardWithDocumentsSdk = async (input: {
    dashboard: any;
    company?: string;
    journeyType?: string;
    userEmail?: string;
    userName?: string;
    generationMethod?: string;
  }): Promise<{
    success: boolean;
    data?: {
      dashboardId: string;
      dashboardName: string;
      dashboardUrl: string;
      alreadyExisted: boolean;
      method: string;
      tileCount: number;
    };
    error?: string;
    code?: number | string;
  }> => {
    const toSlug = (value?: string) =>
      String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
    const getErrorCode = (error: any): number | string | undefined =>
      error?.body?.error?.code || error?.statusCode || error?.code;
    const isNotFoundError = (error: any): boolean => {
      const code = getErrorCode(error);
      const msg = String(error?.message || '').toLowerCase();
      return code === 404 || error?.name === 'DocumentOrSnapshotNotFound' || msg.includes('not found');
    };

    try {
      const company = String(input.company || '').trim();
      const journeyType = String(input.journeyType || '').trim();
      const companySlug = toSlug(company);
      const journeySlug = toSlug(journeyType);

      const dashInput = input.dashboard || {};
      const dashboardName = String(
        dashInput?.name ||
        dashInput?.content?.name ||
        (company && journeyType ? `${company} - ${journeyType}` : 'Generated Dashboard')
      ).trim();

      const dashboardId = String(
        dashInput?.id ||
        dashInput?.content?.id ||
        (companySlug && journeySlug ? `bizobs-${companySlug}-${journeySlug}` : `bizobs-${toSlug(dashboardName)}`)
      ).trim();

      const rawContent = dashInput?.content?.tiles
        ? dashInput.content
        : (dashInput?.tiles ? dashInput : (dashInput?.content || dashInput));
      const contentWithMetadata = {
        ...rawContent,
        metadata: {
          ...(rawContent?.metadata || {}),
          companyName: company || undefined,
          journeyType: journeyType || undefined,
          generatedBy: 'appengine-documents-sdk',
          generationMethod: String(input.generationMethod || rawContent?.metadata?.generationMethod || 'copilot-appengine').trim(),
          createdByEmail: String(input.userEmail || '').trim() || undefined,
          createdByName: String(input.userName || '').trim() || undefined,
          generatedAt: new Date().toISOString(),
        },
      };

      const tileCount = Object.keys(contentWithMetadata?.tiles || {}).length;
      const blob = new Blob([JSON.stringify(contentWithMetadata)], { type: 'application/json' });
      let alreadyExisted = false;
      let dashboardIdFinal = dashboardId;

      try {
        const existing = await documentsClient.getDocument({ id: dashboardId });
        await documentsClient.updateDocument({
          id: dashboardId,
          optimisticLockingVersion: existing?.metadata?.version,
          body: {
            name: dashboardName,
            type: 'dashboard',
            content: blob,
            isPrivate: false,
          },
        });
        alreadyExisted = true;
      } catch (err: any) {
        if (!isNotFoundError(err)) {
          const code = getErrorCode(err);
          return {
            success: false,
            error: err?.message || 'Failed to update dashboard document',
            code,
          };
        }

        try {
          await documentsClient.createDocument({
            body: {
              id: dashboardId,
              name: dashboardName,
              type: 'dashboard',
              content: blob,
            },
          });
        } catch (createErr: any) {
          const createCode = getErrorCode(createErr);
          const createMsg = String(createErr?.message || '').toLowerCase();
          const idConflict = createCode === 409 || createMsg.includes('already exists') || createMsg.includes('document with id');
          if (!idConflict) {
            return {
              success: false,
              error: createErr?.message || 'Failed to create dashboard document',
              code: createCode,
            };
          }

          // Fallback for hidden/tombstoned/conflicting IDs that are not resolvable from this principal.
          const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
          dashboardIdFinal = `${dashboardId}-${suffix}`;
          await documentsClient.createDocument({
            body: {
              id: dashboardIdFinal,
              name: dashboardName,
              type: 'dashboard',
              content: blob,
            },
          });
        }
      }

      try {
        await environmentSharesClient.createEnvironmentShare({
          body: { documentId: dashboardIdFinal, access: 'read-write' },
        });
      } catch {
        // Share may already exist; ignore.
      }

      try {
        const created = await documentsClient.getDocument({ id: dashboardIdFinal });
        await documentsClient.updateDocument({
          id: dashboardIdFinal,
          optimisticLockingVersion: created?.metadata?.version,
          body: { isPrivate: false },
        });
      } catch {
        // Best-effort visibility update.
      }

      return {
        success: true,
        data: {
          dashboardId: dashboardIdFinal,
          dashboardName,
          dashboardUrl: `/ui/apps/dynatrace.dashboards/?query=${encodeURIComponent(dashboardIdFinal)}`,
          alreadyExisted,
          method: 'documents-sdk-user',
          tileCount,
        },
      };
    } catch (error: any) {
      const code = error?.body?.error?.code || error?.statusCode || error?.code;
      return { success: false, error: error?.message || 'Failed to deploy dashboard via Documents SDK', code };
    }
  };

  if (shouldEmitUsageAudit) {
    await emitProxyUsageAudit('requested', 'started', 202);
  }

  try {
    if (action === 'ui-audit') {
      await emitProxyUsageAudit('captured', 'success', 200);
      return { success: true, captured: true };
    }

    if (action === 'test-connection') {
      // Helper: attempt to reach the server (retries health endpoint before falling back)
      const tryHealth = async (): Promise<{ ok: true; status: number; message: string; callerIp: string | null; healthy: boolean } | { ok: false }> => {
        // Try /api/health up to 3 times (handles EdgeConnect reconnection gaps)
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const healthRes = await fetch(`${baseUrl}/api/health`, {
              method: 'GET',
              signal: AbortSignal.timeout(8000),
            });
            const healthData = await healthRes.json() as Record<string, unknown>;
            const callerIp = (healthData.callerIp as string) || null;
            return { ok: true, healthy: true, status: healthRes.status, message: `Server is running on ${apiHost}:${apiPort} (health: ${healthRes.status})`, callerIp };
          } catch {
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          }
        }
        // All health retries failed — try a simple connectivity check
        try {
          const fallbackRes = await fetch(`${baseUrl}/`, {
            method: 'GET',
            signal: AbortSignal.timeout(8000),
          });
          return { ok: true, healthy: fallbackRes.status >= 200 && fallbackRes.status < 400, status: fallbackRes.status, message: `Server reachable on ${apiHost}:${apiPort} but /api/health failed (status ${fallbackRes.status})`, callerIp: null };
        } catch {
          return { ok: false };
        }
      };

      // First attempt
      const first = await tryHealth();
      if (first.ok) {
        return { success: first.healthy, status: first.status, message: first.message, callerIp: first.callerIp };
      }

      // Connection failed — auto-register host pattern with EdgeConnect and retry
      let ecAutoRegistered = false;
      if (apiHost && apiHost !== 'localhost' && apiHost !== '127.0.0.1') {
        try {
          const listResult = await edgeConnectClient.listEdgeConnects({ addFields: 'metadata' });
          const ecs = listResult.edgeConnects || [];
          if (ecs.length > 0) {
            // Prefer online EdgeConnect, fallback to first
            const targetEc = ecs.find((ec: any) => (ec.metadata?.instances || []).length > 0) || ecs[0];
            const existing: string[] = targetEc.hostPatterns || [];
            if (!existing.includes(apiHost)) {
              await edgeConnectClient.updateEdgeConnect({
                edgeConnectId: targetEc.id!,
                body: { name: targetEc.name!, hostPatterns: [...existing, apiHost] },
              });
              // Wait for routing to propagate
              await new Promise(resolve => setTimeout(resolve, 3000));
              ecAutoRegistered = true;
            }
          }
        } catch (ecErr: any) {
          console.error('[proxy-api] EdgeConnect auto-register failed:', ecErr.message);
        }
      }

      // Retry after EdgeConnect registration
      if (ecAutoRegistered) {
        const retry = await tryHealth();
        if (retry.ok) {
          return {
            success: true,
            status: retry.status,
            message: `${retry.message} (auto-registered EdgeConnect host pattern)`,
            callerIp: retry.callerIp,
            ecAutoRegistered: true,
          };
        }
      }

      // Both attempts failed
      const ecHint = ecAutoRegistered
        ? 'EdgeConnect host pattern was auto-registered but routing may need a moment. Try again in 10-15 seconds.'
        : 'Ensure an EdgeConnect is created and running. The host IP must be registered as a host pattern on the EdgeConnect in Dynatrace.';
      return {
        success: false,
        error: `Cannot reach ${apiHost}:${apiPort}`,
        callerIp: null,
        ecAutoRegistered,
        details: `Could not reach ${baseUrl} through EdgeConnect. ${ecHint}`,
      };
    }

    if (action === 'get-services') {
      const mapLegacyServicesToChildServices = (services: any[]): any[] =>
        (services || []).map((svc: any) => ({
          service: svc.service || svc.serviceName || 'unknown',
          pid: svc.pid ?? null,
          port: svc.port ?? null,
          companyName: svc.companyName || svc.companyContext?.companyName || 'unknown',
          domain: svc.domain || svc.companyContext?.domain || null,
          industryType: svc.industryType || svc.companyContext?.industryType || null,
          journeyType: svc.journeyType || null,
          journeyDetail: svc.journeyDetail || null,
          stepName: svc.stepName || svc.baseServiceName || svc.service || svc.serviceName || 'unknown',
          baseServiceName: svc.baseServiceName || svc.stepName || svc.service || svc.serviceName || 'unknown',
          createdByUserEmail: svc.createdByUserEmail || null,
          createdByUserName: svc.createdByUserName || null,
          startTime: svc.startTime || null,
        }));

      try {
        const healthRes = await fetchWithRetry(`${baseUrl}/api/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(30000),
        });
        const data = await healthRes.json();

        if (Array.isArray(data?.childServices)) {
          return { success: healthRes.ok, status: healthRes.status, data };
        }

        if (Array.isArray(data?.services)) {
          return {
            success: healthRes.ok,
            status: healthRes.status,
            data: { ...data, childServices: mapLegacyServicesToChildServices(data.services) },
          };
        }
      } catch {
        // Fall through to admin endpoint compatibility checks.
      }

      try {
        const statusRes = await fetchWithRetry(`${baseUrl}/api/admin/services/status`, {
          method: 'GET',
          signal: AbortSignal.timeout(30000),
        });
        const statusData = await statusRes.json();
        if (Array.isArray(statusData?.services)) {
          return {
            success: statusRes.ok,
            status: statusRes.status,
            data: { childServices: mapLegacyServicesToChildServices(statusData.services), source: 'admin-services-status' },
          };
        }
      } catch {
        // Fall through to simplest endpoint.
      }

      const legacyRes = await fetchWithRetry(`${baseUrl}/api/admin/services`, {
        method: 'GET',
        signal: AbortSignal.timeout(30000),
      });
      const legacyData = await legacyRes.json();
      return {
        success: legacyRes.ok,
        status: legacyRes.status,
        data: {
          childServices: Array.isArray(legacyData?.services) ? mapLegacyServicesToChildServices(legacyData.services) : [],
          source: 'admin-services',
        },
      };
    }

    if (action === 'stop-all-services') {
      const res = await fetchWithRetry(`${baseUrl}/api/admin/services/stop-everything`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'stop-company-services') {
      const res = await fetchWithRetry(`${baseUrl}/api/admin/services/stop-by-company`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'get-dormant-services') {
      try {
        const res = await fetchWithRetry(`${baseUrl}/api/admin/services/dormant`, {
          method: 'GET',
          signal: AbortSignal.timeout(8000),
        });
        const data = await res.json();
        if (res.status === 404) {
          return { success: true, status: res.status, data: { dormantServices: [], count: 0, source: 'not-supported' } };
        }
        return { success: res.ok, status: res.status, data };
      } catch {
        // Older backend variants may not expose dormant endpoint.
        return { success: true, status: 200, data: { dormantServices: [], count: 0, source: 'fallback-empty' } };
      }
    }

    if (action === 'clear-dormant-services') {
      const res = await fetchWithRetry(`${baseUrl}/api/admin/services/clear-dormant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    if (action === 'clear-company-dormant') {
      const res = await fetchWithRetry(`${baseUrl}/api/admin/services/clear-dormant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    // ── Chaos Agent endpoints ──

    if (action === 'chaos-get-active') {
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/active`, { method: 'GET', signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      return { success: res.ok, status: res.status, data };
    }

    if (action === 'chaos-get-recipes') {
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/recipes`, { method: 'GET', signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      return { success: res.ok, status: res.status, data };
    }

    if (action === 'chaos-inject') {
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/inject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      const opSuccess = res.ok && !data?.error;
      return { success: opSuccess, status: res.status, data, error: opSuccess ? undefined : (data?.error || `Chaos inject failed (${res.status})`) };
    }

    if (action === 'chaos-revert') {
      const { faultId } = body as { faultId: string };
      const resolvedFaultId = String(faultId || '').trim();
      if (!resolvedFaultId) {
        return {
          success: false,
          status: 400,
          data: { success: false, error: 'Missing faultId' },
          error: 'Missing faultId for chaos-revert',
        };
      }
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/revert/${encodeURIComponent(resolvedFaultId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      const opSuccess = res.ok && data?.success !== false;
      return { success: opSuccess, status: res.status, data, error: opSuccess ? undefined : (data?.error || `Chaos revert failed (${res.status})`) };
    }

    if (action === 'chaos-revert-all') {
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/revert-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json();
      const failedCount = Number(data?.failed || 0);
      const opSuccess = res.ok && failedCount === 0;
      return { success: opSuccess, status: res.status, data, error: opSuccess ? undefined : (data?.error || `Chaos revert-all completed with ${failedCount} failures`) };
    }

    if (action === 'chaos-get-targeted') {
      const res = await fetchWithRetry(`${baseUrl}/api/feature_flag/services`, { method: 'GET', signal: AbortSignal.timeout(8000) });
      const data = await res.json();
      return { success: res.ok, status: res.status, data };
    }

    if (action === 'chaos-remove-target') {
      const { serviceName } = body as { serviceName: string };
      const res = await fetchWithRetry(`${baseUrl}/api/feature_flag/service/${encodeURIComponent(serviceName)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      const opSuccess = res.ok && data?.success !== false;
      return { success: opSuccess, status: res.status, data, error: opSuccess ? undefined : (data?.error || `Remove targeted override failed (${res.status})`) };
    }

    if (action === 'chaos-smart') {
      const res = await fetchWithRetry(`${baseUrl}/api/gremlin/smart`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });
      const data = await res.json();
      return { success: true, status: res.status, data };
    }

    // ── EdgeConnect creation via SDK (server-side, uses platform auth) ──

    if (action === 'ec-create') {
      const { oauthClientId, ecName, hostPatterns } = body as {
        oauthClientId?: string;
        ecName: string;
        hostPatterns: string[];
      };

      try {
        // If no oauthClientId provided, SDK auto-generates an environment-scoped OAuth client
        const createBody: { name: string; hostPatterns: string[]; oauthClientId?: string } = {
          name: ecName,
          hostPatterns,
        };
        if (oauthClientId) {
          createBody.oauthClientId = oauthClientId;
        }
        const result = await edgeConnectClient.createEdgeConnect({
          body: createBody,
        });
        return { success: true, data: result };
      } catch (sdkErr: any) {
        const errBody = sdkErr?.body || sdkErr;
        const detail = errBody?.error?.message || sdkErr?.message || 'Unknown SDK error';
        const missingScopes = errBody?.error?.details?.missingScopes;
        const scopeInfo = missingScopes?.length ? ` | Missing scopes: ${missingScopes.join(', ')}` : '';
        return {
          success: false,
          error: `SDK EdgeConnect create failed: ${detail}${scopeInfo}`,
          debug: { rawError: JSON.stringify(errBody, null, 2) },
        };
      }
    }

    // ── Update EdgeConnect host patterns (auto-register server IP for routing) ──

    if (action === 'ec-update-patterns') {
      const { hostPatterns } = body as { hostPatterns: string[] };
      if (!hostPatterns || hostPatterns.length === 0) {
        return { success: false, error: 'hostPatterns array is required' };
      }
      try {
        // List existing EdgeConnects to find one to update
        const listResult = await edgeConnectClient.listEdgeConnects({ addFields: 'metadata' });
        const ecs = listResult.edgeConnects || [];
        if (ecs.length === 0) {
          return { success: false, error: 'No EdgeConnects found. Create one first.' };
        }
        // Prefer the first online EdgeConnect, or just take the first one
        const onlineEc = ecs.find((ec: any) => (ec.metadata?.instances || []).length > 0) || ecs[0];
        const ecId = onlineEc.id;
        const ecName = onlineEc.name;
        const existingPatterns: string[] = onlineEc.hostPatterns || [];

        // Merge new patterns with existing (deduplicate)
        const merged = [...new Set([...existingPatterns, ...hostPatterns])];

        // Update the EdgeConnect with merged host patterns
        await edgeConnectClient.updateEdgeConnect({
          edgeConnectId: ecId,
          body: { name: ecName, hostPatterns: merged },
        });

        return {
          success: true,
          data: { ecId, ecName, hostPatterns: merged, added: hostPatterns.filter(p => !existingPatterns.includes(p)) },
        };
      } catch (sdkErr: any) {
        const errBody = sdkErr?.body || sdkErr;
        const detail = errBody?.error?.message || sdkErr?.message || 'Unknown SDK error';
        return { success: false, error: `Failed to update EdgeConnect patterns: ${detail}` };
      }
    }

    // ── Detect builtin Dynatrace settings for Get Started checklist ──
    if (action === 'detect-builtin-settings') {
      const detected: Record<string, boolean> = {};
      const hostIp = (body as any)?.hostIp as string | undefined;

      // 1. BizEvents HTTP incoming capture rule named "Business Observability Demonstrator"
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:bizevents.http.incoming',
          fields: 'objectId,value',
          pageSize: 50,
        });
        detected['biz-events'] = (result.items || []).some(
          (i: any) => i.value?.ruleName === 'Business Observability Demonstrator' || i.value?.ruleName === 'Business Outcome Engine' || i.value?.ruleName === 'Business Observability Generator' || i.value?.ruleName === 'BizObs App'
        );
      } catch { detected['biz-events'] = false; }

      // 2. OpenPipeline bizevents pipeline named "Business Observability Demonstrator"
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:openpipeline.bizevents.pipelines',
          fields: 'objectId,value',
          pageSize: 50,
        });
        detected['openpipeline'] = (result.items || []).some(
          (i: any) => i.value?.displayName === 'Business Observability Demonstrator' || i.value?.displayName === 'Business Outcome Engine' || i.value?.displayName === 'Business Observability Generator' || i.value?.displayName === 'BizObs Template Pipeline'
        );
      } catch { detected['openpipeline'] = false; }

      // 3. OpenPipeline bizevents routing — check for "Business Observability Demonstrator" entry
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:openpipeline.bizevents.routing',
          fields: 'objectId,value',
          pageSize: 10,
        });
        let hasRoute = false;
        for (const item of result.items || []) {
          const val = item.value as { routingEntries?: Array<{ description?: string }> };
          if (val.routingEntries?.some(e => e.description === 'Business Observability Demonstrator' || e.description === 'Business Outcome Engine' || e.description === 'Business Observability Generator' || e.description === 'BizObs App')) {
            hasRoute = true;
            break;
          }
        }
        detected['openpipeline-routing'] = hasRoute;
      } catch { detected['openpipeline-routing'] = false; }

      // 4. OneAgent feature flag SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING enabled
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:oneagent.features',
          fields: 'objectId,value',
          filter: "value.key = 'SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING'",
          pageSize: 1,
        });
        // Must exist AND have both enabled + instrumentation true
        const flagValue = result.items?.[0]?.value as Record<string, unknown> | undefined;
        detected['feature-flags'] = result.totalCount > 0 && flagValue?.enabled === true && flagValue?.instrumentation === true;
      } catch { detected['feature-flags'] = false; }

      // 5. OneAgent installed on host — DQL query using matchesPhrase for the configured IP
      if (hostIp) {
        try {
          const dqlQuery = `fetch dt.entity.host
| fields ipAddress
| filter matchesPhrase(ipAddress,"${hostIp}")
| filter isNotNull(ipAddress)
| summarize OneAgentDeployed = count()`;
          console.log(`[detect] OneAgent DQL: ${dqlQuery}`);
          const queryResult = await queryExecutionClient.queryExecute({
            body: {
              query: dqlQuery,
              requestTimeoutMilliseconds: 15000,
              maxResultRecords: 1,
            },
          });
          const records = queryResult?.result?.records || [];
          const count = Number(records[0]?.OneAgentDeployed ?? 0);
          console.log(`[detect] OneAgent count for ${hostIp}: ${count}`);
          detected['oneagent'] = count > 0;
        } catch (e: any) { console.log(`[detect] OneAgent DQL error: ${e.message}`); detected['oneagent'] = false; }
      } else {
        console.log('[detect] No hostIp provided, skipping OneAgent check');
        detected['oneagent'] = false;
      }

      // 6. EdgeConnect deployed and online — check via EdgeConnect SDK
      try {
        const ecList = await edgeConnectClient.listEdgeConnects({ addFields: 'metadata' });
        const ecItems = ecList.edgeConnects || [];
        detected['edgeconnect-create'] = ecItems.length > 0;
        const anyWithInstances = ecItems.some(
          (ec: any) => (ec.metadata?.instances || []).length > 0
        );
        detected['edgeconnect-deploy'] = anyWithInstances;
        detected['edgeconnect-online'] = anyWithInstances;
      } catch {
        detected['edgeconnect-create'] = false;
        detected['edgeconnect-deploy'] = false;
        detected['edgeconnect-online'] = false;
      }

      // 7. EdgeConnect connectivity + test-connection — ping the configured host from serverless
      //    If the fetch succeeds, EdgeConnect routing works AND connection is verified.
      if (apiHost && apiPort) {
        try {
          const proto = apiProtocol || 'http';
          const pingUrl = `${proto}://${apiHost}:${apiPort}/api/health`;
          console.log(`[detect] Pinging ${pingUrl}...`);
          const pingRes = await fetchWithRetry(pingUrl, {
            method: 'GET',
            signal: AbortSignal.timeout(6000),
          });
          const reachable = pingRes.ok || pingRes.status > 0;
          console.log(`[detect] Ping result: status=${pingRes.status}, reachable=${reachable}`);
          detected['outbound-connections'] = reachable;
          detected['test-connection'] = reachable;
        } catch (e: any) {
          console.log(`[detect] Ping failed: ${e.message}`);
          detected['outbound-connections'] = false;
          detected['test-connection'] = false;
        }
      } else {
        console.log(`[detect] No apiHost/apiPort — skipping ping`);
        detected['outbound-connections'] = false;
        detected['test-connection'] = false;
      }

      // 8. Automation Workflow — search for "BizObs Fix-It Agent" workflow
      try {
        const wfList = await workflowsClient.getWorkflows({
          search: 'BizObs Fix-It Agent',
        });
        detected['automation-workflow'] = (wfList.results || []).some(
          (wf: any) => wf.title?.includes('BizObs Fix-It Agent')
        );
      } catch (e: any) {
        console.log(`[detect] Workflow detection error: ${e.message}`);
        detected['automation-workflow'] = false;
      }

      // 9. Outbound connections allowlist — check if GitHub Models host is allowed
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:dt-javascript-runtime.allowed-outbound-connections',
          fields: 'objectId,value',
          pageSize: 1,
        });
        const item = result.items?.[0];
        const aoc = (item?.value as any)?.allowedOutboundConnections;
        if (aoc) {
          // If enforcement is disabled, all hosts are allowed
          if (aoc.enforced === false) {
            detected['outbound-github-models'] = true;
          } else {
            const hostList: string[] = aoc.hostList || [];
            detected['outbound-github-models'] = hostList.includes('models.inference.ai.azure.com');
          }
        } else {
          detected['outbound-github-models'] = false;
        }
      } catch (e: any) {
        console.log(`[detect] Outbound allowlist detection error: ${e.message}`);
        detected['outbound-github-models'] = false;
      }

      return { success: true, data: detected };
    }

    // ── Deploy builtin Dynatrace settings for BizObs ──
    if (action === 'debug-builtin-schema') {
      const debugResults: Record<string, unknown> = {};
      
      // 1. Fetch existing pipelines from BOTH schema variants
      for (const schemaId of ['builtin:openpipeline.bizevents.pipelines', 'builtin:openpipeline.events.pipelines']) {
        const key = schemaId.includes('bizevents') ? 'pipelines-bizevents' : 'pipelines-events';
        try {
          const result = await settingsObjectsClient.getSettingsObjects({
            schemaIds: schemaId,
            pageSize: 10,
          });
          debugResults[key] = { totalCount: result.totalCount, items: result.items?.map(i => ({ objectId: i.objectId, schemaVersion: i.schemaVersion, value: i.value })) };
        } catch (err: any) {
          debugResults[key] = { error: err?.message, body: err?.body };
        }
      }

      // 2. Fetch existing routing from BOTH variants
      for (const schemaId of ['builtin:openpipeline.bizevents.routing', 'builtin:openpipeline.events.routing']) {
        const key = schemaId.includes('bizevents') ? 'routing-bizevents' : 'routing-events';
        try {
          const result = await settingsObjectsClient.getSettingsObjects({
            schemaIds: schemaId,
            pageSize: 10,
          });
          debugResults[key] = { totalCount: result.totalCount, items: result.items?.map(i => ({ objectId: i.objectId, schemaVersion: i.schemaVersion, value: i.value })) };
        } catch (err: any) {
          debugResults[key] = { error: err?.message, body: err?.body };
        }
      }

      // 3. Validate-only POST with our pipeline schema against BOTH variants
      const pipelineValue = {
        displayName: 'BizObs Debug Test Pipeline',
        enabled: true,
        processors: [
          {
            id: 'debug-test-processor',
            displayName: 'Debug Test',
            enabled: true,
            type: 'dql',
            matcher: 'true',
            dqlScript: 'fieldsAdd test = "debug"',
          },
        ],
      };
      // Also try with id field
      const pipelineValueWithId = { id: 'debug-test-pipeline', ...pipelineValue };

      for (const schemaId of ['builtin:openpipeline.bizevents.pipelines', 'builtin:openpipeline.events.pipelines']) {
        const variant = schemaId.includes('bizevents') ? 'bizevents' : 'events';
        
        // Without id
        try {
          await settingsObjectsClient.postSettingsObjects({
            validateOnly: true,
            body: [{ schemaId, scope: 'environment', value: pipelineValue }],
          });
          debugResults[`validate-${variant}-no-id`] = { valid: true };
        } catch (err: any) {
          debugResults[`validate-${variant}-no-id`] = { valid: false, error: err?.message, body: err?.body ? JSON.stringify(err.body) : undefined };
        }

        // With id
        try {
          await settingsObjectsClient.postSettingsObjects({
            validateOnly: true,
            body: [{ schemaId, scope: 'environment', value: pipelineValueWithId }],
          });
          debugResults[`validate-${variant}-with-id`] = { valid: true };
        } catch (err: any) {
          debugResults[`validate-${variant}-with-id`] = { valid: false, error: err?.message, body: err?.body ? JSON.stringify(err.body) : undefined };
        }
      }

      // 4. Fetch capture rules
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'builtin:bizevents.http.incoming',
          pageSize: 10,
        });
        debugResults['captureRules'] = { totalCount: result.totalCount, items: result.items?.map(i => ({ objectId: i.objectId, schemaVersion: i.schemaVersion, value: i.value })) };
      } catch (err: any) {
        debugResults['captureRules'] = { error: err?.message, body: err?.body };
      }

      // 5. OpenPipeline Configuration API URL probe — test several candidates
      const opUrlCandidates = [
        '/platform/classic/environment-api/v2/openpipeline/configurations/bizevents',
        '/platform/classic/environment-api/v2/openpipeline/configurations/events',
        '/platform/classic/environment-api/v2/openpipeline/bizevents',
        '/api/v2/openpipeline/configurations/bizevents',
        '/api/v2/openpipeline/configurations/events',
        '/platform/openpipeline/v1/configurations/bizevents',
        '/platform/openpipeline/v1/configurations/events',
        '/platform/classic/environment-api/v2/openpipeline',
      ];
      const probeResults: Record<string, unknown> = {};
      for (const url of opUrlCandidates) {
        try {
          const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
          const text = await res.text();
          const preview = text.substring(0, 300);
          probeResults[url] = { status: res.status, preview };
        } catch (e: any) {
          probeResults[url] = { error: e.message };
        }
      }
      debugResults['openpipeline-url-probe'] = probeResults;

      return { success: true, data: debugResults };
    }

    if (action === 'deploy-builtin-settings') {
      const { configs } = body as { configs: string[] };
      if (!configs || !Array.isArray(configs) || configs.length === 0) {
        return { success: false, error: 'No configs specified to deploy' };
      }

      const results: Record<string, { success: boolean; error?: string }> = {};

      for (const configKey of configs) {
        try {
          if (configKey === 'biz-events') {
            // Check if capture rule already exists — skip if found
            const existing = await settingsObjectsClient.getSettingsObjects({
              schemaIds: 'builtin:bizevents.http.incoming',
              fields: 'objectId,value',
              pageSize: 50,
            });
            const captureExists = (existing.items || []).some(
              (i: any) => i.value?.ruleName === 'Business Observability Demonstrator' || i.value?.ruleName === 'Business Outcome Engine' || i.value?.ruleName === 'Business Observability Generator' || i.value?.ruleName === 'BizObs App'
            );

            if (captureExists) {
              results['biz-events'] = { success: true, error: 'Already exists — no changes needed' };
            } else {
              // Create from scratch matching the exact working tenant config
              await settingsObjectsClient.postSettingsObjects({
                body: [{
                  schemaId: 'builtin:bizevents.http.incoming',
                  scope: 'environment',
                  value: {
                    enabled: true,
                    ruleName: 'Business Observability Demonstrator',
                    triggers: [{
                      caseSensitive: false,
                      source: { dataSource: 'request.path' },
                      type: 'STARTS_WITH',
                      value: '/process',
                    }],
                    event: {
                      category: { sourceType: 'constant.string', source: 'Business Observability Demonstrator' },
                      provider: { sourceType: 'request.body', path: 'companyName' },
                      type: { sourceType: 'request.body', path: 'stepName' },
                      data: [
                        { name: 'HasError', source: { sourceType: 'request.body', path: 'json.hasError' } },
                        { name: 'rsBody', source: { sourceType: 'response.body', path: '*' } },
                        { name: 'rqBody', source: { sourceType: 'request.body', path: '*' } },
                      ],
                    },
                  },
                }],
              });
              results['biz-events'] = { success: true };
            }

          } else if (configKey === 'openpipeline') {
            // Create FULL pipeline via Settings API (bizevents.pipelines)
            // Includes processors, costAllocation, and all section arrays — matching exact tenant config

            // Check if already exists — search both top-level value and nested pipelines arrays
            const existingPipeline = await settingsObjectsClient.getSettingsObjects({
              schemaIds: 'builtin:openpipeline.bizevents.pipelines',
              pageSize: 50,
            });
            const matchNames = ['bizobs-template-pipeline'];
            const matchDisplayNames = ['Business Observability Demonstrator', 'Business Outcome Engine', 'Business Observability Generator', 'BizObs Template Pipeline'];
            const matchingPipeline = (existingPipeline.items || []).find((i: any) => {
              const v = i.value;
              if (!v) return false;
              // Direct match on the settings object value
              if (matchNames.includes(v.customId) || matchDisplayNames.includes(v.displayName)) return true;
              // Some schemas nest pipelines in an array inside the value
              const nested = v.pipelines || v.items || [];
              return nested.some((p: any) => matchNames.includes(p.customId) || matchDisplayNames.includes(p.displayName));
            });

            if (matchingPipeline) {
              results['openpipeline'] = { success: true, error: 'Already exists — no changes needed' };
            } else {
              // Create the full pipeline with processors, costAllocation, and all sections
              try {
              const pipelineResponse = await settingsObjectsClient.postSettingsObjects({
                body: [{
                  schemaId: 'builtin:openpipeline.bizevents.pipelines',
                  scope: 'environment',
                  value: {
                    metadataList: [],
                    customId: 'bizobs-template-pipeline',
                    displayName: 'Business Observability Demonstrator',
                    processing: {
                      processors: [
                        {
                          id: 'processor_JSON_Parser_' + Math.floor(Math.random() * 10000),
                          type: 'dql',
                          matcher: 'true',
                          description: 'JSON Parser',
                          enabled: true,
                          dql: {
                            script: 'parse rqBody, "JSON:json"\n| fieldsFlatten json\n| parse json.additionalFields, "JSON:additionalFields"\n| fieldsFlatten json.additionalFields, prefix:"additionalfields."\n| fieldsAdd userName = coalesce(json.userName, additionalfields.userName)\n| fieldsAdd userEmail = coalesce(json.userEmail, additionalfields.userEmail)\n| fieldsAdd feature = coalesce(json.feature, additionalfields.feature)',
                          },
                        },
                        {
                          id: 'processor_Error_Field_' + Math.floor(Math.random() * 10000),
                          type: 'dql',
                          matcher: 'true',
                          description: 'Error Field',
                          enabled: true,
                          dql: {
                            script: 'fieldsAdd  event.type = if(json.hasError == true, concat(event.type, ``, " - Exception"), else:{`event.type`})',
                          },
                        },
                      ],
                    },
                    securityContext: { processors: [] },
                    costAllocation: {
                      processors: [
                        {
                          id: 'processor_Business_Outcome_Engine_' + Math.floor(Math.random() * 10000),
                          type: 'costAllocation',
                          matcher: 'matchesvalue(event.category, "Business Observability Demonstrator")',
                          description: 'Business Observability Demonstrator',
                          enabled: true,
                          costAllocation: {
                            value: {
                              type: 'constant',
                              constant: 'BusinessOutcomeEngineApp',
                            },
                          },
                        },
                      ],
                    },
                    productAllocation: { processors: [] },
                    storage: { processors: [] },
                    smartscapeNodeExtraction: { processors: [] },
                    smartscapeEdgeExtraction: { processors: [] },
                    metricExtraction: { processors: [] },
                    davis: { processors: [] },
                    dataExtraction: { processors: [] },
                  },
                }],
              });

              const newPipelineObjectId = pipelineResponse?.[0]?.objectId;
              console.log(`[deploy] Pipeline created with objectId: ${newPipelineObjectId}`);
              results['openpipeline'] = { success: true };

              // If routing is also requested, chain it now with the correct pipelineId
              if (configs.includes('openpipeline-routing') && newPipelineObjectId) {
                try {
                  // Fetch existing routing object (there's always at least a default one)
                  const existingRouting = await settingsObjectsClient.getSettingsObjects({
                    schemaIds: 'builtin:openpipeline.bizevents.routing',
                    fields: 'objectId,value',
                    pageSize: 10,
                  });

                  if (existingRouting.items && existingRouting.items.length > 0) {
                    // The routing schema has ONE settings object with a routingEntries[] array
                    const routingItem = existingRouting.items[0];
                    const routingValue = JSON.parse(JSON.stringify(routingItem.value)) as {
                      routingEntries?: Array<Record<string, unknown>>;
                    };

                    // Check if entry already exists
                    const alreadyHasEntry = (routingValue.routingEntries || []).some(
                      (e) => e.description === 'Business Observability Demonstrator' || e.description === 'Business Outcome Engine' || e.description === 'Business Observability Generator' || e.description === 'BizObs App' || e.pipelineId === newPipelineObjectId
                    );

                    if (alreadyHasEntry) {
                      results['openpipeline-routing'] = { success: true, error: 'Already exists — no changes needed' };
                    } else {
                      // Add new routing entry matching exact working tenant config
                      routingValue.routingEntries = routingValue.routingEntries || [];
                      routingValue.routingEntries.push({
                        enabled: true,
                        pipelineType: 'custom',
                        pipelineId: newPipelineObjectId,
                        matcher: 'matchesvalue(event.category, "Business Observability Demonstrator")',
                        description: 'Business Observability Demonstrator',
                      });

                      console.log(`[deploy] Routing: adding entry with pipelineId=${newPipelineObjectId}, total entries=${routingValue.routingEntries.length}`);

                      await settingsObjectsClient.postSettingsObjects({
                        body: [{
                          schemaId: 'builtin:openpipeline.bizevents.routing',
                          scope: 'environment',
                          value: routingValue,
                        }],
                      });
                      results['openpipeline-routing'] = { success: true };
                    }
                  } else {
                    // No existing routing object — create one from scratch
                    await settingsObjectsClient.postSettingsObjects({
                      body: [{
                        schemaId: 'builtin:openpipeline.bizevents.routing',
                        scope: 'environment',
                        value: {
                          routingEntries: [{
                            enabled: true,
                            pipelineType: 'custom',
                            pipelineId: newPipelineObjectId,
                            matcher: 'matchesvalue(event.category, "Business Observability Demonstrator")',
                            description: 'Business Observability Demonstrator',
                          }],
                        },
                      }],
                    });
                    results['openpipeline-routing'] = { success: true };
                  }
                } catch (routeErr: any) {
                  const detail = routeErr?.body?.error?.constraintViolations
                    ? JSON.stringify(routeErr.body.error.constraintViolations)
                    : routeErr?.body?.error?.message || routeErr?.message || 'Unknown error';
                  results['openpipeline-routing'] = { success: false, error: detail };
                }
              }
              } catch (pipelineErr: any) {
                // Handle duplicate customId error gracefully — pipeline already exists
                const errMsg = JSON.stringify(pipelineErr?.body || pipelineErr?.message || pipelineErr);
                if (errMsg.includes('identical customId') || errMsg.includes('customId')) {
                  console.log('[deploy] Pipeline already exists (caught duplicate customId error)');
                  results['openpipeline'] = { success: true, error: 'Already exists — no changes needed (duplicate customId)' };
                } else {
                  throw pipelineErr;
                }
              }
            }

          } else if (configKey === 'openpipeline-routing') {
            // Skip if already handled by the openpipeline block above
            if (results['openpipeline-routing']) continue;

            // Routing requested alone — find the Demonstrator pipeline objectId
            const pipelineCheck = await settingsObjectsClient.getSettingsObjects({
              schemaIds: 'builtin:openpipeline.bizevents.pipelines',
              fields: 'objectId,value',
              pageSize: 50,
            });
            const bizobsPipeline = (pipelineCheck.items || []).find(
              (i: any) => i.value?.customId === 'bizobs-template-pipeline' || i.value?.displayName === 'Business Observability Demonstrator' || i.value?.displayName === 'Business Outcome Engine' || i.value?.displayName === 'Business Observability Generator' || i.value?.displayName === 'BizObs Template Pipeline'
            );

            if (!bizobsPipeline) {
              results['openpipeline-routing'] = { success: false, error: 'Pipeline "Business Observability Demonstrator" must be created first — deploy the Pipeline step before Routing' };
            } else {
              const pipelineObjectId = bizobsPipeline.objectId;

              // Fetch existing routing object
              const existingRouting = await settingsObjectsClient.getSettingsObjects({
                schemaIds: 'builtin:openpipeline.bizevents.routing',
                fields: 'objectId,value',
                pageSize: 10,
              });

              if (existingRouting.items && existingRouting.items.length > 0) {
                const routingItem = existingRouting.items[0];
                const routingValue = JSON.parse(JSON.stringify(routingItem.value)) as {
                  routingEntries?: Array<Record<string, unknown>>;
                };

                // Check if entry already exists
                const alreadyHasEntry = (routingValue.routingEntries || []).some(
                  (e) => e.description === 'Business Observability Demonstrator' || e.description === 'Business Outcome Engine' || e.description === 'Business Observability Generator' || e.description === 'BizObs App' || e.pipelineId === pipelineObjectId
                );

                if (alreadyHasEntry) {
                  results['openpipeline-routing'] = { success: true, error: 'Already exists — no changes needed' };
                } else {
                  routingValue.routingEntries = routingValue.routingEntries || [];
                  routingValue.routingEntries.push({
                    enabled: true,
                    pipelineType: 'custom',
                    pipelineId: pipelineObjectId,
                    matcher: 'matchesvalue(event.category, "Business Observability Demonstrator")',
                    description: 'Business Observability Demonstrator',
                  });

                  console.log(`[deploy] Routing standalone: adding entry with pipelineId=${pipelineObjectId}`);

                  await settingsObjectsClient.postSettingsObjects({
                    body: [{
                      schemaId: 'builtin:openpipeline.bizevents.routing',
                      scope: 'environment',
                      value: routingValue,
                    }],
                  });
                  results['openpipeline-routing'] = { success: true };
                }
              } else {
                // No existing routing object — create from scratch
                await settingsObjectsClient.postSettingsObjects({
                  body: [{
                    schemaId: 'builtin:openpipeline.bizevents.routing',
                    scope: 'environment',
                    value: {
                      routingEntries: [{
                        enabled: true,
                        pipelineType: 'custom',
                        pipelineId: pipelineObjectId,
                        matcher: 'matchesvalue(event.category, "Business Observability Demonstrator")',
                        description: 'Business Observability Demonstrator',
                      }],
                    },
                  }],
                });
                results['openpipeline-routing'] = { success: true };
              }
            }

          } else if (configKey === 'feature-flags') {
            // OneAgent feature keys are predefined enums — cannot create custom keys.
            // Check if SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING already exists; if so, update it.
            const existing = await settingsObjectsClient.getSettingsObjects({
              schemaIds: 'builtin:oneagent.features',
              fields: 'objectId,value',
              filter: "value.key = 'SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING'",
              pageSize: 1,
            });

            if (existing.totalCount > 0 && existing.items?.[0]) {
              // Already exists — ensure it's enabled
              const currentValue = existing.items[0].value as Record<string, unknown>;
              if (currentValue.enabled === true) {
                results['feature-flags'] = { success: true, error: 'Already configured and enabled — no changes needed' };
              } else {
                // UPDATE existing object via PUT (can't POST a duplicate feature key)
                const updatedValue = JSON.parse(JSON.stringify(currentValue));
                updatedValue.enabled = true;
                updatedValue.instrumentation = true;
                await settingsObjectsClient.putSettingsObjectByObjectId({
                  objectId: existing.items[0].objectId,
                  body: {
                    value: updatedValue,
                  },
                });
                results['feature-flags'] = { success: true };
              }
            } else {
              // Create from scratch with the real key
              await settingsObjectsClient.postSettingsObjects({
                body: [{
                  schemaId: 'builtin:oneagent.features',
                  scope: 'environment',
                  value: {
                    enabled: true,
                    key: 'SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING',
                    instrumentation: true,
                  },
                }],
              });
              results['feature-flags'] = { success: true };
            }
          } else if (configKey === 'outbound-github-models') {
            // Add models.inference.ai.azure.com to the outbound connections allowlist
            const TARGET_HOST = 'models.inference.ai.azure.com';
            const existing = await settingsObjectsClient.getSettingsObjects({
              schemaIds: 'builtin:dt-javascript-runtime.allowed-outbound-connections',
              fields: 'objectId,value',
              pageSize: 1,
            });
            const item = existing.items?.[0];
            const aoc = (item?.value as any)?.allowedOutboundConnections;

            if (aoc) {
              const hostList: string[] = aoc.hostList || [];
              if (hostList.includes(TARGET_HOST)) {
                results['outbound-github-models'] = { success: true, error: 'Already in allowlist — no changes needed' };
              } else {
                // Update existing object — add host to the list
                await settingsObjectsClient.putSettingsObjectByObjectId({
                  objectId: item!.objectId,
                  body: {
                    value: {
                      allowedOutboundConnections: {
                        enforced: aoc.enforced !== false,
                        hostList: [...hostList, TARGET_HOST],
                      },
                    },
                  },
                });
                results['outbound-github-models'] = { success: true };
              }
            } else {
              // No settings object exists yet — create one
              await settingsObjectsClient.postSettingsObjects({
                body: [{
                  schemaId: 'builtin:dt-javascript-runtime.allowed-outbound-connections',
                  scope: 'environment',
                  value: {
                    allowedOutboundConnections: {
                      enforced: true,
                      hostList: [TARGET_HOST],
                    },
                  },
                }],
              });
              results['outbound-github-models'] = { success: true };
            }

          } else if (configKey === 'automation-workflow') {
            // Workflow requires automation:workflows:write scope which is restricted
            // to Dynatrace-provided apps. Return the template for manual import.
            results['automation-workflow'] = {
              success: false,
              error: 'Workflow must be imported manually — use the Import button in Get Started',
            };
          } else {
            results[configKey] = { success: false, error: `Unknown config key: ${configKey}. OpenPipeline configs must be configured manually.` };
          }
        } catch (err: any) {
          const violations = err?.body?.error?.constraintViolations;
          const errorMsg = err?.body?.error?.message;
          const fullBody = err?.body ? JSON.stringify(err.body, null, 2) : undefined;
          const detail = violations
            ? JSON.stringify(violations)
            : errorMsg || err?.message || 'Unknown error';
          results[configKey] = { success: false, error: `${detail}${fullBody ? ' | Full: ' + fullBody : ''}` };
        }
      }

      return { success: true, data: results };
    }

    // ── Get Automation Workflow Template (BizObs Fix-It Agent) ──
    // Returns the workflow JSON template with the current server URL injected.
    // The user imports this into Dynatrace Workflows manually (write scope is restricted).
    if (action === 'deploy-workflow') {
      const workflowTemplate = {
        title: 'BizObs Fix-It Agent \u2014 Autonomous Remediation',
        description: 'Davis problem \u2192 gather DQL context \u2192 query Davis root cause \u2192 call Fix-It Agent \u2192 verify remediation \u2192 send BizEvent summary',
        isPrivate: false,
        schemaVersion: 3,
        type: 'STANDARD',
        trigger: {
          eventTrigger: {
            isActive: true,
            filterQuery: 'event.kind == "DAVIS_PROBLEM" AND event.status == "ACTIVE" AND (event.status_transition == "CREATED" OR event.status_transition == "UPDATED" OR event.status_transition == "REOPENED") AND (event.category == "AVAILABILITY" OR event.category == "ERROR" OR event.category == "SLOWDOWN" OR event.category == "RESOURCE_CONTENTION" OR event.category == "CUSTOM_ALERT")',
            uniqueExpression: '{{ event()["event.id"] }}-{{ "open" if event()["event.status"] == "ACTIVE" else "resolved" }}-{{ event()["dt.davis.last_reopen_timestamp"] }}',
            triggerConfiguration: {
              type: 'davis-problem',
              value: {
                categories: { error: true, custom: true, resource: true, slowdown: true, availability: true },
                entityTags: {},
                customFilter: '',
                analysisReady: false,
                onProblemClose: false,
                entityTagsMatch: null,
              },
            },
          },
        },
        tasks: {
          invoke_dynatrace_intelligence: {
            name: 'invoke_dynatrace_intelligence',
            action: 'dynatrace.davis.copilot.workflow.actions:davis-copilot',
            input: {
              config: 'dynatrace',
              prompt: 'Analyze this Davis problem and provide: (1) what happened, (2) root cause analysis, (3) business impact, (4) remediation steps.\n\nProblem: {{ event()["display_id"] }} \u2014 {{ event()["event.name"] }}\nCategory: {{ event()["event.category"] }}\nStatus: {{ event()["event.status"] }}\nAffected Service: {{ event()["dt.entity.service"] }}\nRelated Process Group: {{ event()["dt.entity.process_group"] }}\nImpact Level: {{ event()["dt.davis.impact_level"] }}\n\nDescription:\n{{ event()["event.description"] }}',
              autoTrim: true,
              instruction: 'Be specific about the affected service name and entity ID. Include the problem ID in your response. Focus on actionable remediation steps.',
              supplementary: `Entity tags: {{ event()["entity_tags"] }}\nAffected entity IDs: {{ event()["affected_entity_ids"] }}\nEvent start: {{ event()["event.start"] }}\nDavis event IDs: {{ event()["dt.davis.event_ids"] }}\nThis is a BizObs journey service running on an EC2 instance. The service is part of an insurance purchase journey. If the failure rate is elevated, the remediation is to disable the error injection feature flag via the API endpoint POST /api/feature_flag with errors_per_transaction set to 0.`,
            },
            position: { x: 0, y: 1 },
            description: 'Prompt the Dynatrace Intelligence generative AI',
            predecessors: [],
          },
          call_ai_fixit_agent: {
            name: 'call_ai_fixit_agent',
            action: 'dynatrace.automations:http-function',
            input: {
              url: `${baseUrl}/api/feature_flag`,
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              payload: '{\n  "targetService": "{% set tags = event()[\'entity_tags\'] %}{% for tag in tags %}{% if \'DT_APPLICATION_NAME:\' in tag %}{{ tag | replace(\'[Environment]DT_APPLICATION_NAME:\', \'\') }}{% endif %}{% endfor %}",\n  "flags": {\n    "errors_per_transaction": 0,\n    "errors_per_visit": 0,\n    "errors_per_minute": 0\n  }\n}',
              failOnResponseCodes: '400-599',
            },
            position: { x: 0, y: 2 },
            conditions: { states: { invoke_dynatrace_intelligence: 'OK' } },
            description: 'Issue an HTTP request to any API.',
            predecessors: ['invoke_dynatrace_intelligence'],
          },
        },
        input: {},
        hourlyExecutionLimit: 1000,
      };

      return {
        success: true,
        data: { workflowTemplate },
      };
    }

    // ── Async Dashboard generation (jobs/polling model) ──
    if (action === 'generate-dashboard-async') {
      try {
        // Discover available fields before async generation too
        const asyncBody = { ...(body as any) };
        const asyncJd = asyncBody.journeyData;
        if (asyncJd?.company && asyncJd?.journeyType) {
          const asyncFields = await discoverBizEventFieldsViaSDK(asyncJd.company, asyncJd.journeyType);
          if (asyncFields !== null) {
            asyncBody.journeyData = { ...asyncJd, discoveredFields: asyncFields };
          }
        }
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/generate-async`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(asyncBody),
          signal: AbortSignal.timeout(20000), // Allow extra time for routing/edge latency
        });
        const data = await res.json();
        return { success: res.ok, ...data };
      } catch (error: any) {
        console.error('[proxy-api] Async dashboard start error:', error.message);
        return { success: false, error: error.message };
      }
    }

    // Get dashboard job status (polling)
    if (action === 'get-dashboard-status') {
      try {
        const { jobId } = body as { jobId: string };
        if (!jobId) {
          return { success: false, error: 'jobId required' };
        }
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/status/${jobId}`, {
          method: 'GET',
          signal: AbortSignal.timeout(15000), // Slightly longer to accommodate network/edge delays
        });
        const data = await res.json();
        return { success: res.ok, ...data };
      } catch (error: any) {
        console.error('[proxy-api] Dashboard status check error:', error.message);
        return { success: false, error: error.message };
      }
    }

    // ── AI Dashboard generation (calls server's ai-dashboard route) ──
    if (action === 'generate-dashboard') {
      try {
        const hasPrompt = !!(body as any)?.customPrompt;
        // Discover available bizevent fields via SDK before generating
        const generateBody = { ...(body as any) };
        const jd = generateBody.journeyData;
        if (jd?.company && jd?.journeyType) {
          const discoveredFields = await discoverBizEventFieldsViaSDK(jd.company, jd.journeyType);
          if (discoveredFields !== null) {
            generateBody.journeyData = { ...jd, discoveredFields };
          }
        }
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(generateBody),
          signal: AbortSignal.timeout(hasPrompt ? 130000 : 60000),
        });
        const data = await res.json();
        // Optimize large response: strip unnecessary fields to reduce size
        if (data.dashboard && data.dashboard.content) {
          // Keep only essential dashboard properties
          const optimized = {
            name: data.dashboard.name,
            type: data.dashboard.type,
            version: data.dashboard.version,
            content: data.dashboard.content,
            metadata: data.dashboard.metadata
          };
          // Check size and optionally compress
          const jsonStr = JSON.stringify(optimized);
          const sizeKb = jsonStr.length / 1024;
          
          // If response is large enough, indicate compression for client-side handling
          return { 
            success: res.ok, 
            status: res.status, 
            data: { 
              dashboard: optimized,
              _meta: { sizeMb: (sizeKb / 1024).toFixed(3), compressed: false }
            } 
          };
        }
        // Fallback: return minimal response structure
        return { success: res.ok, status: res.status, data };
      } catch (error: any) {
        console.error('[proxy-api] Dashboard generation timeout/error:', error.message);
        return { success: false, status: 0, error: error.message };
      }
    }

    if (action === 'deploy-dashboard') {
      try {
        const b = (body || {}) as any;
        if (!b?.dashboard) {
          return { success: false, status: 400, error: 'dashboard payload is required' };
        }

        const sdkDeploy = await deployDashboardWithDocumentsSdk({
          dashboard: b.dashboard,
          company: b.company,
          journeyType: b.journeyType,
          userEmail,
          userName,
          generationMethod: b.dashboard?.metadata?.generationMethod || b.generationMethod || 'manual-deploy',
        });

        if (!sdkDeploy.success) {
          return {
            success: false,
            status: 403,
            error: sdkDeploy.error || 'Dashboard deploy failed (Documents SDK)',
            code: sdkDeploy.code || 'DOCS_DEPLOY_FAILED',
          };
        }

        return {
          success: true,
          status: 200,
          data: {
            success: true,
            data: sdkDeploy.data,
          },
        };
      } catch (error: any) {
        console.error('[proxy-api] direct dashboard deploy error:', error.message);
        return { success: false, status: 0, error: error.message };
      }
    }

    if (action === 'preflight-dtctl') {
      try {
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/preflight-dtctl`, {
          method: 'GET',
          signal: AbortSignal.timeout(20000),
        });
        const data = await res.json();
        return { success: res.ok, status: res.status, data };
      } catch (error: any) {
        console.error('[proxy-api] dtctl preflight error:', error.message);
        return { success: false, status: 0, error: error.message };
      }
    }


    // ── List saved dashboards on EC2 host ──
    if (action === 'list-saved-dashboards') {
      try {
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/saved`, {
          method: 'GET',
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return { success: res.ok, ...data };
      } catch (error: any) {
        console.error('[proxy-api] List saved dashboards error:', error.message);
        return { success: false, error: error.message };
      }
    }

    // ── Load a specific saved dashboard from EC2 host ──
    if (action === 'load-saved-dashboard') {
      try {
        const { dashboardId } = body as { dashboardId: string };
        if (!dashboardId) return { success: false, error: 'dashboardId required' };
        const safeId = dashboardId.replace(/[^a-zA-Z0-9-]/g, '');
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/saved/${safeId}`, {
          method: 'GET',
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return { success: res.ok, ...data };
      } catch (error: any) {
        console.error('[proxy-api] Load saved dashboard error:', error.message);
        return { success: false, error: error.message };
      }
    }

    // ── Delete a saved dashboard from EC2 host ──
    if (action === 'delete-saved-dashboard') {
      try {
        const { dashboardId } = body as { dashboardId: string };
        if (!dashboardId) return { success: false, error: 'dashboardId required' };
        const safeId = dashboardId.replace(/[^a-zA-Z0-9-]/g, '');
        const res = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/saved/${safeId}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(10000),
        });
        const data = await res.json();
        return { success: res.ok, ...data };
      } catch (error: any) {
        console.error('[proxy-api] Delete saved dashboard error:', error.message);
        return { success: false, error: error.message };
      }
    }

    // ── Generate + Deploy Dashboard in one step (Copilot → dtctl path).
    // Uses GitHub Copilot with AGENTS.md-quality prompt for high-fidelity Gen 3 dashboards.
    // Keep legacy action name for backward compatibility.
    if (action === 'mcp-generate-deploy-dashboard' || action === 'generate-deploy-dashboard') {
      try {
        const { company, journeyType, useAI = true, customPrompt, model: requestedModel } = body as { company: string; journeyType: string; useAI?: boolean; customPrompt?: string; model?: string };
        if (!company || !journeyType) {
          return { success: false, error: 'company and journeyType are required' };
        }

        const hasCustomPrompt = !!customPrompt;
        const sanitizedCustomPrompt = hasCustomPrompt ? String(customPrompt).slice(0, 1200) : '';
        console.log(`[proxy-api] Generate+deploy (Opus via external generator): ${company} / ${journeyType}${hasCustomPrompt ? ` (custom focus: "${sanitizedCustomPrompt.substring(0, 60)}...")` : ''}`);

        // Step 1: Discover existing BizEvent fields for this journey
        const discoveredFields = await discoverBizEventFieldsViaSDK(company, journeyType);

        // Step 2: Build prompt using the improved template from _external/dynatrace-kpi-dashboard-generator
        const generationPrompt = buildDashboardGenerationPrompt(
          company,
          journeyType,
          discoveredFields,
          sanitizedCustomPrompt || undefined
        );


        const boundedGenerationPrompt = generationPrompt.length > 28000
          ? `${generationPrompt.slice(0, 28000)}\n\n[Prompt truncated for safety. Keep output valid and complete.]`
          : generationPrompt;

        // Step 3: Generate via the configured AI provider (OpenAI / Anthropic / GitHub Models / Ollama)
        let generatedJson: any = null;
        let generationMethod = 'ai-provider';

        try {
          const requestedDashboardModel = String(requestedModel || '').trim();
          console.log(`[proxy-api] Generating dashboard via configured AI provider${requestedDashboardModel ? ` (model override: ${requestedDashboardModel})` : ''}...`);
          const aiResult = await callAiProvider({
            prompt: boundedGenerationPrompt,
            systemPrompt: 'You are a Dynatrace Gen 3 dashboard expert. Output raw JSON only — no markdown fences, no explanation, no comments. The JSON must be a complete valid Dynatrace Gen 3 dashboard object.',
            temperature: 0.4,
            maxTokens: 7000,
            configOverride: requestedDashboardModel ? { model: requestedDashboardModel } : undefined,
          });

          if (!aiResult.success || !aiResult.data?.content) {
            throw new Error(aiResult.error || 'AI provider returned empty content');
          }

          const rawContent: string = String(aiResult.data.content);
          const dashboardModel = String(aiResult.data.model || aiResult.data.genai?.model || requestedDashboardModel || 'ai');

          if (rawContent.length > 2_000_000) {
            throw new Error(`AI response too large (${rawContent.length} chars)`);
          }

          // Extract and validate JSON from the response using the external repo's patterns
          generatedJson = extractDashboardJson(rawContent);

          // Validate structure
          const validationResult = validateDashboardJson(generatedJson);
          if (!validationResult.valid) {
            throw new Error(`Dashboard validation failed: ${validationResult.errors.join('; ')}`);
          }

          const tileCount = Object.keys(generatedJson.tiles).length;
          console.log(`[proxy-api] ✅ AI provider (${dashboardModel}) generated ${tileCount} tiles for ${company} - ${journeyType}`);
          generationMethod = `ai-${dashboardModel}`;

        } catch (genErr: any) {
          console.warn(`[proxy-api] AI dashboard generation failed (no template fallback): ${genErr.message}`);
          return {
            success: false,
            error: `Dashboard generation failed via AI provider: ${genErr.message}`,
            code: 'DASHBOARD_GENAI_FAILED',
          };
        }

        // Normalise: the top-level object IS the dashboard content (tiles/layouts/variables/settings)
        const dashboardContent = generatedJson.tiles ? generatedJson : (generatedJson.content || generatedJson);
        const tileCount = Object.keys(dashboardContent.tiles || {}).length;
        console.log(`[proxy-api] Deploying ${tileCount} tiles via ${generationMethod}`);

        // Step 4: Deploy via Documents SDK so owner = active AppEngine principal
        const dashboardForDeploy = {
          name: `${company} - ${journeyType}`,
          content: dashboardContent,
        };

        const deployData = await deployDashboardWithDocumentsSdk({
          dashboard: dashboardForDeploy,
          company,
          journeyType,
          userEmail,
          userName,
          generationMethod,
        });

        if (!deployData?.success || !deployData.data?.dashboardId) {
          return {
            success: false,
            error: String(deployData?.error || 'documents-sdk dashboard deployment failed'),
            code: deployData?.code || 'DOCS_DEPLOY_FAILED',
          };
        }

        const dashboardId = deployData.data.dashboardId;
        const dashboardName = deployData.data.dashboardName || `${company} - ${journeyType}`;
        const dashboardUrl = deployData.data.dashboardUrl || `/ui/apps/dynatrace.dashboards/?query=${encodeURIComponent(dashboardId)}`;

        return {
          success: true,
          data: {
            dashboardId,
            dashboardUrl,
            dashboardName,
            tileCount,
            generationMethod,
            alreadyExisted: !!deployData.data.alreadyExisted,
            message: `Dashboard "${dashboardName}" generated by Copilot and deployed with user ownership (${tileCount} tiles)`,
          },
        };
      } catch (error: any) {
        console.error('[proxy-api] MCP generate+deploy error:', error.message);
        return { success: false, error: error.message || 'MCP dashboard generation failed' };
      }
    }

    if (action === 'repair-dashboard-sharing') {
      try {
        const r = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/repair-dashboard-sharing`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          signal: AbortSignal.timeout(240000),
        }, 2, 2000);
        const data = await r.json();
        return data;
      } catch (error: any) {
        return { success: false, error: error.message || 'Failed to repair dashboard sharing' };
      }
    }

    if (action === 'list-generated-dashboards') {
      try {
        const r = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/list-generated-dashboards`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          signal: AbortSignal.timeout(120000),
        }, 2, 1000);
        const data = await r.json();
        return data;
      } catch (error: any) {
        return { success: false, error: error.message || 'Failed to list generated dashboards' };
      }
    }

    if (action === 'delete-generated-dashboard') {
      try {
        const dashboardId = String((body as any)?.dashboardId || '').trim();
        if (!dashboardId) return { success: false, error: 'dashboardId is required' };

        // Primary path: AppEngine Documents SDK using app/user context.
        try {
          const existing = await documentsClient.getDocument({ id: dashboardId });
          await documentsClient.deleteDocument({
            id: dashboardId,
            optimisticLockingVersion: String(existing?.metadata?.version || ''),
          });
          return { success: true, dashboardId, method: 'documents-sdk' };
        } catch (sdkErr: any) {
          const sdkMsg = String(sdkErr?.message || sdkErr || 'deleteDocument failed');
          const fallbackAllowed = /forbidden|access denied|403|unauthorized|401|not allowed/i.test(sdkMsg);
          if (!fallbackAllowed) {
            return { success: false, error: sdkMsg };
          }
        }

        // Fallback path: server dtctl token flow.
        const r = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/delete-generated-dashboard`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ dashboardId }),
          signal: AbortSignal.timeout(120000),
        }, 2, 1000);
        const data = await r.json();
        return data;
      } catch (error: any) {
        return { success: false, error: error.message || 'Failed to delete dashboard' };
      }
    }

    // Transfer ownership by delete+recreate under AppEngine principal.
    // Requires the active principal to have read+delete+write on target docs.
    if (action === 'transfer-dashboard-ownership') {
      const transferred: string[] = [];
      const failed: Array<{ id: string; error: string }> = [];

      try {
        const filter = String((body as any)?.filter || "id starts-with 'bizobs-' and type = 'dashboard'");
        const limitRaw = Number((body as any)?.limit ?? 0);
        const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0;

        let allDocs: any[] = [];
        let nextPageKey: string | undefined;
        do {
          const page: any = await documentsClient.listDocuments({
            filter,
            pageSize: 100,
            ...(nextPageKey ? { nextPageKey } : {}),
          });

          const pageDocs = Array.isArray(page?.documents) ? page.documents : [];
          allDocs = allDocs.concat(pageDocs);
          nextPageKey = page?.nextPageKey;

          if (limit > 0 && allDocs.length >= limit) {
            allDocs = allDocs.slice(0, limit);
            break;
          }
        } while (nextPageKey);

        console.log(`[proxy-api] transfer-dashboard-ownership: found ${allDocs.length} documents with filter: ${filter}`);

        for (const docMeta of allDocs) {
          const docId = String(docMeta?.id || '').trim();
          if (!docId) continue;

          try {
            const full: any = await documentsClient.getDocument({ id: docId });
            const contentBlob = full?.content ? await (full.content as any).get('blob') : null;
            if (!contentBlob) {
              failed.push({ id: docId, error: 'Could not retrieve document content blob' });
              continue;
            }

            const version = String(full?.metadata?.version ?? '');
            const name = String(full?.metadata?.displayName || docMeta?.name || docId);
            const type = String(full?.metadata?.type || docMeta?.type || 'dashboard');

            await documentsClient.deleteDocument({
              id: docId,
              optimisticLockingVersion: version,
            });

            await documentsClient.createDocument({
              body: {
                id: docId,
                name,
                type,
                content: contentBlob,
              },
            });

            try {
              await environmentSharesClient.createEnvironmentShare({
                body: { documentId: docId, access: 'read-write' },
              });
            } catch {
              // Ignore if share already exists or is already inherited.
            }

            transferred.push(docId);
          } catch (docErr: any) {
            failed.push({ id: docId, error: String(docErr?.message || docErr || 'unknown error') });
          }
        }

        return {
          success: failed.length === 0,
          total: allDocs.length,
          transferred,
          failed,
          message: `Transferred ${transferred.length}/${allDocs.length} documents. ${failed.length} failed.`,
        };
      } catch (err: any) {
        return {
          success: false,
          error: String(err?.message || err || 'Transfer failed'),
          transferred,
          failed,
        };
      }
    }

    if (action === 'deploy-business-flow') {
      try {
        // 1. Generate the Business Flow JSON from the Node backend (no DT credentials needed)
        const genRes = await fetchWithRetry(`${baseUrl}/api/business-flow/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10000),
        });
        const genData = await genRes.json() as any;
        if (!genRes.ok || !genData.ok || !genData.businessFlow) {
          return { success: false, error: genData.error || 'Failed to generate Business Flow' };
        }
        const flow = genData.businessFlow;

        // 2. Deploy to Dynatrace using AppEngine SDK (uses AppEngine OAuth — no API token needed)
        //    Upsert by flow name to avoid "Conflicting resources" on repeat deploys.
        const existing = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'app:dynatrace.biz.flow:biz-flow-settings',
          fields: 'objectId,value',
          pageSize: 500,
        });

        const existingItem = (existing.items || []).find((item: any) => item.value?.name === flow.name);
        if (existingItem?.objectId) {
          await settingsObjectsClient.putSettingsObjectByObjectId({
            objectId: existingItem.objectId,
            body: {
              value: flow,
            },
          });
        } else {
          await settingsObjectsClient.postSettingsObjects({
            body: [{
              schemaId: 'app:dynatrace.biz.flow:biz-flow-settings',
              scope: 'environment',
              value: flow,
            }],
          });
        }

        return {
          success: true,
          data: {
            ok: true,
            name: flow.name,
            steps: flow.steps.length,
            updated: !!existingItem,
            message: `Business Flow "${flow.name}" ${existingItem ? 'updated' : 'deployed'} successfully.`
          }
        };
      } catch (error: any) {
        console.error('[proxy-api] Business Flow deploy error:', error.message);
        return { success: false, status: 0, error: error.message };
      }
    }

    // ── Executive Summary PDF generation ──
    if (action === 'generate-pdf') {
      try {
        const res = await fetchWithRetry(`${baseUrl}/api/pdf/executive-summary`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          const errText = await res.text();
          return { success: false, error: `PDF generation failed (${res.status}): ${errText}` };
        }
        // Convert binary PDF to base64 so it can travel through the JSON proxy
        const arrayBuffer = await res.arrayBuffer();
        const base64 = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));
        const contentDisposition = res.headers.get('content-disposition') || '';
        const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
        const filename = filenameMatch ? filenameMatch[1] : 'BizObs-Summary.pdf';
        return { success: true, data: { base64, filename, sizeKb: Math.round(arrayBuffer.byteLength / 1024) } };
      } catch (error: any) {
        console.error('[proxy-api] PDF generation error:', error.message);
        return { success: false, error: error.message };
      }
    }

    // ── Executive Summary Document (HTML — Word-convertible) ──
    if (action === 'generate-doc') {
      try {
        const res = await fetchWithRetry(`${baseUrl}/api/pdf/executive-doc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        });
        if (!res.ok) {
          const errText = await res.text();
          return { success: false, error: `Document generation failed (${res.status}): ${errText}` };
        }
        const html = await res.text();
        const contentDisposition = res.headers.get('content-disposition') || '';
        const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
        const filename = filenameMatch ? filenameMatch[1] : 'BizObs-Summary.html';
        return { success: true, data: { html, filename, sizeKb: Math.round(html.length / 1024) } };
      } catch (error: any) {
        console.error('[proxy-api] Document generation error:', error.message);
        return { success: false, error: error.message };
      }
    }

    if (action === 'get-saved-config') {
      const configName = (body as any)?.configName || '';
      const apiUrl = `${baseUrl}/api/admin/configs/${encodeURIComponent(configName)}`;
      const response = await fetchWithRetry(apiUrl, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        return { success: false, status: response.status, error: `Config not found: ${configName}` };
      }
      const data = await response.json();
      return { success: true, data };
    }

    if (action === 'simulate-vcarb-race') {
      const apiUrl = `${baseUrl}/api/journey-simulation/simulate-vcarb-race`;
      const response = await fetchWithRetry(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120000),
      });
      const data = await response.json();
      return { success: response.ok, status: response.status, data };
    }

    if (action === 'vcarb-race-status') {
      const raceId = (body as any)?.raceId || '';
      const apiUrl = `${baseUrl}/api/journey-simulation/vcarb-race-status/${encodeURIComponent(raceId)}`;
      const response = await fetchWithRetry(apiUrl, { method: 'GET', signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      return { success: response.ok, data };
    }

    if (action === 'stop-vcarb-race') {
      const raceId = (body as any)?.raceId || '';
      const apiUrl = `${baseUrl}/api/journey-simulation/stop-vcarb-race/${encodeURIComponent(raceId)}`;
      const response = await fetchWithRetry(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: AbortSignal.timeout(10000),
      });
      const data = await response.json();
      return { success: response.ok, data };
    }

    if (action === 'simulate-journey') {
      const apiUrl = `${baseUrl}/api/journey-simulation/simulate-journey`;
      const response = await fetchWithRetry(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60000),
      });

      const responseText = await response.text();
      let data: unknown;
      try {
        data = JSON.parse(responseText);
      } catch {
        data = responseText;
      }

      if (!response.ok) {
        return {
          success: false,
          status: response.status,
          error: `API responded with ${response.status}: ${response.statusText}`,
          data,
        };
      }

      return { success: true, status: response.status, data };
    }

    if (action === 'list-business-flows') {
      try {
        const result = await settingsObjectsClient.getSettingsObjects({
          schemaIds: 'app:dynatrace.biz.flow:biz-flow-settings',
          fields: 'objectId,value',
          pageSize: 500,
        });
        const flows = (result.items || []).map((item: any) => ({
          objectId: item.objectId,
          name: item.value?.name,
          isSmartscapeTopologyEnabled: item.value?.isSmartscapeTopologyEnabled || false,
          stepsCount: item.value?.steps?.length || 0,
          version: item.version,
        }));
        return { success: true, data: { totalCount: result.totalCount, flows } };
      } catch (err: any) {
        return { success: false, error: err.message || 'Failed to list business flows' };
      }
    }

    if (action === 'delete-business-flows') {
      try {
        const { objectIds } = body as { objectIds: string[] };
        if (!objectIds || objectIds.length === 0) {
          return { success: false, error: 'objectIds array is required' };
        }
        const results: { objectId: string; deleted: boolean; error?: string }[] = [];
        for (const oid of objectIds) {
          try {
            await settingsObjectsClient.deleteSettingsObjectByObjectId({ objectId: oid });
            results.push({ objectId: oid, deleted: true });
          } catch (err: any) {
            results.push({ objectId: oid, deleted: false, error: err.message });
          }
        }
        return { success: true, data: { results, deletedCount: results.filter(r => r.deleted).length } };
      } catch (err: any) {
        return { success: false, error: err.message || 'Failed to delete business flows' };
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // CHECK JOURNEY ASSETS — Dashboard & BizFlow existence per company/journey
    // ══════════════════════════════════════════════════════════════════
    if (action === 'check-journey-assets') {
      try {
        const journeys = (payload.body as any)?.journeys as Array<{ company: string; journeyType: string }> || [];
        const assets: Record<string, { dashboard: { exists: boolean; id: string; url: string; name?: string }; bizflow: { exists: boolean; name?: string } }> = {};

        // 1. Fetch all BizFlows in one call
        let allFlows: any[] = [];
        try {
          const flowResult = await settingsObjectsClient.getSettingsObjects({
            schemaIds: 'app:dynatrace.biz.flow:biz-flow-settings',
            fields: 'objectId,value',
            pageSize: 500,
          });
          allFlows = flowResult.items || [];
        } catch { /* BizFlow app may not be installed */ }

        // 2. Collect unique companies and list all their dashboards in bulk
        const uniqueCompanies = [...new Set(journeys.map(j => j.company))];
        const dashboardsByCompany: Record<string, Array<{ id: string; name: string }>> = {};
        for (const company of uniqueCompanies) {
          const sanitizedCompany = company.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
          const prefix = `bizobs-${sanitizedCompany}`;
          try {
            const docs = await documentsClient.listDocuments({
              filter: `id starts-with '${prefix}' and type = 'dashboard'`,
              pageSize: 50,
            });
            dashboardsByCompany[company] = (docs.documents || []).map((d: any) => ({
              id: d.id,
              name: d.name || d.id,
            }));
          } catch {
            dashboardsByCompany[company] = [];
          }
        }

        for (const { company, journeyType } of journeys) {
          const sanitizedCompany = company.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
          const sanitizedJourney = journeyType.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
          const key = `${company}::${journeyType}`;

          // Match dashboard: exact journey ID first, then any that contains the journey slug
          const companyDashboards = dashboardsByCompany[company] || [];
          const exactMatch = companyDashboards.find(d => d.id === `bizobs-${sanitizedCompany}-${sanitizedJourney}`);
          const fuzzyMatch = !exactMatch
            ? companyDashboards.find(d => d.id.includes(sanitizedJourney) || d.name.toLowerCase().includes(journeyType.toLowerCase()))
            : undefined;
          const matchedDash = exactMatch || fuzzyMatch;
          const dashboardUrl = matchedDash
            ? `/ui/apps/dynatrace.dashboards/?query=${encodeURIComponent(matchedDash.id)}`
            : `/ui/apps/dynatrace.dashboards/?query=${encodeURIComponent(`bizobs-${sanitizedCompany}-${sanitizedJourney}`)}`;

          // Match BizFlow by company or journey name
          const companyLower = company.toLowerCase();
          const matchedFlow = allFlows.find((f: any) => {
            const name = (f.value?.name || '').toLowerCase();
            return name.includes(companyLower) || (name.includes(sanitizedCompany) && name.includes(sanitizedJourney));
          });

          assets[key] = {
            dashboard: {
              exists: !!matchedDash,
              id: matchedDash?.id || `bizobs-${sanitizedCompany}-${sanitizedJourney}`,
              url: dashboardUrl,
              name: matchedDash?.name,
            },
            bizflow: { exists: !!matchedFlow, name: matchedFlow?.value?.name },
          };
        }
        return { success: true, data: assets };
      } catch (err: any) {
        return { success: false, error: err.message || 'Failed to check journey assets' };
      }
    }

    // ══════════════════════════════════════════════════════════════════
    // APP-WIDE SETTINGS via Document Service
    // Uses a shared Grail Document (isPrivate=false) so ALL users on the
    // tenant see the same EC2 IP / port / protocol without configuring.
    // ══════════════════════════════════════════════════════════════════
    const APP_SETTINGS_DOC_ID = 'bizobs-demonstrator-app-settings';
    const APP_SETTINGS_DOC_ID_V2 = 'bizobs-demonstrator-app-settings-v2';
    const APP_SETTINGS_DOC_ID_CANDIDATES = [APP_SETTINGS_DOC_ID_V2, APP_SETTINGS_DOC_ID];
    const APP_SETTINGS_DOC_NAME = 'BizObs Demonstrator App Settings';
    const APP_SETTINGS_DOC_TYPE = 'bizobs-config';

    if (action === 'load-app-settings') {
      try {
        for (const documentId of APP_SETTINGS_DOC_ID_CANDIDATES) {
          try {
            const doc = await documentsClient.getDocument({ id: documentId });
            if (doc.content) {
              const text = await doc.content.get('text');
              const settings = JSON.parse(text);
              return { success: true, settings, version: doc.metadata?.version, documentId };
            }
          } catch (err: any) {
            const code = err?.body?.error?.code || err?.statusCode || err?.code;
            if (code === 404 || code === 403 || err?.name === 'DocumentOrSnapshotNotFound') {
              continue;
            }
            throw err;
          }
        }
        return { success: false, error: 'no-document' };
      } catch (err: any) {
        // 404 = document doesn't exist yet — not an error, just no settings saved
        const code = err?.body?.error?.code || err?.statusCode || err?.code;
        if (code === 404 || err?.message?.includes('not found') || err?.name === 'DocumentOrSnapshotNotFound') {
          return { success: false, error: 'no-document' };
        }
        return { success: false, error: err.message || 'Failed to load app settings' };
      }
    }

    if (action === 'save-app-settings') {
      try {
        const getErrorCode = (error: any): number | string | undefined =>
          error?.body?.error?.code || error?.statusCode || error?.code;
        const isNotFoundError = (error: any): boolean => {
          const code = getErrorCode(error);
          return code === 404 || error?.name === 'DocumentOrSnapshotNotFound' || error?.message?.toLowerCase?.().includes('not found');
        };
        const isConflictError = (error: any): boolean => {
          const code = getErrorCode(error);
          return code === 409 || code === 412 || error?.message?.toLowerCase?.().includes('optimistic lock');
        };
        const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

        const settingsJson = JSON.stringify(payload.body || {});
        const blob = new Blob([settingsJson], { type: 'application/json' });

        // Prefer v2 document for writes, but update whichever candidate is accessible.
        const preferredCreateDocId = APP_SETTINGS_DOC_ID_V2;

        // Handle races between concurrent users by retrying get/create/update on 409/412.
        for (let attempt = 1; attempt <= 3; attempt++) {
          let foundExistingCandidate = false;

          for (const documentId of APP_SETTINGS_DOC_ID_CANDIDATES) {
            try {
              const existing = await documentsClient.getDocument({ id: documentId });
              foundExistingCandidate = true;
              const version = existing.metadata?.version;
              await documentsClient.updateDocument({
                id: documentId,
                optimisticLockingVersion: version,
                body: {
                  content: blob,
                  name: APP_SETTINGS_DOC_NAME,
                  type: APP_SETTINGS_DOC_TYPE,
                  isPrivate: false, // Public = readable by ALL users on the tenant
                },
              });
              return { success: true, documentId };
            } catch (upsertErr: any) {
              if (isNotFoundError(upsertErr) || getErrorCode(upsertErr) === 403) {
                continue;
              }

              if (isConflictError(upsertErr) && attempt < 3) {
                await sleep(100 * attempt);
                foundExistingCandidate = true;
                break;
              }

              const code = getErrorCode(upsertErr);
              return {
                success: false,
                error: upsertErr?.message || `Failed to update app settings document (${documentId})`,
                code,
                documentId,
              };
            }
          }

          if (foundExistingCandidate && attempt < 3) {
            continue;
          }

          // No accessible existing candidate was found; create a fresh shared v2 document.
          try {
            await documentsClient.createDocument({
              body: {
                id: preferredCreateDocId,
                name: APP_SETTINGS_DOC_NAME,
                type: APP_SETTINGS_DOC_TYPE,
                content: blob,
              },
            });

            // Also create an environment share so other users can write too.
            try {
              await environmentSharesClient.createEnvironmentShare({
                body: { documentId: preferredCreateDocId, access: 'read-write' },
              });
            } catch { /* Share may already exist — ignore */ }

            // Make document public for broad read access.
            try {
              const created = await documentsClient.getDocument({ id: preferredCreateDocId });
              await documentsClient.updateDocument({
                id: preferredCreateDocId,
                optimisticLockingVersion: created.metadata?.version,
                body: { isPrivate: false },
                });
            } catch { /* Best-effort public visibility */ }

            return { success: true, documentId: preferredCreateDocId };
          } catch (createErr: any) {
            if (!isConflictError(createErr) || attempt === 3) {
              const code = getErrorCode(createErr);
              return {
                success: false,
                error: createErr?.message || 'Failed to create app settings document',
                code,
                documentId: preferredCreateDocId,
              };
            }
            await sleep(100 * attempt);
            continue;
          }
        }

        return { success: false, error: 'Failed to save app settings after retries' };
      } catch (err: any) {
        const code = err?.body?.error?.code || err?.statusCode || err?.code;
        return { success: false, error: err.message || 'Failed to save app settings', code };
      }
    }

    /* ── Demonstrator Dashboards: AI-generated tiles via Ollama (async job model) ── */
    if (action === 'demonstrator-ai-tiles') {
      try {
        const reqBody = payload.body as {
          fields?: { name: string; type: string; sampleValue?: string | number }[];
          preset?: string;
          companyName?: string;
          journeyType?: string;
          timeframe?: string;
          services?: string[];
        };
        // If no fields provided by frontend, discover them server-side
        let fields = reqBody?.fields;
        if ((!fields || fields.length === 0) && reqBody?.companyName && reqBody?.journeyType) {
          const discovered = await discoverBizEventFieldsViaSDK(reqBody.companyName, reqBody.journeyType);
          if (discovered && discovered.length > 0) fields = discovered;
        }
        if (!fields || fields.length === 0) {
          return { success: false, error: 'No fields discovered for AI tile generation' };
        }
        console.log(`[proxy-api] demonstrator-ai-tiles: starting async job for ${fields.length} fields, ${reqBody?.preset} preset`);
        // Start the async job — returns immediately with a jobId
        const resp = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/demonstrator-tiles-async`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(15000),
          body: JSON.stringify({
            fields,
            preset: reqBody?.preset || 'executive',
            companyName: reqBody?.companyName || '',
            journeyType: reqBody?.journeyType || '',
            timeframe: reqBody?.timeframe || 'now()-2h',
            services: reqBody?.services || [],
          }),
        });
        const data = await resp.json();
        return data;
      } catch (err: any) {
        console.error('[proxy-api] demonstrator-ai-tiles error:', err.message);
        return { success: false, error: err.message || 'Demonstrator AI Tiles request failed' };
      }
    }

    /* ── Demonstrator Dashboards: poll for AI tile generation status ── */
    if (action === 'demonstrator-tiles-status') {
      try {
        const { jobId } = (payload.body || {}) as { jobId?: string };
        if (!jobId) return { success: false, error: 'jobId required' };
        const resp = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/demonstrator-tiles-status/${encodeURIComponent(jobId)}`, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json();
        return data;
      } catch (err: any) {
        console.error('[proxy-api] demonstrator-tiles-status error:', err.message);
        return { success: false, error: err.message || 'Status check failed' };
      }
    }

    /* ── Field Repository: get captured journey field schemas for AI ── */
    if (action === 'field-repo-get') {
      try {
        const reqBody = payload.body as { company?: string; journeyType?: string; full?: boolean };
        const params = new URLSearchParams();
        if (reqBody?.company) params.set('company', reqBody.company);
        if (reqBody?.journeyType) params.set('journey', reqBody.journeyType);
        if (reqBody?.full) params.set('full', 'true');
        const resp = await fetchWithRetry(`${baseUrl}/api/ai-dashboard/field-repo?${params.toString()}`, {
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await resp.json();
        return data;
      } catch (err: any) {
        console.error('[proxy-api] field-repo-get error:', err.message);
        return { success: false, error: err.message || 'Field repo request failed' };
      }
    }

    /* ── Demonstrator Dashboards: execute arbitrary DQL server-side ── */
    if (action === 'execute-dql') {
      try {
        const { query, timeoutMs, maxRecords } = (payload.body || {}) as { query?: string; timeoutMs?: number; maxRecords?: number };
        console.log('[proxy-api] execute-dql called, query:', query?.substring(0, 120));
        if (!query || typeof query !== 'string') {
          return { success: false, error: 'Missing or invalid query' };
        }
        const queryResult = await queryExecutionClient.queryExecute({
          body: {
            query,
            requestTimeoutMilliseconds: timeoutMs || 15000,
            maxResultRecords: maxRecords || 1000,
          },
        });
        const records = queryResult?.result?.records || [];
        console.log(`[proxy-api] execute-dql returned ${records.length} records, keys:`, records.length > 0 ? Object.keys(records[0]) : '(empty)');
        return { success: true, records, metadata: queryResult?.result?.metadata };
      } catch (err: any) {
        console.error('[proxy-api] execute-dql error:', err.message);
        return { success: false, error: err.message || 'DQL execution failed' };
      }
    }

    /* ── Demonstrator Dashboards: create a Dynatrace Notebook from DQL tiles ── */
    if (action === 'create-notebook') {
      try {
        const { name, content } = (payload.body || {}) as { name?: string; content?: string };
        if (!name || !content) {
          return { success: false, error: 'Missing name or content for notebook' };
        }
        const blob = new Blob([content], { type: 'application/json' });
        const result = await documentsClient.createDocument({
          body: {
            name,
            type: 'notebook',
            content: blob,
          },
        });
        return { success: true, id: result.id || 'created' };
      } catch (err: any) {
        return { success: false, error: err.message || 'Failed to create notebook' };
      }
    }

    /* ── Librarian Agent: get recent history ── */
    if (action === 'librarian-history') {
      try {
        const { limit } = (payload.body || {}) as { limit?: number };
        const resp = await fetchWithRetry(`${baseUrl}/api/librarian/history?limit=${limit || 100}`, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json();
        return { success: true, events: data };
      } catch (err: any) {
        console.error('[proxy-api] librarian-history error:', err.message);
        return { success: false, error: err.message || 'Failed to fetch librarian history' };
      }
    }

    /* ── Librarian Agent: get stats ── */
    if (action === 'librarian-stats') {
      try {
        const resp = await fetchWithRetry(`${baseUrl}/api/librarian/stats`, {
          method: 'GET',
          signal: AbortSignal.timeout(15000),
        });
        const data = await resp.json();
        return { success: true, ...data };
      } catch (err: any) {
        console.error('[proxy-api] librarian-stats error:', err.message);
        return { success: false, error: err.message || 'Failed to fetch librarian stats' };
      }
    }

    /* ── Librarian Agent: full Ollama-powered analysis ── */
    if (action === 'librarian-analyze') {
      try {
        console.log('[proxy-api] librarian-analyze: requesting Ollama analysis of operational history');
        const resp = await fetchWithRetry(`${baseUrl}/api/librarian/analyze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(120000),
        });
        const data = await resp.json();
        return data;
      } catch (err: any) {
        console.error('[proxy-api] librarian-analyze error:', err.message);
        return { success: false, error: err.message || 'Librarian analysis failed' };
      }
    }

    /* ── System Maintenance: disk health & auto-cleanup ── */
    if (action === 'system-health') {
      try {
        const resp = await fetchWithRetry(`${baseUrl}/api/system/health`, { signal: AbortSignal.timeout(30000) });
        return await resp.json();
      } catch (err: any) {
        console.error('[proxy-api] system-health error:', err.message);
        return { success: false, error: err.message || 'System health check failed' };
      }
    }

    if (action === 'system-cleanup') {
      try {
        const resp = await fetchWithRetry(`${baseUrl}/api/system/cleanup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
          signal: AbortSignal.timeout(60000),
        });
        return await resp.json();
      } catch (err: any) {
        console.error('[proxy-api] system-cleanup error:', err.message);
        return { success: false, error: err.message || 'System cleanup failed' };
      }
    }

    // ── GitHub Copilot / AI Generation ──────────────────────────────────────

    const GITHUB_CREDENTIAL_NAME = 'bizobs-github-pat';
    const GITHUB_CREDENTIAL_ID = 'CREDENTIALS_VAULT-5715470804C48467';
    const GITHUB_JOURNEY_REPO_CREDENTIAL_NAME = 'github-journey-repo';
    const GITHUB_ISSUES_CREDENTIAL_NAME = 'bizobsdemo-gitissues';

    const resolveGitHubPatCredential = async (): Promise<{ credentialId: string; token: string; name?: string } | null> => {
      // Prefer the explicit credential id supplied by user, then fall back to name-based lookup.
      try {
        const detailsById = await credentialVaultClient.getCredentialsDetails({ id: GITHUB_CREDENTIAL_ID });
        const tokenById = (detailsById as any)?.token;
        if (tokenById) {
          return { credentialId: GITHUB_CREDENTIAL_ID, token: tokenById, name: GITHUB_CREDENTIAL_NAME };
        }
      } catch {
        // Ignore and continue with fallback lookup.
      }

      const creds = await credentialVaultClient.listCredentials({ type: 'TOKEN' });
      const existing = (creds.credentials || []).find(
        (c: any) => c.name === GITHUB_CREDENTIAL_NAME
      );
      if (!existing) return null;

      const details = await credentialVaultClient.getCredentialsDetails({ id: existing.id });
      const token = (details as any).token;
      if (!token) return null;

      return { credentialId: existing.id, token, name: existing.name };
    };

    if (action === 'github-journey-commit') {
      try {
        const b = (body || {}) as Record<string, any>;
        const repoOwner = String(b.repoOwner || 'LawrenceBarratt90').trim();
        const repoName = String(b.repoName || 'Business-Observability-Demonstrator---Journeys').trim();
        const branch = String(b.branch || 'main').trim();
        const source = String(b.source || 'unknown').trim() || 'unknown';
        const journey = (b.journey && typeof b.journey === 'object') ? b.journey as Record<string, any> : {};

        const companyName = String(journey.companyName || b.companyName || '').trim();
        const journeyType = String(journey.journeyType || b.journeyType || '').trim();
        if (!companyName || !journeyType) {
          return { success: false, error: 'Missing companyName or journeyType for journey commit' };
        }

        const slugify = (value: string) => value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .replace(/-{2,}/g, '-');

        const companySlug = slugify(companyName);
        const journeySlug = slugify(journeyType);

        const creds = await credentialVaultClient.listCredentials({ type: 'TOKEN' });
        // Prefer the general app GitHub PAT for issue reporting, then fall back to journey token.
        const existing = (creds.credentials || []).find(
          (c: any) => c.name === GITHUB_CREDENTIAL_NAME
        ) || (creds.credentials || []).find(
          (c: any) => c.name === GITHUB_JOURNEY_REPO_CREDENTIAL_NAME
        );
        if (!existing) {
          return { success: false, error: 'Journey repo credential not found in vault (expected github-journey-repo or bizobs-github-pat)' };
        }
        const details = await credentialVaultClient.getCredentialsDetails({ id: existing.id });
        const ghToken = (details as any).token;
        if (!ghToken) {
          return { success: false, error: 'Journey repo token exists but value is empty/unreadable' };
        }

        const encodeGitHubPath = (path: string): string =>
          path.split('/').map((segment) => encodeURIComponent(segment)).join('/');

        const getExistingSha = async (path: string): Promise<string | undefined> => {
          const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${encodeGitHubPath(path)}?ref=${encodeURIComponent(branch)}`;
          const resp = await fetch(url, {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${ghToken}`,
              'Accept': 'application/vnd.github+json',
            },
          });
          if (resp.status === 404) return undefined;
          if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`GitHub GET ${path} failed (${resp.status}): ${text.slice(0, 220)}`);
          }
          const json = await resp.json();
          return json?.sha;
        };

        const upsertJsonFile = async (path: string, data: unknown, message: string): Promise<string | undefined> => {
          const existingSha = await getExistingSha(path);
          const content = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8').toString('base64');
          const url = `https://api.github.com/repos/${repoOwner}/${repoName}/contents/${encodeGitHubPath(path)}`;
          const resp = await fetch(url, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${ghToken}`,
              'Accept': 'application/vnd.github+json',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              message,
              content,
              branch,
              sha: existingSha,
            }),
          });

          if (!resp.ok) {
            const text = await resp.text();
            throw new Error(`GitHub PUT ${path} failed (${resp.status}): ${text.slice(0, 260)}`);
          }
          const json = await resp.json();
          return json?.commit?.sha;
        };

        const canonicalJourney = {
          ...journey,
          companyName,
          journeyType,
        };
        const metadata = {
          journeyId: String(journey.journeyId || `${companySlug}-${journeySlug}`).trim(),
          companyName,
          journeyType,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          createdByUserEmail: userEmail || 'unknown',
          createdByUserName: userName || 'unknown',
          source,
          appVersion: String(b.appVersion || ''),
        };

        const filePath = `journeys/${companySlug}/${journeySlug}.json`;
        const fileContent = {
          ...canonicalJourney,
          _meta: metadata,
        };
        const commitPrefix = `${companySlug}/${journeySlug}`;
        const lastCommitSha = await upsertJsonFile(filePath, fileContent, `${commitPrefix}: update journey`);

        return {
          success: true,
          data: {
            repoOwner,
            repoName,
            branch,
            path: filePath,
            lastCommitSha: lastCommitSha || '',
            source,
          },
        };
      } catch (err: any) {
        console.error('[proxy-api] github-journey-commit error:', err.message);
        return { success: false, error: err.message || 'Journey repo commit failed' };
      }
    }

    if (action === 'github-create-issue') {
      try {
        const b = (body || {}) as Record<string, any>;
        const repoOwner = String(b.repoOwner || 'LawrenceBarratt90').trim();
        const repoName = String(b.repoName || 'Business-Observability-Demonstrator-Internal').trim();
        const rawTitle = String(b.title || '').trim();
        const summary = String(b.summary || b.description || '').trim();
        const stepsToReproduce = String(b.stepsToReproduce || '').trim();
        const expectedBehavior = String(b.expectedBehavior || '').trim();
        const actualBehavior = String(b.actualBehavior || '').trim();
        const appVersion = String(b.appVersion || '').trim();
        const tenantUrl = String(b.tenantUrl || '').trim();
        const pagePathValue = String(b.pagePath || '').trim();
        const labels = Array.isArray(b.labels)
          ? b.labels.map((label: unknown) => String(label || '').trim()).filter(Boolean)
          : ['bug'];

        if (!rawTitle) {
          return { success: false, error: 'Issue title is required' };
        }
        if (!summary && !stepsToReproduce && !actualBehavior) {
          return { success: false, error: 'Issue details are required' };
        }

        const creds = await credentialVaultClient.listCredentials({ type: 'TOKEN' });
        const existing = (creds.credentials || []).find(
          (c: any) => c.name === GITHUB_ISSUES_CREDENTIAL_NAME
        ) || (creds.credentials || []).find(
          (c: any) => c.name === GITHUB_CREDENTIAL_NAME
        ) || (creds.credentials || []).find(
          (c: any) => c.name === GITHUB_JOURNEY_REPO_CREDENTIAL_NAME
        );

        if (!existing) {
          return {
            success: false,
            error: 'GitHub token not configured in vault.',
            details: 'Expected a TOKEN credential named bizobsdemo-gitissues (or fallback credentials bizobs-github-pat / github-journey-repo).',
            code: 'NO_CREDENTIAL',
          };
        }

        const details = await credentialVaultClient.getCredentialsDetails({ id: existing.id });
        const ghToken = (details as any).token;
        if (!ghToken) {
          return { success: false, error: 'GitHub token exists but value is empty/unreadable.', code: 'TOKEN_EMPTY' };
        }

        const issueTitle = /^\[bug\]/i.test(rawTitle) ? rawTitle : `[Bug] ${rawTitle}`;
        const issueBody = [
          summary ? `## Summary\n${summary}` : '',
          stepsToReproduce ? `## Steps to Reproduce\n${stepsToReproduce}` : '',
          expectedBehavior ? `## Expected Behavior\n${expectedBehavior}` : '',
          actualBehavior ? `## Actual Behavior\n${actualBehavior}` : '',
          [
            '## Submitted From',
            `- User: ${userName}${userEmail ? ` (${userEmail})` : ''}`,
            `- App version: ${appVersion || 'unknown'}`,
            `- Tenant: ${tenantUrl || 'unknown'}`,
            `- Page: ${pagePathValue || '/'}`,
            `- Submitted at: ${new Date().toISOString()}`,
          ].join('\n'),
        ].filter(Boolean).join('\n\n');

        const resp = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}/issues`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${ghToken}`,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
          body: JSON.stringify({
            title: issueTitle,
            body: issueBody,
            labels,
          }),
        });

        if (!resp.ok) {
          const text = await resp.text();
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = null;
          }

          const ghMessage = String(parsed?.message || '').trim();
          const docUrl = String(parsed?.documentation_url || '').trim();
          const repoRef = `${repoOwner}/${repoName}`;

          if (resp.status === 404) {
            const repoResp = await fetch(`https://api.github.com/repos/${repoOwner}/${repoName}`, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${ghToken}`,
                'Accept': 'application/vnd.github+json',
                'X-GitHub-Api-Version': '2022-11-28',
              },
            });

            if (repoResp.status === 404) {
              return {
                success: false,
                error: `Cannot access repository ${repoRef}`,
                details: 'Repository not found for this token, or token lacks access to this private repository. Update PAT scopes/access and retry.',
                code: 'GITHUB_REPO_NOT_ACCESSIBLE',
              };
            }

            return {
              success: false,
              error: `Issue endpoint unavailable for ${repoRef}`,
              details: ghMessage || 'Repository is reachable but issue creation endpoint returned 404. Ensure Issues are enabled and token has write access to issues.',
              code: 'GITHUB_ISSUE_ENDPOINT_NOT_FOUND',
            };
          }

          if (resp.status === 401) {
            return {
              success: false,
              error: 'GitHub token rejected (401)',
              details: ghMessage || 'The stored token is invalid or expired. Update the PAT in settings/credential vault.',
              code: 'GITHUB_TOKEN_INVALID',
            };
          }

          if (resp.status === 403) {
            return {
              success: false,
              error: 'GitHub access forbidden (403)',
              details: ghMessage || 'Token does not have required repository/issues permission for this repository.',
              code: 'GITHUB_FORBIDDEN',
            };
          }

          return {
            success: false,
            error: `GitHub issue creation failed (${resp.status})`,
            details: ghMessage || text.slice(0, 400),
            code: 'GITHUB_ISSUE_CREATE_FAILED',
            documentationUrl: docUrl || undefined,
          };
        }

        const json = await resp.json();
        return {
          success: true,
          data: {
            repoOwner,
            repoName,
            issueNumber: json?.number,
            issueUrl: json?.html_url,
            title: json?.title,
          },
        };
      } catch (err: any) {
        console.error('[proxy-api] github-create-issue error:', err.message);
        return { success: false, error: err.message || 'GitHub issue creation failed' };
      }
    }

    if (action === 'ai-provider-status') {
      try {
        const cfg = await loadAiConfig();
        const def = AI_PROVIDERS[cfg.provider];
        const host = def.host || hostOf(cfg.baseUrl);
        const keyConfigured = cfg.provider === 'ollama' ? true : Boolean(await resolveAiApiKey(cfg.provider));

        let hostAllowed = true;
        if (host && cfg.provider !== 'ollama' && !cfg.routeViaVm) {
          try {
            const existing = await settingsObjectsClient.getSettingsObjects({
              schemaIds: 'builtin:dt-javascript-runtime.allowed-outbound-connections',
              fields: 'objectId,value', pageSize: 1,
            });
            const aoc = (existing.items?.[0]?.value as any)?.allowedOutboundConnections;
            hostAllowed = !aoc || aoc.enforced === false || (aoc.hostList || []).includes(host);
          } catch { hostAllowed = false; }
        }

        return {
          success: true,
          data: {
            provider: cfg.provider,
            model: cfg.model,
            baseUrl: cfg.baseUrl,
            routeViaVm: cfg.routeViaVm,
            keyConfigured,
            host,
            hostAllowed,
            providers: Object.keys(AI_PROVIDERS),
          },
        };
      } catch (err: any) {
        console.error('[proxy-api] ai-provider-status error:', err.message);
        return { success: false, error: err.message || 'Failed to read AI provider status' };
      }
    }

    if (action === 'ai-provider-save-key') {
      try {
        const { provider, apiKey, baseUrl } = body as { provider?: string; apiKey?: string; baseUrl?: string };
        const providerKey = normalizeAiProvider(provider);
        if (providerKey !== 'ollama' && !apiKey) {
          return { success: false, error: 'apiKey is required for this provider.' };
        }
        // Save (or update) the single agnostic AI provider key.
        if (providerKey !== 'ollama' && apiKey) {
          const creds = await credentialVaultClient.listCredentials({ type: 'TOKEN' });
          const existing = (creds.credentials || []).find((c: any) => c.name === AI_KEY_CREDENTIAL_NAME);
          const credBody = {
            name: AI_KEY_CREDENTIAL_NAME,
            scopes: ['APP_ENGINE'],
            type: 'TOKEN',
            token: apiKey,
            ownerAccessOnly: false,
            description: 'AI provider API key for the Business Observability Demonstrator (provider-agnostic)',
          } as any;
          if (existing) {
            await credentialVaultClient.updateCredentials({ id: existing.id, body: credBody });
          } else {
            await credentialVaultClient.createCredentials({ body: credBody });
          }
        }
        // Auto-add the provider host to the outbound allowlist so the app can call it directly.
        const def = AI_PROVIDERS[providerKey];
        const host = def.host || hostOf(String(baseUrl || def.baseUrl || ''));
        if (host && providerKey !== 'ollama') {
          await ensureOutboundHost(host);
        }
        return { success: true, data: { provider: providerKey, host, hostAllowed: true } };
      } catch (err: any) {
        console.error('[proxy-api] ai-provider-save-key error:', err.message);
        return { success: false, error: err.message || 'Failed to save AI provider key' };
      }
    }

    if (action === 'github-copilot-check-credential') {
      try {
        const resolved = await resolveGitHubPatCredential();
        if (resolved) {
          return { success: true, data: { configured: true, credentialId: resolved.credentialId, name: resolved.name || GITHUB_CREDENTIAL_NAME } };
        }
        return { success: true, data: { configured: false } };
      } catch (err: any) {
        console.error('[proxy-api] github-copilot-check-credential error:', err.message);
        return { success: false, error: err.message || 'Failed to check credential vault' };
      }
    }

    if (action === 'github-copilot-save-credential') {
      try {
        const { token } = body as { token: string };
        if (!token || !token.startsWith('ghp_') && !token.startsWith('github_pat_')) {
          return { success: false, error: 'Invalid token format. GitHub PATs start with ghp_ or github_pat_' };
        }
        // Check if credential already exists — update it if so
        const creds = await credentialVaultClient.listCredentials({ type: 'TOKEN' });
        const existing = (creds.credentials || []).find(
          (c: any) => c.name === GITHUB_CREDENTIAL_NAME
        );
        if (existing) {
          await credentialVaultClient.updateCredentials({
            id: existing.id,
            body: {
              name: GITHUB_CREDENTIAL_NAME,
              scopes: ['APP_ENGINE'],
              type: 'TOKEN',
              token: token,
              ownerAccessOnly: false,
              description: 'GitHub Personal Access Token for AI-powered prompt generation in Business Observability Demonstrator',
            } as any,
          });
          return { success: true, data: { credentialId: existing.id, updated: true } };
        }
        // Create new
        const result = await credentialVaultClient.createCredentials({
          body: {
            name: GITHUB_CREDENTIAL_NAME,
            scopes: ['APP_ENGINE'],
            type: 'TOKEN',
            token: token,
            ownerAccessOnly: false,
            description: 'GitHub Personal Access Token for AI-powered prompt generation in Business Observability Demonstrator',
          } as any,
        });
        return { success: true, data: { credentialId: result.id, created: true } };
      } catch (err: any) {
        console.error('[proxy-api] github-copilot-save-credential error:', err.message);
        return { success: false, error: err.message || 'Failed to save credential' };
      }
    }

    if (action === 'github-copilot-list-models') {
      try {
        const resolved = await resolveGitHubPatCredential();
        if (!resolved) {
          return { success: true, data: { models: [], configured: false } };
        }

        // Generic generation is pinned to GPT-4.1.
        const copilotModels = [
          { id: 'gpt-4.1', name: 'GPT-4.1', owned_by: 'OpenAI' },
        ];

        return { success: true, data: { models: copilotModels, configured: true } };
      } catch (err: any) {
        console.error('[proxy-api] github-copilot-list-models error:', err.message);
        return { success: true, data: { models: [], configured: true, error: err.message } };
      }
    }

    if (action === 'dynatrace-assist-generate') {
      try {
        const { prompt } = body as { prompt: string };
        if (!prompt) {
          return { success: false, error: 'Prompt is required' };
        }

        const promptText = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
        const boundedPrompt = promptText.length > 12000
          ? `${promptText.slice(0, 12000)}\n\n[Prompt truncated for reliability. Preserve requested output format.]`
          : promptText;

        const result = await callAiProvider({
          prompt: boundedPrompt,
          systemPrompt: 'You are an executive journey analyst. Be specific, concise, and output practical C-Suite recommendations with named journey candidates.',
          temperature: 0.2,
          maxTokens: 2200,
        });
        if (!result.success) {
          return { success: false, error: result.error || 'AI generation failed', code: result.code || 'AI_GENERATION_FAILED', routedVia: result.routedVia };
        }
        return result;
      } catch (err: any) {
        console.error('[proxy-api] dynatrace-assist-generate error:', err.message);
        return { success: false, error: err.message || 'AI generation failed' };
      }
    }

    if (action === 'github-copilot-generate') {
      try {
        const { prompt, model } = body as { prompt: string; model?: string };
        if (!prompt) {
          return { success: false, error: 'Prompt is required' };
        }
        const promptText = typeof prompt === 'string' ? prompt : JSON.stringify(prompt);
        const boundedPrompt = promptText.length > 14000
          ? `${promptText.slice(0, 14000)}\n\n[Prompt truncated for reliability. Preserve requested output format.]`
          : promptText;

        const result = await callAiProvider({
          prompt: boundedPrompt,
          systemPrompt: 'You are a business analyst AI assistant. Follow the output format instructions in the user prompt exactly. When asked for JSON, return raw JSON only (no markdown fences). When asked for natural language, respond with clear professional prose using headings and bullet points.',
          temperature: 0.5,
          maxTokens: 2000,
          configOverride: String(model || '').trim() ? { model: String(model).trim() } : undefined,
        });
        if (!result.success) {
          return { success: false, error: result.error || 'AI generation failed', code: result.code || 'AI_GENERATION_FAILED', routedVia: result.routedVia };
        }
        return result;
      } catch (err: any) {
        console.error('[proxy-api] github-copilot-generate error:', err.message);
        return { success: false, error: err.message || 'AI generation failed' };
      }
    }

    return { success: false, error: `Unknown action: ${action}` };
  } catch (error: any) {
    if (shouldEmitUsageAudit) {
      await emitProxyUsageAudit('failed', 'failure', 500, error.message || 'Connection failed');
    }
    return {
      success: false,
      error: error.message || 'Connection failed',
      details: `Could not reach ${baseUrl}. Check host/port, ensure the server is running, and that your firewall allows inbound TCP on port ${apiPort}.`,
    };
  }
}
