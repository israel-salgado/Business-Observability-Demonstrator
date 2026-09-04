/**
 * Dynatrace Event Helper — utility for sending custom events from agents.
 * Wraps the server's sendDynatraceEvent functionality for TypeScript agents.
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { createLogger } from './logger.js';

const log = createLogger('dt-events');

// ─── Load credentials from .dt-credentials.json (matching server.js) ─────
let _cachedCreds: { environmentUrl?: string; apiToken?: string } | null = null;

function loadCredentialsFile(): { environmentUrl?: string; apiToken?: string } {
  if (_cachedCreds) return _cachedCreds;
  try {
    // Walk up from dist/utils/ or utils/ to find .dt-credentials.json at project root
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);
    const candidates = [
      join(__dirname, '..', '.dt-credentials.json'),
      join(__dirname, '..', '..', '.dt-credentials.json'),
      join(process.cwd(), '.dt-credentials.json'),
    ];
    for (const p of candidates) {
      try {
        const raw = readFileSync(p, 'utf-8');
        _cachedCreds = JSON.parse(raw);
        log.debug(`Loaded DT credentials from ${p}`);
        return _cachedCreds!;
      } catch { /* try next */ }
    }
  } catch { /* ignore */ }
  _cachedCreds = {};
  return _cachedCreds;
}

// ─── Types ────────────────────────────────────────────────────

export interface DynatraceEventOptions {
  eventType: 'CUSTOM_DEPLOYMENT' | 'CUSTOM_CONFIGURATION' | 'CUSTOM_INFO' | 'CUSTOM_ANNOTATION';
  title: string;
  description?: string;
  source?: string;
  entitySelector?: string;
  properties?: Record<string, unknown>;
  keepOpen?: boolean;  // For chaos events that should stay open
}

export interface DynatraceEventResult {
  success: boolean;
  status?: number;
  body?: string;
  error?: string;
}

