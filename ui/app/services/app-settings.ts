/**
 * App-wide settings persistence via Dynatrace Grail Documents API.
 * 
 * Uses a shared document (visible to ALL users on the tenant) so that
 * when one user configures the EC2 IP / port / protocol, every other
 * user sees the same settings without needing to configure again.
 * 
 * Global-only behavior:
 *   LOAD:  Document API → defaults
 *   SAVE:  Document API only
 */
import { functions } from '@dynatrace-sdk/app-utils';
import { getCurrentUserDetails } from '@dynatrace-sdk/app-environment';

// Well-known document name shared across all users
const APP_SETTINGS_DOC_NAME = 'bizobs-demonstrator-app-settings';
let lastSaveError: string | null = null;

export interface AiProviderSettings {
  provider: 'openai' | 'openai-compatible' | 'azure-openai' | 'github-models' | 'anthropic' | 'ollama';
  model: string;
  baseUrl?: string;
  routeViaVm?: boolean;
}

export interface AppSettings {
  apiHost: string;
  apiPort: string;
  apiProtocol: string;
  enableAutoGeneration: boolean;
  checklistState?: string;
  promptTemplates?: string;
  demoSchedules?: string;
  connectionTested?: boolean;
  ai?: AiProviderSettings;
}

// Keep the ai defaults aligned with AI_PROVIDERS in api/proxy-api.function.ts.
// github-models stays the default so existing installs (which store a GitHub PAT
// under bizobs-github-pat) keep working with no reconfiguration.
export const AI_PROVIDER_DEFAULTS: AiProviderSettings = {
  provider: 'github-models',
  model: 'gpt-4.1',
  baseUrl: '',
  routeViaVm: false,
};

const DEFAULTS: AppSettings = {
  apiHost: 'localhost',
  apiPort: '8080',
  apiProtocol: 'http',
  enableAutoGeneration: false,
  ai: AI_PROVIDER_DEFAULTS,
};

function getAuditUser() {
  const details = getCurrentUserDetails();
  const userEmail = details?.email && !String(details.email).startsWith('dt.missing.user.')
    ? String(details.email).trim().toLowerCase()
    : '';
  const rawName = details?.name && !String(details.name).startsWith('dt.missing.user.')
    ? String(details.name).trim()
    : '';

  return {
    userEmail,
    userName: rawName || (userEmail.includes('@') ? userEmail.split('@')[0] : 'unknown'),
  };
}

/**
 * Load app-wide settings from the shared Grail Document via the serverless proxy.
 * Falls back to defaults if the document doesn't exist or can't be read.
 */
export async function loadAppSettings(): Promise<{ settings: AppSettings; source: 'document' | 'defaults' }> {
  // Try Document API via serverless proxy
  try {
    const res = await functions.call('proxy-api', {
      data: { action: 'load-app-settings', ...getAuditUser() },
    });
    const result = await res.json() as any;
    if (result.success && result.settings) {
      const s = result.settings;
      const settings: AppSettings = {
        apiHost: s.apiHost || DEFAULTS.apiHost,
        apiPort: s.apiPort || DEFAULTS.apiPort,
        apiProtocol: s.apiProtocol || DEFAULTS.apiProtocol,
        enableAutoGeneration: s.enableAutoGeneration || false,
        checklistState: s.checklistState,
        promptTemplates: s.promptTemplates,
        demoSchedules: s.demoSchedules,
        connectionTested: s.connectionTested,
        // Merge over the defaults so a document written before the AI provider
        // work (or a partial ai object) still yields a complete config.
        ai: { ...AI_PROVIDER_DEFAULTS, ...(s.ai || {}) },
      };
      console.log('[AppSettings] ✅ Loaded from shared document:', settings.apiHost);
      return { settings, source: 'document' };
    }
  } catch (err: any) {
    console.warn('[AppSettings] Document load failed:', err.message);
  }

  return { settings: DEFAULTS, source: 'defaults' };
}

/**
 * Save settings to the shared Grail Document (app-wide).
 * Returns true if the document write succeeded.
 */
export async function saveAppSettings(settings: AppSettings): Promise<boolean> {
  lastSaveError = null;

  // Write to shared Document via serverless proxy
  try {
    const res = await functions.call('proxy-api', {
      data: {
        action: 'save-app-settings',
        ...getAuditUser(),
        body: settings,
      },
    });
    const result = await res.json() as any;
    if (result.success) {
      console.log('[AppSettings] ✅ Saved to shared document');
      return true;
    } else {
      const detail = [result.error, result.code ? `code=${result.code}` : ''].filter(Boolean).join(' ');
      lastSaveError = detail || 'Shared document write failed';
      console.warn('[AppSettings] Document save returned:', detail || result.error);
      return false;
    }
  } catch (err: any) {
    lastSaveError = err?.message || 'Shared document write failed';
    console.warn('[AppSettings] Document save failed:', err.message);
    return false;
  }
}

export function getLastAppSettingsSaveError(): string | null {
  return lastSaveError;
}