function escapeSelectorValue(value: string): string {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function buildChaosEntitySelectors(target: string): string[] {
  const t = String(target || '').trim();
  if (!t || t.toLowerCase() === 'all' || t.toLowerCase() === 'default') {
    return [];
  }

  const safe = escapeSelectorValue(t);
  return [
    `type(PROCESS_GROUP_INSTANCE),entityName.contains("${safe}")`,
    `type(SERVICE),entityName.contains("${safe}")`,
  ];
}

function normalizeDtEnvironmentUrl(raw: string): string {
  const input = String(raw || '').trim();
  if (!input) return '';
  try {
    const parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
    parsed.hostname = parsed.hostname.replace('.apps.', '.');
    parsed.pathname = '';
    parsed.search = '';
    parsed.hash = '';
    return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
  } catch {
    return input.replace(/\/+$/, '').replace('.apps.', '.').replace(/\/ui\/apps(?:\/.*)?$/i, '');
  }
}

// ─── Core Function ────────────────────────────────────────────

/**
 * Send a custom event to Dynatrace Events API v2.
 * This is a lightweight wrapper around the Events API that matches
 * the server.js implementation but can be used from TypeScript agents.
 *
 * Credential resolution order (matching server.js):
 *   1. Environment variables (DT_ENVIRONMENT / DT_PLATFORM_TOKEN)
 *   2. .dt-credentials.json file (environmentUrl / apiToken)
 */
export async function sendDynatraceEvent(
  options: DynatraceEventOptions
): Promise<DynatraceEventResult> {
  const creds = loadCredentialsFile();
  const DT_ENVIRONMENT = process.env.DT_ENVIRONMENT || process.env.DYNATRACE_URL || creds.environmentUrl;
  const DT_TOKEN = process.env.DT_API_TOKEN || creds.apiToken || process.env.DYNATRACE_TOKEN || process.env.DT_PLATFORM_TOKEN;

  if (!DT_ENVIRONMENT || !DT_TOKEN) {
    log.warn('Dynatrace credentials not configured (no env vars, no .dt-credentials.json apiToken), skipping event');
    return { success: false, error: 'no_credentials' };
  }

  try {
    // Build event payload following Dynatrace Events API v2 schema
    const eventPayload: Record<string, unknown> = {
      eventType: options.eventType,
      title: options.title,
      properties: {
        'dt.event.description': options.description || options.title,
        'deployment.name': options.title,
        'deployment.version': new Date().toISOString(),
        'deployment.project': 'BizObs AI Agents',
        'deployment.source': options.source || 'ai-agent',
        'dt.event.is_rootcause_relevant': 'true',
        'dt.event.deployment.name': options.title,
        'dt.event.deployment.version': new Date().toISOString(),
        'dt.event.deployment.project': 'BizObs AI Agents',
        ...options.properties,
      },
    };

    // Add timeout unless keepOpen is true (for chaos events)
    if (!options.keepOpen) {
      eventPayload.timeout = 15;
    }

    // Add entitySelector if provided
    if (options.entitySelector) {
      eventPayload.entitySelector = options.entitySelector;
    }

    log.debug('Sending Dynatrace event', {
      type: options.eventType,
      title: options.title,
      keepOpen: options.keepOpen,
      entitySelector: options.entitySelector,
    });

    const baseUrl = normalizeDtEnvironmentUrl(DT_ENVIRONMENT);
    const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
    let response: Response | undefined;
    let body = '';
    let lastError = '';

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        response = await fetch(`${baseUrl}/api/v2/events/ingest`, {
          method: 'POST',
          headers: {
            // Only classic access tokens (dt0c01.*) use the Api-Token scheme.
            // Platform tokens (dt0s16.*) and OAuth access tokens use Bearer.
            // Canonical rule lives in utils/dt-auth.cjs; inlined here because this
            // file is compiled by tsc and importing the .cjs helper would need allowJs.
            'Authorization': `${String(DT_TOKEN).startsWith('dt0c') ? 'Api-Token' : 'Bearer'} ${DT_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(eventPayload),
        });

        body = await response.text();
        if (response.ok) {
          log.info('Dynatrace event sent successfully', {
            status: response.status,
            title: options.title,
            attempt,
          });
          return {
            success: true,
            status: response.status,
            body,
          };
        }

        const shouldRetry = (response.status === 429 || response.status >= 500) && attempt < 3;
        if (!shouldRetry) {
          log.error('Dynatrace event failed', {
            status: response.status,
            body: body.substring(0, 200),
          });
          return {
            success: false,
            status: response.status,
            body,
          };
        }

        await sleep(400 * attempt);
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === 3) break;
        await sleep(400 * attempt);
      }
    }

    return {
      success: false,
      status: response?.status,
      body,
      error: lastError || 'events_ingest_failed',
    };

  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.error('Failed to send Dynatrace event', { error, title: options.title });
    return { success: false, error };
  }
}

/**
 * Send a chaos injection event (stays OPEN for problem correlation).
 */
export async function sendChaosEvent(
  chaosId: string,
  chaosType: string,
  target: string,
  details: Record<string, unknown>
): Promise<DynatraceEventResult> {
  const selectors = buildChaosEntitySelectors(target);
  const baseEvent: Omit<DynatraceEventOptions, 'entitySelector'> = {
    eventType: 'CUSTOM_DEPLOYMENT',
    title: `Configuration Change: ${chaosType} on ${target}`,
    description: `Feature flag configuration updated for ${target}. Change ID: ${chaosId}.`,
    source: 'config-manager',
    keepOpen: true,
    properties: {
      'change.type': 'configuration-change',
      'change.id': chaosId,
      'config.type': chaosType,
      'config.target': target,
      'triggered.by': 'config-manager',
      ...details,
    },
  };

  if (selectors.length === 0) {
    return sendDynatraceEvent(baseEvent);
  }

  const results = await Promise.all(
    selectors.map((selector) => sendDynatraceEvent({ ...baseEvent, entitySelector: selector }))
  );
  const primary = results.find((r) => r.success) || results[0] || { success: false, error: 'no_results' };
  return {
    ...primary,
    success: results.some((r) => r.success),
    body: JSON.stringify({
      primaryStatus: primary.status,
      sent: results.length,
      successCount: results.filter((r) => r.success).length,
      statuses: results.map((r) => r.status ?? null),
    }),
  };
}

/**
 * Send a chaos revert event (closes the chaos injection).
 */
export async function sendChaosRevertEvent(
  chaosId: string,
  chaosType: string,
  target: string
): Promise<DynatraceEventResult> {
  const selectors = buildChaosEntitySelectors(target);
  const baseEvent: Omit<DynatraceEventOptions, 'entitySelector'> = {
    eventType: 'CUSTOM_DEPLOYMENT',
    title: `Configuration Rollback: ${chaosType} on ${target}`,
    description: `Feature flag configuration rolled back for ${target}. Change ID: ${chaosId}.`,
    source: 'config-manager',
    keepOpen: false,
    properties: {
      'change.type': 'configuration-rollback',
      'change.id': chaosId,
      'config.type': chaosType,
      'config.target': target,
      'triggered.by': 'config-manager',
    },
  };

  if (selectors.length === 0) {
    return sendDynatraceEvent(baseEvent);
  }

  const results = await Promise.all(
    selectors.map((selector) => sendDynatraceEvent({ ...baseEvent, entitySelector: selector }))
  );
  const primary = results.find((r) => r.success) || results[0] || { success: false, error: 'no_results' };
  return {
    ...primary,
    success: results.some((r) => r.success),
    body: JSON.stringify({
      primaryStatus: primary.status,
      sent: results.length,
      successCount: results.filter((r) => r.success).length,
      statuses: results.map((r) => r.status ?? null),
    }),
  };
}

/**
 * Check if Dynatrace integration is configured.
 */
export function isDynatraceConfigured(): boolean {
  const creds = loadCredentialsFile();
  const DT_ENVIRONMENT = process.env.DT_ENVIRONMENT || process.env.DYNATRACE_URL || creds.environmentUrl;
  const DT_TOKEN = process.env.DT_API_TOKEN || creds.apiToken || process.env.DYNATRACE_TOKEN || process.env.DT_PLATFORM_TOKEN;
  return !!(DT_ENVIRONMENT && DT_TOKEN);
}

export default {
  sendDynatraceEvent,
  sendChaosEvent,
  sendChaosRevertEvent,
  isDynatraceConfigured,
};
