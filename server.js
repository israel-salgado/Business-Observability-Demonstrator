// ...existing code...
/**
 * Dynatrace Partner Power-Up: Business Observability Server
 * Enhanced with separate child processes for proper service splitting in Dynatrace
 */

import express from 'express';
import http from 'http';
import { spawn } from 'child_process';
import { Server as SocketIOServer } from 'socket.io';
import cors from 'cors';
import compression from 'compression';
// morgan removed — per-request HTTP logs are redundant with OTel traces
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import fs from 'fs/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import readline from 'readline';
import { ensureServiceRunning, getServiceNameFromStep, getServicePort, stopAllServices, stopCustomerJourneyServices, getChildServices, getChildServiceMeta, performHealthCheck, getServiceStatus, cleanupOrphanedServiceProcesses, getDormantServices, clearDormantServices, clearDormantServicesForCompany, blockCompany, unblockCompany } from './services/service-manager.js';
import portManager from './services/port-manager.js';
import { startAutoLoadWatcher, stopAutoLoadWatcher, stopAllAutoLoads, getAutoLoadStatus, stopAutoLoad } from './services/auto-load.js';
// Single source of truth for the Dynatrace Authorization header.
// Classic tokens (dt0c01.*) use "Api-Token"; platform tokens (dt0s16.*) and OAuth
// access tokens use "Bearer". See utils/dt-auth.cjs.
import dtAuth from './utils/dt-auth.cjs';

import journeyRouter from './routes/journey.js';
import simulateRouter from './routes/simulate.js';
import metricsRouter from './routes/metrics.js';
import stepsRouter from './routes/steps.js';
import flowRouter from './routes/flow.js';
import serviceProxyRouter from './routes/serviceProxy.js';
import journeySimulationRouter from './routes/journey-simulation.js';
import configRouter from './routes/config.js';
import loadrunnerRouter from './routes/loadrunner-integration.js';
import loadrunnerServiceRouter from './routes/loadrunner-service.js';
import oauthRouter from './routes/oauth.js';
import aiDashboardRouter from './routes/ai-dashboard.js';
import aiGenerateRouter from './routes/ai-generate.js';
import businessFlowRouter from './routes/business-flow.js';
import pdfExportRouter from './routes/pdf-export.js';
import systemMaintenanceRouter from './routes/system-maintenance.js';
// AI Agent Routes (compiled from TypeScript in dist/)
import nemesisRouter from './dist/routes/gremlin.js';
import fixitRouter from './dist/routes/fixit.js';
import librarianRouter from './dist/routes/librarian.js';
import autonomousRouter from './dist/routes/autonomous.js';
import workflowWebhookRouter from './dist/routes/workflow-webhook.js';
// Autonomous Agent Control Functions — loaded dynamically to avoid blocking server if agents not compiled
let startNemesisScheduler = null;
try {
  const autoSched = await import('./dist/agents/gremlin/autonomousScheduler.js');
  startNemesisScheduler = autoSched.startScheduler;
} catch (e) {
  console.warn('⚠️  Nemesis scheduler not available (compile agents first):', e.message);
}
// Fix-It detector available but not auto-started (triggered via workflow webhook instead)
// import { startDetector as startFixitDetector } from './dist/agents/fixit/problemDetector.js';
import mcpServerRouter from './routes/mcp-server.js';
import provisionAccessRouter from './routes/provision-access.js';
import { injectDynatraceMetadata, injectErrorMetadata, propagateMetadata, validateMetadata, createBusinessEventMetadata } from './middleware/dynatrace-metadata.js';
import { performComprehensiveHealthCheck } from './middleware/observability-hygiene.js';
// MongoDB integration removed

dotenv.config();

// Set Dynatrace environment variables for main server process
process.env.DT_SERVICE_NAME = 'bizobs-main-server';
process.env.DYNATRACE_SERVICE_NAME = 'bizobs-main-server';
process.env.DT_LOGICAL_SERVICE_NAME = 'bizobs-main-server';
process.env.DT_APPLICATION_NAME = 'bizobs-main-server';
process.env.DT_PROCESS_GROUP_NAME = 'bizobs-main-server';
process.env.DT_TAGS = 'service=bizobs-main-server';
process.env.DT_CUSTOM_PROP = 'service.splitting=enabled';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BACKEND_VERSION = process.env.npm_package_version || (() => {
  try {
    const pkg = JSON.parse(readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    return String(pkg?.version || 'unknown');
  } catch {
    return 'unknown';
  }
})();

// Ensure Librarian/Nemesis memory storage paths exist for both TS and compiled dist runtimes.
function ensureAgentMemoryStores() {
  const candidates = [
    path.join(__dirname, 'memory', 'history', 'data', 'events.jsonl'),
    path.join(__dirname, 'memory', 'vector', 'data', 'incidents.json'),
    path.join(__dirname, 'dist', 'memory', 'history', 'data', 'events.jsonl'),
    path.join(__dirname, 'dist', 'memory', 'vector', 'data', 'incidents.json'),
  ];

  for (const filePath of candidates) {
    try {
      const dir = path.dirname(filePath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      if (!existsSync(filePath)) {
        writeFileSync(filePath, filePath.endsWith('.jsonl') ? '' : '[]', { flag: 'wx' });
      }
    } catch (err) {
      console.warn('[Startup] Could not initialize memory store path:', filePath, String(err?.message || err));
    }
  }
}

ensureAgentMemoryStores();

const app = express();

// Trust proxy to get correct protocol (HTTPS) from headers
app.set('trust proxy', true);

const server = http.createServer(app);
const io = new SocketIOServer(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

// Configuration with EasyTravel-style ports
const portOffset = parseInt(process.env.PORT_OFFSET || '0');
const PORT = parseInt(process.env.PORT || '8080') + portOffset;

// OneAgent Environment Configuration for Host Monitoring
process.env.DT_RELEASE_PRODUCT = process.env.DT_RELEASE_PRODUCT || 'BizObs-Demonstrator';
process.env.DT_RELEASE_STAGE = process.env.DT_RELEASE_STAGE || 'production';
process.env.DT_CLUSTER_ID = process.env.DT_CLUSTER_ID || 'ace-box-host';
process.env.DT_NODE_ID = process.env.DT_NODE_ID || 'ec2-bizobs-host';

// Main Server Dynatrace Configuration
process.env.DT_SERVICE_NAME = 'BizObs-MainServer';
process.env.DT_APPLICATION_NAME = 'BizObs-MainServer';
process.env.DT_TAGS = 'service=BizObs-MainServer';
process.env.DT_CUSTOM_PROP = 'role=main-server;type=api-gateway';

// Child service management now handled by service-manager.js
// Services are created dynamically based on journey steps

// ============================================
// Feature Flags for Self-Healing
// ============================================
const featureFlags = {
  errorInjectionEnabled: false,   // DISABLED — errors are now controlled per-service via serviceFeatureFlags/Nemesis chaos
  slowResponsesEnabled: true,
  circuitBreakerEnabled: false,
  rateLimitingEnabled: false,
  cacheEnabled: true
};

// Make feature flags available globally for journey simulation
global.featureFlags = featureFlags;

// ============================================
// Dynatrace Credential Storage (persisted to file)
// ============================================
const DT_CREDS_FILE = path.join(__dirname, '.dt-credentials.json');
const dtCredentials = {
  environmentUrl: null,
  apiToken: null,
  configuredAt: null,
  configuredBy: 'none' // 'ui', 'env', 'api'
};

const startupState = {
  credentialsResolved: false,
  dependencyFailures: [],
  serviceStartupCompleted: false,
  serviceStartupSuccessful: 0,
  serviceStartupFailed: 0,
  autoLoadWatcherStarted: false,
  aiAgentsReady: false,
  startupCompletedAt: null,
};

// Load persisted credentials from file (if exists)
try {
  if (existsSync(DT_CREDS_FILE)) {
    const saved = JSON.parse(readFileSync(DT_CREDS_FILE, 'utf-8'));
    dtCredentials.environmentUrl = saved.environmentUrl || null;
    dtCredentials.apiToken = saved.apiToken || null;
    dtCredentials.configuredAt = saved.configuredAt || null;
    dtCredentials.configuredBy = saved.configuredBy || 'ui';
    console.log(`[DT Credentials] Loaded from file: ${dtCredentials.environmentUrl}`);
  }
} catch (e) {
  console.warn('[DT Credentials] Could not load saved credentials:', e.message);
}

// Override with environment variables if set
if (process.env.DT_ENVIRONMENT || process.env.DYNATRACE_URL) {
  dtCredentials.environmentUrl = process.env.DT_ENVIRONMENT || process.env.DYNATRACE_URL;
  dtCredentials.configuredBy = 'env';
}
if (process.env.DT_API_TOKEN) {
  // Prefer explicit API token for event/environment ingest endpoints.
  dtCredentials.apiToken = process.env.DT_API_TOKEN;
  dtCredentials.configuredBy = 'env';
} else if (!dtCredentials.apiToken && process.env.DT_PLATFORM_TOKEN) {
  // Fallback only when no API token exists (some environments use OAuth bearer-style tokens).
  dtCredentials.apiToken = process.env.DT_PLATFORM_TOKEN;
  dtCredentials.configuredBy = 'env';
}

// Log credential status at startup
const credentialStatus = {
  environmentUrlSet: !!dtCredentials.environmentUrl,
  apiTokenSet: !!dtCredentials.apiToken,
  configuredBy: dtCredentials.configuredBy,
  source: dtCredentials.configuredBy === 'env' ? 'Environment Variables' : 
          dtCredentials.configuredBy === 'ui' ? 'Saved File (.dt-credentials.json)' : 'Not Configured',
  ready: !!dtCredentials.environmentUrl && !!dtCredentials.apiToken
};
console.log(`[🔑 DT Credentials] Startup Status:`, credentialStatus);
if (!credentialStatus.ready) {
  console.warn(`[🔑 DT Credentials] ⚠️  Dynatrace integration NOT READY. Set DT_ENVIRONMENT and DT_PLATFORM_TOKEN env vars, or use UI Settings to configure.`);
}

// Helper to persist credentials to file
async function saveDtCredentialsToFile() {
  try {
    await fs.writeFile(DT_CREDS_FILE, JSON.stringify({
      environmentUrl: dtCredentials.environmentUrl,
      apiToken: dtCredentials.apiToken,
      otelToken: dtCredentials.otelToken || null,
      configuredAt: dtCredentials.configuredAt,
      configuredBy: dtCredentials.configuredBy
    }, null, 2));
    console.log('[DT Credentials] Saved to file');
  } catch (e) {
    console.error('[DT Credentials] Failed to save to file:', e.message);
  }
}

// ============================================
// Ollama Mode Configuration
// ============================================
// OLLAMA_MODE: 'auto' (default) = use Ollama only if it's actually reachable
//              'full'           = require Ollama (warn loudly if it's missing)
//              'disabled'       = never call Ollama, use rule-based/template fallbacks
//
// 'auto' is the default so a host that never installed Ollama degrades to templates
// instead of failing every AI call against a dead localhost:11434. Cloud AI providers
// configured in the app's Settings are unaffected by this setting.
const OLLAMA_MODE = (process.env.OLLAMA_MODE || 'auto').toLowerCase();
global.ollamaMode = OLLAMA_MODE;

const OLLAMA_PROBE_ENDPOINT = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434';

if (OLLAMA_MODE === 'disabled') {
  console.log('[Ollama] 🚫 OLLAMA_MODE=disabled — AI features will use rule-based fallbacks');
  console.log('[Ollama]    Dashboard generation: template-based');
  console.log('[Ollama]    Chaos agent: random selection');
  console.log('[Ollama]    Fix-It agent: rule-based diagnosis');
} else {
  // Startup banner only. The authoritative availability check is
  // checkOllamaAvailable() in routes/ai-dashboard.js, which also verifies the
  // model is pulled. Probed in the background so a missing Ollama never blocks boot.
  fetch(`${OLLAMA_PROBE_ENDPOINT}/api/tags`, { signal: AbortSignal.timeout(2000) })
    .then((resp) => resp.ok)
    .catch(() => false)
    .then((reachable) => {
      if (reachable) {
        console.log(`[Ollama] 🤖 Ollama reachable at ${OLLAMA_PROBE_ENDPOINT} — local LLM features enabled`);
      } else if (OLLAMA_MODE === 'full') {
        console.warn(`[Ollama] ⚠️  OLLAMA_MODE=full but nothing is listening on ${OLLAMA_PROBE_ENDPOINT}`);
        console.warn('[Ollama]    Install it:  curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.2:1b');
        console.warn('[Ollama]    Or set OLLAMA_MODE=disabled in .env to use template fallbacks instead.');
      } else {
        console.log(`[Ollama] ℹ️  No Ollama at ${OLLAMA_PROBE_ENDPOINT} — using rule-based/template fallbacks`);
        console.log('[Ollama]    This is fine. Configure a cloud AI provider in the app under Settings → AI Provider,');
        console.log('[Ollama]    or install Ollama for local-model demos.');
      }
    });
}

// ============================================
// Interactive Credential Prompting
// ============================================
function askQuestion(rl, question, defaultVal = '') {
  const prompt = defaultVal ? `${question} [${defaultVal}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

async function promptForCredentials() {
  // If credentials are fully configured (from file or env), skip prompting
  if (dtCredentials.environmentUrl && dtCredentials.apiToken) {
    console.log(`[DT Credentials] ✅ Configured via ${dtCredentials.configuredBy}: ${dtCredentials.environmentUrl}`);
    return;
  }

  // Check if we're running non-interactively (piped stdin, backgrounded, or redirected)
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('[DT Credentials] ⚠️  No credentials found and stdin is not interactive');
    console.log('[DT Credentials] 💡 Configure via: REST API (POST /api/admin/dt-credentials) or environment variables');
    return;
  }

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║          Dynatrace Credential Setup                        ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log('║  No credentials found. Enter your Dynatrace details below. ║');
  console.log('║  Press Enter to skip — you can configure later via the UI. ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log('');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });

  try {
    const envUrl = await askQuestion(rl, '  Dynatrace Environment URL (e.g. https://abc12345.live.dynatrace.com)');
    const apiToken = await askQuestion(rl, '  Dynatrace API Token');
    const otelToken = await askQuestion(rl, '  OpenTelemetry Ingest Token (for traces/metrics/logs, or press Enter to skip)');

    if (envUrl && apiToken) {
      dtCredentials.environmentUrl = envUrl.replace(/\/+$/, '');
      dtCredentials.apiToken = apiToken;
      if (otelToken) {
        dtCredentials.otelToken = otelToken;
      }
      dtCredentials.configuredAt = new Date().toISOString();
      dtCredentials.configuredBy = 'terminal';

      await saveDtCredentialsToFile();
      console.log('');
      console.log(`  ✅ Credentials saved to ${DT_CREDS_FILE}`);
      console.log(`     Environment: ${dtCredentials.environmentUrl}`);
      console.log(`     OTel Token: ${otelToken ? 'Configured' : 'Not set (configure via UI later)'}`);
      console.log('');
    } else {
      console.log('');
      console.log('  ⏭️  Skipped — you can configure credentials later via:');
      console.log('     • UI: Settings → Dynatrace Configuration');
      console.log('     • API: POST /api/admin/dt-credentials');
      console.log('     • Env: DT_ENVIRONMENT + DT_PLATFORM_TOKEN (or DT_API_TOKEN)');
      console.log('');
    }
  } finally {
    rl.close();
  }
}

// Helper: resolve internal service name to Dynatrace entity name and build entitySelector
function buildEntitySelector(serviceNames) {
  if (!serviceNames || serviceNames.length === 0) return null;
  
  const metadata = getChildServiceMeta();
  
  // Map internal names to Dynatrace process group names
  const dtNames = serviceNames.map(name => {
    const meta = metadata[name];
    // Use baseServiceName from metadata, or strip the company suffix as fallback
    return meta?.baseServiceName || name.replace(/-[^-]*$/, '');
  });
  
  // Deduplicate (multiple internal services may map to same DT entity)
  const uniqueNames = [...new Set(dtNames)];
  
  // Use startsWith because Dynatrace names entities like:
  //   "CheckoutAndPaymentService (CheckoutAndPaymentService-node)"
  // so equals("CheckoutAndPaymentService") won't match
  if (uniqueNames.length === 1) {
    return `type("PROCESS_GROUP_INSTANCE"),entityName.startsWith("${uniqueNames[0]}")`;
  }
  
  // For single call with multiple names, return just the first one
  // Use buildEntitySelectorsForServices() instead for proper multi-entity support
  return `type("PROCESS_GROUP_INSTANCE"),entityName.startsWith("${uniqueNames[0]}")`;
}

// Helper: build an ARRAY of entitySelectors — one per running service
// Used when an event should be attached to ALL running services
function buildEntitySelectorsForServices(serviceNames) {
  if (!serviceNames || serviceNames.length === 0) return [];
  
  const metadata = getChildServiceMeta();
  
  // Map to Dynatrace names and deduplicate
  const dtNames = serviceNames.map(name => {
    const meta = metadata[name];
    return meta?.baseServiceName || name.replace(/-[^-]*$/, '');
  });
  const uniqueNames = [...new Set(dtNames)];
  
  return uniqueNames.map(name => `type("PROCESS_GROUP_INSTANCE"),entityName.startsWith("${name}")`);
}

// Helper function to send Dynatrace Events
// If properties.entitySelector is an array, sends one event per selector (for multi-service targeting)
async function sendDynatraceEvent(eventType, properties, dtEnvironmentOverride = null, dtTokenOverride = null) {
  const normalizeDtEnvironmentUrl = (raw) => {
    const input = String(raw || '').trim();
    if (!input) return '';
    try {
      const parsed = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
      parsed.hostname = parsed.hostname.replace('.apps.', '.');
      // In case an app URL is passed, strip UI path/query and keep tenant base URL only.
      parsed.pathname = '';
      parsed.search = '';
      parsed.hash = '';
      return `${parsed.protocol}//${parsed.host}`.replace(/\/+$/, '');
    } catch {
      return input.replace(/\/+$/, '').replace('.apps.', '.').replace(/\/ui\/apps(?:\/.*)?$/i, '');
    }
  };

  const DT_ENVIRONMENT = dtEnvironmentOverride || dtCredentials.environmentUrl || process.env.DT_ENVIRONMENT || process.env.DYNATRACE_URL;
  const DT_TOKEN = dtTokenOverride || process.env.DT_API_TOKEN || dtCredentials.apiToken || process.env.DYNATRACE_TOKEN || process.env.DT_PLATFORM_TOKEN;
  
  if (!DT_ENVIRONMENT || !DT_TOKEN) {
    console.log('[Event API] No Dynatrace credentials configured, skipping event');
    return { success: false, reason: 'no_credentials' };
  }
  
  // If entitySelector is an array, send one event per entity (for multi-service targeting)
  if (Array.isArray(properties.entitySelector)) {
    const selectors = properties.entitySelector;
    console.log(`[Event API] Multi-entity event: sending to ${selectors.length} entities`);
    const results = [];
    for (const selector of selectors) {
      const singleProps = { ...properties, entitySelector: selector };
      const result = await sendDynatraceEvent(eventType, singleProps, dtEnvironmentOverride, dtTokenOverride);
      results.push(result);
    }
    const successCount = results.filter(r => r.success).length;
    return { success: successCount > 0, totalSent: selectors.length, successCount, results };
  }
  
  try {
    // Use CUSTOM_DEPLOYMENT for feature flag changes to show in deployment timeline
    const deploymentEventType = eventType === 'CUSTOM_CONFIGURATION' ? 'CUSTOM_DEPLOYMENT' : eventType;
    
    const eventTitle = properties.title || eventType;
    const eventProps = properties.properties || {};
    
    // Build a human-readable description from the event properties
    const descriptionParts = [eventTitle];
    if (eventProps['feature.flag']) descriptionParts.push(`Flag: ${eventProps['feature.flag']}`);
    if (eventProps['previous.value'] && eventProps['new.value']) descriptionParts.push(`Changed: ${eventProps['previous.value']} → ${eventProps['new.value']}`);
    if (eventProps['feature.flag.targetService']) descriptionParts.push(`Service: ${eventProps['feature.flag.targetService']}`);
    if (eventProps['feature.flag.changes']) descriptionParts.push(`Changes: ${eventProps['feature.flag.changes']}`);
    if (eventProps['change.reason']) descriptionParts.push(`Reason: ${eventProps['change.reason']}`);
    if (eventProps['triggered.by']) descriptionParts.push(`Triggered by: ${eventProps['triggered.by']}`);
    if (eventProps['problem.id'] && eventProps['problem.id'] !== 'N/A') descriptionParts.push(`Problem: ${eventProps['problem.id']}`);
    const autoDescription = descriptionParts.join(' | ');
    
    // For chaos injection events, keep them OPEN (no timeout) so they correlate with problems
    // For other events (like remediation), use default 15-minute timeout
    const isChaosInjection = eventProps['change.type'] === 'chaos-injection' || eventProps['change.type'] === 'configuration-change';
    const shouldStayOpen = properties.keepOpen || isChaosInjection;
    
    const eventPayload = {
      eventType: deploymentEventType,
      title: eventTitle,
      // Only set timeout for non-chaos events; chaos events stay OPEN until explicitly closed
      ...(shouldStayOpen ? {} : { timeout: 15 }),
      properties: {
        'dt.event.description': eventProps['dt.event.description'] || autoDescription,
        'deployment.name': eventProps['deployment.name'] || `Feature Flag: ${eventProps['feature.flag'] || 'unknown'}`,
        'deployment.version': eventProps['deployment.version'] || new Date().toISOString(),
        'deployment.project': eventProps['deployment.project'] || 'BizObs Feature Flags',
        'deployment.source': eventProps['triggered.by'] || 'manual',
        'dt.event.is_rootcause_relevant': 'true',
        'dt.event.deployment.name': eventProps['deployment.name'] || `Feature Flag: ${eventProps['feature.flag'] || 'unknown'}`,
        'dt.event.deployment.version': eventProps['deployment.version'] || new Date().toISOString(),
        'dt.event.deployment.project': eventProps['deployment.project'] || 'BizObs Feature Flags',
        ...eventProps
      },
      ...properties
    };
    
    if (shouldStayOpen) {
      console.log(`[Event API] Creating OPEN event (no timeout) for configuration change - will stay open until explicitly closed`);
    }
    
    // Add entitySelector if provided — targets the event to a specific DT entity
    if (properties.entitySelector) {
      eventPayload.entitySelector = properties.entitySelector;
      console.log(`[Event API] Targeting entity: ${properties.entitySelector}`);
    }
    
    console.log(`[Event API] Sending ${eventPayload.eventType} event to Dynatrace (${eventPayload.title || 'untitled'})`);
    
    const ingestBaseUrl = normalizeDtEnvironmentUrl(DT_ENVIRONMENT);
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    let response;
    let result = '';
    let lastError = null;
    const maxAttempts = 3;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        response = await fetch(`${ingestBaseUrl}/api/v2/events/ingest`, {
          method: 'POST',
          headers: {
            'Authorization': dtAuth.dtAuthHeader(DT_TOKEN),
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(eventPayload)
        });

        result = await response.text();
        if (response.ok) {
          return { success: true, status: response.status, body: result };
        }

        console.warn(`[Event API] Attempt ${attempt}/${maxAttempts} failed with HTTP ${response.status}. URL: ${ingestBaseUrl}/api/v2/events/ingest. Response: ${result.substring(0, 300)}`);

        const shouldRetry = (response.status === 429 || response.status >= 500) && attempt < maxAttempts;
        if (!shouldRetry) {
          console.error('[Event API] Non-retriable error. Response:', response.status, result);
          return { success: false, status: response.status, body: result, reason: `HTTP ${response.status}` };
        }

        await sleep(400 * attempt);
      } catch (err) {
        lastError = err;
        console.warn(`[Event API] Attempt ${attempt}/${maxAttempts} network error: ${String(err?.message)}. URL: ${ingestBaseUrl}/api/v2/events/ingest`);
        if (attempt === maxAttempts) break;
        await sleep(400 * attempt);
      }
    }

    if (lastError) {
      return { success: false, error: lastError.message, reason: 'network_error' };
    }
    return { success: false, status: response?.status, body: result, reason: response ? `HTTP ${response.status}` : 'unknown' };
  } catch (error) {
    console.error('[Event API] Error sending event:', error);
    return { success: false, error: error.message };
  }
}

// startChildService is now in service-manager.js

// ensureServiceRunning is now in service-manager.js

// Helper to call child service and get JSON response with enhanced error handling
function callChildService(serviceName, payload, port, tracingHeaders = {}) {
  return new Promise((resolve, reject) => {
    const targetPort = port;
    
    // Propagate Dynatrace metadata from original headers
    const propagatedHeaders = propagateMetadata(tracingHeaders, {
      'dt.service-call': 'child-service',
      'dt.target-service': serviceName
    });
    
    const options = {
      hostname: '127.0.0.1',
      port: targetPort,
      path: '/process',
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'x-correlation-id': (tracingHeaders['x-correlation-id'] || payload?.correlationId) || uuidv4(),
        ...propagatedHeaders
      }
    };
    
    const req = http.request(options, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = body ? JSON.parse(body) : {};
          
          // Check if the response indicates an error
          if (json.status === 'error' || json.traceError || res.headers['x-trace-error']) {
            console.error(`[main-server] Service ${serviceName} returned error:`, json.error || 'Unknown error');
            
            // Propagate trace error information
            const error = new Error(json.error || `Service ${serviceName} failed`);
            error.traceError = true;
            error.serviceName = serviceName;
            error.errorType = json.errorType || 'ServiceError';
            error.httpStatus = res.statusCode;
            error.correlationId = json.correlationId;
            error.response = json;
            
            reject(error);
            return;
          }
          
          // Success response
          resolve(json);
        } catch (e) {
          const parseError = new Error(`Invalid JSON from ${serviceName}: ${e.message}`);
          parseError.traceError = true;
          parseError.serviceName = serviceName;
          parseError.errorType = 'JSONParseError';
          reject(parseError);
        }
      });
    });
    
    req.on('error', (error) => {
      console.error(`[main-server] Network error calling ${serviceName}:`, error.message);
      const networkError = new Error(`Network error calling ${serviceName}: ${error.message}`);
      networkError.traceError = true;
      networkError.serviceName = serviceName;
      networkError.errorType = 'NetworkError';
      reject(networkError);
    });
    
    // Set timeout for service calls
    req.setTimeout(30000, () => {
      req.destroy();
      const timeoutError = new Error(`Timeout calling service ${serviceName}`);
      timeoutError.traceError = true;
      timeoutError.serviceName = serviceName;
      timeoutError.errorType = 'TimeoutError';
      reject(timeoutError);
    });
    
    req.end(JSON.stringify(payload || {}));
  });
}

// Middleware
app.use(cors());
app.use(compression());
// morgan removed — traces/biz events provide request observability
app.use(express.json({ limit: '10mb' })); // Increase JSON payload limit
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Inject Dynatrace metadata for ACE-Box compatibility
app.use(injectDynatraceMetadata);

// Frontend host label (avoid showing raw 'localhost')
function hostToLabel(host) {
  if (!host) return 'Unknown Host';
  if (process.env.APP_DOMAIN_LABEL) return process.env.APP_DOMAIN_LABEL;
  if (host.includes('localhost') || host.startsWith('127.')) return 'Local Dev';
  return host;
}

function sanitizeAuditToken(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractAuditIdentity(req) {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const query = req.query && typeof req.query === 'object' ? req.query : {};
  const headerEmail = req.headers['x-user-email'] || req.headers['x-forwarded-email'] || req.headers['x-authenticated-user-email'];
  const email = String(body.userEmail || body.email || query.userEmail || query.email || headerEmail || '').trim().toLowerCase();
  const headerName = req.headers['x-user-name'] || req.headers['x-authenticated-user-name'];
  const userName = String(body.userName || query.userName || headerName || (email.includes('@') ? email.split('@')[0] : 'unknown')).trim();
  return {
    userEmail: email,
    userName: userName || 'unknown',
  };
}

function shouldEmitApiAudit(req) {
  if (!req.path || !req.path.startsWith('/api/')) return false;
  if (req.path === '/api/internal/bizevent') return false;
  if (req.path.startsWith('/api/health')) return false;
  if (req.path === '/api/ready') return false;
  return true;
}

async function emitApiUsageAudit(req, details) {
  const pathname = req.path || '/api/unknown';
  const pathParts = pathname.split('/').filter(Boolean);
  const feature = sanitizeAuditToken(pathParts[1] || 'app') || 'app';
  const action = sanitizeAuditToken(pathParts.slice(2).join('-') || req.method || 'request') || 'request';
  const eventType = `bizevents.audit.usage.${feature}.${action}`;
  const { userEmail, userName } = extractAuditIdentity(req);
  const statusBucket = details.statusCode >= 500 ? 'failure' : details.statusCode >= 400 ? 'warning' : 'success';

  const payload = {
    companyName: process.env.ACCESS_REQUEST_COMPANY_NAME || 'Dynatrace Internal',
    journeyType: process.env.ACCESS_REQUEST_JOURNEY_TYPE || 'Application Usage',
    stepName: eventType,
    serviceName: 'BizObsApiGateway',
    correlationId: req.correlationId,
    domain: req.hostname || 'localhost',
    eventType,
    userName,
    userEmail,
    feature,
    journeyStatus: statusBucket === 'failure' ? 'Failed' : statusBucket === 'warning' ? 'Warning' : 'Success',
    additionalFields: {
      hasError: statusBucket === 'failure',
      statusBucket,
      statusCode: details.statusCode,
      method: req.method,
      path: pathname,
      durationMs: details.durationMs,
      frontendHost: req.frontendHostLabel || 'unknown',
      userAgent: req.headers['user-agent'] || '',
      source: 'api-usage-audit',
      userName,
      userEmail,
      feature,
    },
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-correlation-id': req.correlationId,
    ...createBusinessEventMetadata(eventType, eventType, {
      companyName: payload.companyName,
      domain: payload.domain,
      industryType: 'application-observability',
      customerId: userEmail || 'anonymous',
      status: statusBucket,
      source: 'api-usage-audit',
      channel: 'web',
    }),
    'x-biz-correlation-id': req.correlationId || '',
    'x-biz-user-name': userName,
    'x-biz-user-email': userEmail,
    'x-biz-feature': feature,
    'x-biz-additional-status-code': String(details.statusCode),
    'x-biz-additional-status-bucket': statusBucket,
    'x-biz-additional-method': String(req.method || ''),
    'x-biz-additional-path': pathname.substring(0, 100),
    'x-biz-additional-duration-ms': String(details.durationMs),
  };

  try {
    await fetch(`http://127.0.0.1:${process.env.PORT || 8080}/process`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  } catch (error) {
    console.warn('[api-audit] Failed to emit usage audit event:', error.message);
  }
}

// Attach helpful request context and distributed tracing
app.use((req, res, next) => {
  const cid = req.headers['x-correlation-id'] || uuidv4();
  req.correlationId = cid;
  res.setHeader('x-correlation-id', cid);
  const requestStartedAt = Date.now();

  // Extract and preserve all Dynatrace tracing headers for propagation
  req.tracingHeaders = {};
  const headerKeys = Object.keys(req.headers || {});
  for (const key of headerKeys) {
    const lowerKey = key.toLowerCase();
    // Capture Dynatrace, W3C Trace Context, and other distributed tracing headers
    if (lowerKey.startsWith('x-dynatrace') || 
        lowerKey.startsWith('traceparent') || 
        lowerKey.startsWith('tracestate') || 
        lowerKey.startsWith('x-trace') || 
        lowerKey.startsWith('x-request-id') || 
        lowerKey.startsWith('x-correlation-id') || 
        lowerKey.startsWith('x-span-id') || 
        lowerKey.startsWith('dt-') ||
        lowerKey.startsWith('uber-trace-id')) {
      req.tracingHeaders[key] = req.headers[key];
    }
  }

  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  req.frontendHostLabel = hostToLabel(host);
  res.setHeader('X-App-Domain-Label', req.frontendHostLabel);

  // Expose Socket.IO on request for route handlers
  req.io = io;

  if (shouldEmitApiAudit(req)) {
    res.once('finish', () => {
      const durationMs = Date.now() - requestStartedAt;
      emitApiUsageAudit(req, {
        statusCode: res.statusCode,
        durationMs,
      });
    });
  }

  next();
});

// Enhanced event service for separate process communication
const eventService = {
  async emitEvent(eventType, data) {
    try {
      const { stepName, substeps } = data;
      const companyName = data.companyName || 'DefaultCompany';
      const domain = data.domain || 'default.com';
      const industryType = data.industryType || 'general';
      const journeyType = data.journeyType || data.journeyDetail || '';
      const correlationId = data.correlationId || uuidv4();
      
      // per-step logging removed — covered by traces
      
      if (substeps && substeps.length > 0) {
        // Process each substep through its dedicated service
        const results = [];
        
        for (const substep of substeps) {
          // Substeps use substepName property, not stepName
          const substepName = substep.substepName || substep.stepName;
          const serviceName = getServiceNameFromStep(substepName);
          
          try {
            // Ensure the service is running using service manager
            ensureServiceRunning(substepName, {
              companyName,
              domain,
              industryType,
              journeyType,
              journeyDetail: data.journeyDetail || journeyType,
              stepName: substepName,
              serviceName,
            });
            
            // Wait a moment for service to be ready
            await new Promise(resolve => setTimeout(resolve, 100));
            
            // Call the dedicated service
            const payload = {
              ...substep,
              stepName: substepName,  // Normalize to stepName for service
              correlationId,
              parentStep: stepName,
              timestamp: new Date().toISOString()
            };
            
            const servicePort = await getServicePort(substepName, companyName);
            const result = await callChildService(serviceName, payload, servicePort);
            results.push(result);
            
            // per-service success log removed
          } catch (error) {
            console.error(`❌ Error processing ${serviceName}:`, error.message);
            
            // Create comprehensive error result with trace information
            const errorResult = {
              stepName: substepName,
              service: serviceName,
              status: 'error',
              error: error.message,
              errorType: error.errorType || error.constructor.name,
              traceError: error.traceError || true,
              httpStatus: error.httpStatus || 500,
              correlationId,
              timestamp: new Date().toISOString()
            };
            
            // If this is a trace error, add additional context
            if (error.traceError) {
              errorResult.traceFailed = true;
              errorResult.serviceName = error.serviceName;
              
              // Emit trace failure event
              io.emit('trace_failure', {
                correlationId,
                stepName: substepName,
                serviceName,
                error: error.message,
                errorType: error.errorType,
                timestamp: new Date().toISOString()
              });
            }
            
            results.push(errorResult);
          }
        }
        
        // Emit results to connected clients
        io.emit('simulation_result', {
          correlationId,
          eventType,
          stepName,
          results,
          timestamp: new Date().toISOString()
        });
        
        return { success: true, correlationId, results };
      }
      
      return { success: true, correlationId, message: 'No substeps to process' };
    } catch (error) {
      console.error('Event emission error:', error);
      return { success: false, error: error.message };
    }
  }
};

// Socket.IO connection handling
io.on('connection', (socket) => {
  socket.on('disconnect', () => {});
});

// Routes
app.use('/api/journey', journeyRouter);
app.use('/api/simulate', simulateRouter);
app.use('/api/metrics', metricsRouter);
app.use('/api/steps', stepsRouter);
app.use('/api/flow', flowRouter);
app.use('/api/service-proxy', serviceProxyRouter);
app.use('/api/journey-simulation', journeySimulationRouter);
app.use('/api/config', configRouter);
app.use('/api/loadrunner', loadrunnerRouter);
app.use('/api/loadrunner-service', loadrunnerServiceRouter);
app.use('/api/oauth', oauthRouter);
app.use('/api/ai-dashboard', aiDashboardRouter);
app.use('/api/ai-generate', aiGenerateRouter);
app.use('/api/business-flow', businessFlowRouter);
app.use('/api/pdf', pdfExportRouter);
app.use('/api/system', systemMaintenanceRouter);
// AI Agent Routes
app.use('/api/gremlin', nemesisRouter.default || nemesisRouter);
app.use('/api/fixit', fixitRouter.default || fixitRouter);
app.use('/api/librarian', librarianRouter.default || librarianRouter);
app.use('/api/autonomous', autonomousRouter.default || autonomousRouter);
app.use('/api/workflow-webhook', workflowWebhookRouter.default || workflowWebhookRouter);
app.use('/api/mcp', mcpServerRouter);
app.use('/api/provision-access', provisionAccessRouter);

// 🚦 FEATURE FLAG API - Generic, scalable, future-proof
// Default values for all feature flags
const DEFAULT_FEATURE_FLAGS = {
  errors_per_transaction: 0,
  errors_per_visit: 0,
  errors_per_minute: 0,
  regenerate_every_n_transactions: 100
};

// Current feature flag values (starts as copy of defaults)
let globalFeatureFlags = { ...DEFAULT_FEATURE_FLAGS };

// Per-service overrides — only services listed here get elevated/modified error rates
// Structure: { "PaymentService": { errors_per_transaction: 0.8, ... }, ... }
const CHAOS_STATE_FILE = path.join(__dirname, '.chaos-state.json');
const serviceFeatureFlags = {};

// Load persisted chaos state on startup
try {
  if (existsSync(CHAOS_STATE_FILE)) {
    const saved = JSON.parse(readFileSync(CHAOS_STATE_FILE, 'utf-8'));
    if (saved.serviceFeatureFlags) {
      Object.assign(serviceFeatureFlags, saved.serviceFeatureFlags);
      console.log(`🔄 [Chaos Persistence] Restored ${Object.keys(saved.serviceFeatureFlags).length} service overrides from disk`);
    }
    if (saved.globalFeatureFlags) {
      Object.assign(globalFeatureFlags, saved.globalFeatureFlags);
      console.log(`🔄 [Chaos Persistence] Restored global feature flags from disk`);
    }
  }
} catch (e) {
  console.warn('⚠️ [Chaos Persistence] Failed to load saved chaos state:', e.message);
}

// Expose serviceFeatureFlags globally so journey-simulation can check chaos state
global.serviceFeatureFlags = serviceFeatureFlags;

function saveChaosState() {
  try {
    const state = {
      serviceFeatureFlags,
      globalFeatureFlags,
      savedAt: new Date().toISOString()
    };
    writeFileSync(CHAOS_STATE_FILE, JSON.stringify(state, null, 2));
    console.log(`💾 [Chaos Persistence] Saved chaos state (${Object.keys(serviceFeatureFlags).length} service overrides)`);
  } catch (e) {
    console.warn('⚠️ [Chaos Persistence] Failed to save chaos state:', e.message);
  }
}

// GET all feature flags (with optional filtering by journey/company/service)
app.get('/api/feature_flag', async (req, res) => {
  const { journey, company, companyName, service } = req.query;
  
  // Get currently running journeys and companies from active tests and services
  const { getChildServiceMeta } = await import('./services/service-manager.js');
  const metadata = getChildServiceMeta();
  
  // Extract unique companies and journeys from active services
  const runningCompanies = new Set();
  const runningJourneys = new Set();
  const activeServicesByCompany = {};
  
  Object.entries(metadata).forEach(([serviceName, meta]) => {
    if (meta.companyName) {
      runningCompanies.add(meta.companyName);
      if (!activeServicesByCompany[meta.companyName]) {
        activeServicesByCompany[meta.companyName] = {
          companyName: meta.companyName,
          industry: meta.industry,
          domain: meta.domain,
          services: [],
          journeyType: meta.journeyType || null
        };
      }
      activeServicesByCompany[meta.companyName].services.push(serviceName);
      
      if (meta.journeyType) {
        runningJourneys.add(meta.journeyType);
        activeServicesByCompany[meta.companyName].journeyType = meta.journeyType;
      }
    }
  });
  
  // Add LoadRunner test data
  const activeTestData = Object.values(loadTests).map(test => ({
    companyName: test.companyName,
    scenarioType: test.scenarioType,
    uptime: Math.floor((Date.now() - new Date(test.startTime).getTime()) / 1000)
  }));
  
  activeTestData.forEach(test => {
    if (test.companyName) {
      runningCompanies.add(test.companyName);
      if (!activeServicesByCompany[test.companyName]) {
        activeServicesByCompany[test.companyName] = {
          companyName: test.companyName,
          services: [],
          journeyType: test.scenarioType || null
        };
      }
      if (test.scenarioType) {
        runningJourneys.add(test.scenarioType);
        activeServicesByCompany[test.companyName].journeyType = test.scenarioType;
      }
    }
  });
  
  const baseService = req.query.baseService;
  
  const filterInfo = journey ? `journey: ${journey}` : 
                     (company || companyName) ? `company: ${company || companyName}` : 
                     service ? `service: ${service}` :
                     'global';
  
  // verbose flag dump removed
  
  // If a specific service is requesting, return per-service override if it exists
  // Check BOTH the compound name (service) AND the base name (baseService)
  // This allows chaos targeting by clean service name to work for all instances
  let effectiveFlags = { ...globalFeatureFlags };
  if (service || baseService) {
    // Try compound name first (most specific), then base name (for chaos targeting)
    let svcOverride = service ? serviceFeatureFlags[service] : null;
    if (!svcOverride && baseService) {
      svcOverride = serviceFeatureFlags[baseService];
      if (svcOverride) {
        // matched base service override log removed
      }
    }
    
    if (svcOverride) {
      // This service has a targeted override — merge it on top of defaults
      effectiveFlags = { ...DEFAULT_FEATURE_FLAGS, ...svcOverride };
      if (service === baseService || !baseService) {
        // targeted override log removed
      }
    } else {
      // No override for this service — use safe defaults (no elevated error rate)
      effectiveFlags = { ...DEFAULT_FEATURE_FLAGS };
      // no override log removed
    }
  }
  
  res.json({
    success: true,
    flags: effectiveFlags,
    defaults: DEFAULT_FEATURE_FLAGS,
    serviceOverrides: (service || baseService) ? (serviceFeatureFlags[service] || serviceFeatureFlags[baseService] || null) : serviceFeatureFlags,
    targetedServices: Object.keys(serviceFeatureFlags),
    currently_running: {
      companies: Array.from(runningCompanies),
      journeys: Array.from(runningJourneys),
      active_by_company: activeServicesByCompany,
      total_companies: runningCompanies.size,
      total_journeys: runningJourneys.size
    },
    filter: {
      journey: journey || null,
      company: company || companyName || null
    },
    timestamp: new Date().toISOString()
  });
});

// POST to set feature flags (can target specific company/journey from workflow)
app.post('/api/feature_flag', async (req, res) => {
  const body = req.body;
  
  // Check if this is the full GET response payload from step 1
  let targetCompanies = [];
  let targetJourneys = [];
  let actionToPerform = null;
  let previousFlags = { ...globalFeatureFlags };
  
  // If body contains 'currently_running' (from GET response), extract from it
  if (body.currently_running) {
    targetCompanies = body.currently_running.companies || [];
    targetJourneys = body.currently_running.journeys || [];
    actionToPerform = 'disable'; // Default action when GET payload is sent
    
    console.log('📦 [Feature Flags API] POST - Received GET payload, extracting running entities:', {
      companies: targetCompanies,
      journeys: targetJourneys
    });
  } 
  // Otherwise, check for explicit fields
  else {
    const { companies, journeys, companyName, journeyType, action, flags, targetService } = body;
    targetCompanies = companies || (companyName ? [companyName] : []);
    targetJourneys = journeys || (journeyType ? [journeyType] : []);
    actionToPerform = action;
    
    // Handle direct flag updates — per-service or global
    if (flags && typeof flags === 'object') {
      const changes = [];
      
      if (targetService) {
        // ═══ PER-SERVICE OVERRIDE ═══
        // Only the targeted service gets these flags; all others stay at defaults
        if (!serviceFeatureFlags[targetService]) {
          serviceFeatureFlags[targetService] = { ...DEFAULT_FEATURE_FLAGS };
        }
        Object.entries(flags).forEach(([key, value]) => {
          const oldValue = serviceFeatureFlags[targetService][key] ?? DEFAULT_FEATURE_FLAGS[key];
          serviceFeatureFlags[targetService][key] = value;
          changes.push({
            flag: key,
            previous_value: oldValue,
            new_value: value,
            scope: 'service',
            service: targetService
          });
          console.log(`🎯 [Feature Flags API] POST - ${targetService}.${key}: ${oldValue} → ${value}`);
        });
        
        // Send Dynatrace custom event for per-service flag change — targeted to the DT entity
        const chaosChangeSummary = changes.map(c => `${c.flag} changed from ${c.previous_value} to ${c.new_value}`).join('; ');
        sendDynatraceEvent('CUSTOM_CONFIGURATION', {
          title: `Configuration Change: ${targetService}`,
          entitySelector: buildEntitySelector([targetService]),
          properties: {
            'dt.event.description': `Configuration update on service ${targetService}. ${chaosChangeSummary}.`,
            'deployment.name': `Config Update: ${targetService}`,
            'deployment.project': 'BizObs Feature Flags',
            'deployment.version': `cfg-${Date.now()}`,
            'feature.flag.scope': 'per-service',
            'feature.flag.targetService': targetService,
            'feature.flag.changes': JSON.stringify(changes),
            'triggered.by': body.triggeredBy || 'config-manager',
            'application': 'BizObs',
            'change.type': 'configuration-change',
            'change.impact': 'Service behavior modified'
          }
        });
        
        saveChaosState();
        return res.json({
          success: true,
          message: `Feature flags set for service: ${targetService}`,
          changes: changes,
          targetService: targetService,
          serviceFlags: serviceFeatureFlags[targetService],
          targetedServices: Object.keys(serviceFeatureFlags),
          timestamp: new Date().toISOString()
        });
      }
      
      // ═══ GLOBAL UPDATE (no targetService) ═══
      Object.entries(flags).forEach(([key, value]) => {
        if (key in globalFeatureFlags) {
          const oldValue = globalFeatureFlags[key];
          globalFeatureFlags[key] = value;
          changes.push({
            flag: key,
            previous_value: oldValue,
            new_value: value,
            scope: 'global'
          });
          
          console.log(`🎛️  [Feature Flags API] POST - ${key}: ${oldValue} → ${value}`);
        }
      });
      
      saveChaosState();
      return res.json({
        success: true,
        message: 'Feature flags updated',
        changes: changes,
        applied_to: {
          companies: targetCompanies.length > 0 ? targetCompanies : 'all',
          journeys: targetJourneys.length > 0 ? targetJourneys : 'all'
        },
        flags: globalFeatureFlags,
        timestamp: new Date().toISOString()
      });
    }
  }
  
  // Execute the action (disable/enable)
  if (actionToPerform === 'disable' || actionToPerform === 'stop') {
    const changes = [{
      flag: 'errors_per_transaction',
      previous_value: previousFlags.errors_per_transaction,
      new_value: 0
    }];
    
    globalFeatureFlags.errors_per_transaction = 0;
    
    console.log(`⏸️  [Feature Flags API] POST - Errors DISABLED for:`, {
      companies: targetCompanies.length > 0 ? targetCompanies : 'all',
      journeys: targetJourneys.length > 0 ? targetJourneys : 'all'
    });
    
    saveChaosState();
    return res.json({
      success: true,
      message: `Feature flags disabled for ${targetCompanies.length} ${targetCompanies.length === 1 ? 'company' : 'companies'}`,
      action: 'disable',
      changes: changes,
      applied_to: {
        companies: targetCompanies.length > 0 ? targetCompanies : 'all',
        journeys: targetJourneys.length > 0 ? targetJourneys : 'all',
        total_affected: targetCompanies.length
      },
      flags: globalFeatureFlags,
      previous_flags: previousFlags,
      timestamp: new Date().toISOString()
    });
  }
  
  if (actionToPerform === 'enable' || actionToPerform === 'start') {
    const changes = [{
      flag: 'errors_per_transaction',
      previous_value: previousFlags.errors_per_transaction,
      new_value: 0
    }];
    
    globalFeatureFlags.errors_per_transaction = 0;
    
    console.log(`▶️  [Feature Flags API] POST - Errors ENABLED for:`, {
      companies: targetCompanies.length > 0 ? targetCompanies : 'all',
      journeys: targetJourneys.length > 0 ? targetJourneys : 'all'
    });
    
    saveChaosState();
    return res.json({
      success: true,
      message: `Feature flags enabled for ${targetCompanies.length} ${targetCompanies.length === 1 ? 'company' : 'companies'}`,
      action: 'enable',
      changes: changes,
      applied_to: {
        companies: targetCompanies.length > 0 ? targetCompanies : 'all',
        journeys: targetJourneys.length > 0 ? targetJourneys : 'all',
        total_affected: targetCompanies.length
      },
      flags: globalFeatureFlags,
      previous_flags: previousFlags,
      timestamp: new Date().toISOString()
    });
  }
  
  res.status(400).json({
    success: false,
    error: 'Missing action or valid payload in request body',
    hint: 'Send the full GET response from /api/feature_flag, or specify action: "disable"|"enable"',
    expected: {
      option1: 'Send full GET /api/feature_flag response',
      option2: {
        action: 'disable|enable',
        companies: ['CompanyName'],
        journeys: ['JourneyType']
      },
      option3: {
        flags: { errors_per_transaction: 0 }
      }
    }
  });
});

// GET all per-service overrides (MUST be before /:flag_name wildcard)
app.get('/api/feature_flag/services', (req, res) => {
  res.json({
    success: true,
    serviceOverrides: serviceFeatureFlags,
    targetedServices: Object.keys(serviceFeatureFlags),
    count: Object.keys(serviceFeatureFlags).length,
    defaults: DEFAULT_FEATURE_FLAGS,
    timestamp: new Date().toISOString()
  });
});

// DELETE all per-service overrides (used by revert-all to ensure clean slate)
app.delete('/api/feature_flag/services', (req, res) => {
  const previousCount = Object.keys(serviceFeatureFlags).length;
  const previousServices = Object.keys(serviceFeatureFlags);
  
  // Clear all service overrides
  for (const key of Object.keys(serviceFeatureFlags)) {
    delete serviceFeatureFlags[key];
  }
  
  // Also reset global error rate to safe defaults
  globalFeatureFlags.errors_per_transaction = 0;
  
  saveChaosState();
  
  console.log(`🧹 [Feature Flags API] ALL service overrides cleared (was ${previousCount}: ${previousServices.join(', ')})`);
  
  res.json({
    success: true,
    cleared: previousCount,
    previousServices,
    message: `Cleared all ${previousCount} service overrides`,
    timestamp: new Date().toISOString()
  });
});

// GET specific feature flag
app.get('/api/feature_flag/:flag_name', (req, res) => {
  const { flag_name } = req.params;
  
  if (!(flag_name in globalFeatureFlags)) {
    return res.status(404).json({
      success: false,
      error: `Feature flag '${flag_name}' not found`,
      available_flags: Object.keys(globalFeatureFlags)
    });
  }
  
  console.log(`📊 [Feature Flags API] GET ${flag_name}:`, globalFeatureFlags[flag_name]);
  res.json({
    success: true,
    flag: flag_name,
    value: globalFeatureFlags[flag_name],
    default: DEFAULT_FEATURE_FLAGS[flag_name],
    timestamp: new Date().toISOString()
  });
});

// PUT to set feature flag value
app.put('/api/feature_flag/:flag_name', (req, res) => {
  const { flag_name } = req.params;
  const { value } = req.body;
  
  if (!(flag_name in globalFeatureFlags)) {
    return res.status(404).json({
      success: false,
      error: `Feature flag '${flag_name}' not found`,
      available_flags: Object.keys(globalFeatureFlags)
    });
  }
  
  if (value === undefined) {
    return res.status(400).json({
      success: false,
      error: 'Missing "value" in request body'
    });
  }
  
  const oldValue = globalFeatureFlags[flag_name];
  globalFeatureFlags[flag_name] = value;
  
  // Special logging for error control
  if (flag_name === 'errors_per_transaction') {
    if (value === 0) {
      console.log(`⏸️  [Feature Flags API] ${flag_name}: ${oldValue} → ${value} (DISABLED - Self-healing active!)`);
    } else {
      console.log(`🎛️  [Feature Flags API] ${flag_name}: ${oldValue} → ${value}`);
    }
  } else {
    console.log(`🎛️  [Feature Flags API] ${flag_name}: ${oldValue} → ${value}`);
  }
  
  saveChaosState();
  res.json({
    success: true,
    flag: flag_name,
    value: globalFeatureFlags[flag_name],
    previous_value: oldValue,
    message: `Feature flag '${flag_name}' updated`,
    timestamp: new Date().toISOString()
  });
});

// DELETE to reset feature flag to default
app.delete('/api/feature_flag/:flag_name', (req, res) => {
  const { flag_name } = req.params;
  
  if (!(flag_name in globalFeatureFlags)) {
    return res.status(404).json({
      success: false,
      error: `Feature flag '${flag_name}' not found`,
      available_flags: Object.keys(globalFeatureFlags)
    });
  }
  
  const oldValue = globalFeatureFlags[flag_name];
  const defaultValue = DEFAULT_FEATURE_FLAGS[flag_name];
  globalFeatureFlags[flag_name] = defaultValue;
  
  console.log(`🔄 [Feature Flags API] ${flag_name} RESET: ${oldValue} → ${defaultValue} (default)`);
  
  saveChaosState();
  res.json({
    success: true,
    flag: flag_name,
    value: globalFeatureFlags[flag_name],
    previous_value: oldValue,
    message: `Feature flag '${flag_name}' reset to default`,
    timestamp: new Date().toISOString()
  });
});

// DELETE per-service override — removes targeted chaos from a specific service
app.delete('/api/feature_flag/service/:serviceName', (req, res) => {
  const { serviceName } = req.params;
  const hadOverride = !!serviceFeatureFlags[serviceName];
  const previousFlags = serviceFeatureFlags[serviceName] ? { ...serviceFeatureFlags[serviceName] } : null;
  
  delete serviceFeatureFlags[serviceName];
  
  console.log(`🧹 [Feature Flags API] Service override removed: ${serviceName} (had override: ${hadOverride})`);
  
  // Send Dynatrace event for the revert — targeted to the DT entity
  sendDynatraceEvent('CUSTOM_CONFIGURATION', {
    title: `Configuration Rollback: ${serviceName}`,
    entitySelector: buildEntitySelector([serviceName]),
    keepOpen: true,
    properties: {
      'dt.event.description': `Configuration rollback for ${serviceName}. Previous flags: ${previousFlags ? JSON.stringify(previousFlags) : 'none'}. Service returned to default configuration.`,
      'deployment.name': `Config Rollback: ${serviceName}`,
      'deployment.project': 'BizObs Feature Flags',
      'deployment.version': `rollback-${Date.now()}`,
      'feature.flag.scope': 'per-service-revert',
      'feature.flag.targetService': serviceName,
      'feature.flag.previous': previousFlags ? JSON.stringify(previousFlags) : 'none',
      'triggered.by': 'config-manager',
      'application': 'BizObs',
      'change.type': 'configuration-rollback',
      'change.impact': 'Service configuration restored to defaults'
    }
  });
  
  saveChaosState();
  res.json({
    success: true,
    serviceName: serviceName,
    removed: hadOverride,
    previousFlags: previousFlags,
    remainingOverrides: Object.keys(serviceFeatureFlags),
    message: hadOverride ? `Override removed for ${serviceName}` : `No override existed for ${serviceName}`,
    timestamp: new Date().toISOString()
  });
});

// 🔄 BACKWARD COMPATIBILITY - Old error-config API
// Redirects to new feature flag API for existing integrations
app.get('/api/error-config', (req, res) => {
  console.log('⚠️  [Legacy API] /api/error-config called (use /api/feature_flag instead)');
  res.json({
    success: true,
    config: globalFeatureFlags,
    status: globalFeatureFlags.errors_per_transaction === 0 ? 'disabled' : 'enabled',
    timestamp: new Date().toISOString()
  });
});

app.post('/api/error-config', (req, res) => {
  console.log('⚠️  [Legacy API] /api/error-config POST called (use PUT /api/feature_flag/:flag_name instead)');
  const { errors_per_transaction, regenerate_every_n_transactions, action } = req.body;
  
  // Handle action shortcuts
  if (action === 'disable' || action === 'stop') {
    globalFeatureFlags.errors_per_transaction = 0;
    console.log('⏸️  [Feature Flags API] errors_per_transaction: DISABLED via legacy action');
  } else if (action === 'enable' || action === 'start') {
    globalFeatureFlags.errors_per_transaction = 0;
    console.log('▶️  [Feature Flags API] errors_per_transaction: ENABLED via legacy action');
  } else {
    if (typeof errors_per_transaction === 'number') {
      globalFeatureFlags.errors_per_transaction = Math.max(0, Math.min(1, errors_per_transaction));
    }
    if (typeof regenerate_every_n_transactions === 'number') {
      globalFeatureFlags.regenerate_every_n_transactions = Math.max(10, regenerate_every_n_transactions);
    }
  }
  
  saveChaosState();
  res.json({
    success: true,
    message: 'Configuration updated via legacy API',
    config: globalFeatureFlags,
    timestamp: new Date().toISOString()
  });
});

// Make feature flags available to other modules
export function getGlobalErrorConfig() {
  return globalFeatureFlags;
}

export function getFeatureFlags() {
  return globalFeatureFlags;
}

function handleInternalBusinessEvent(req, res) {
  // This endpoint exists solely for OneAgent to capture HTTP requests with flattened headers
  // The real business event data is in the headers and request body
  const flattenedFields = {};
  
  // Extract flattened fields from headers
  Object.keys(req.headers).forEach(key => {
    if (key.startsWith('x-biz-')) {
      const fieldName = key.replace('x-biz-', '').replace(/-/g, '.');
      flattenedFields[fieldName] = req.headers[key];
    }
  });
  
  // per-request biz event log removed — data captured via biz events
  
  // Return success - OneAgent will capture this HTTP request/response
  res.status(200).json({ 
    success: true, 
    message: 'Business event captured',
    flattenedFieldCount: Object.keys(flattenedFields).length
  });
}

// Main compatibility endpoint for Dynatrace BizEvent capture rules
app.post('/process', handleInternalBusinessEvent);

// Legacy internal endpoint kept for backward compatibility
app.post('/api/internal/bizevent', handleInternalBusinessEvent);

// Health check endpoint with metadata validation
app.get('/health', (req, res) => {
    const metadata = req.dynatraceMetadata || {};
    const validation = validateMetadata(res.getHeaders());
    
    res.status(200).json({ 
        status: 'healthy', 
        timestamp: new Date().toISOString(),
        services: 'running',
        metadata: {
            injected: Object.keys(metadata).length,
            validation: validation
        }
    });
});

// Favicon endpoint
app.get('/favicon.ico', (req, res) => {
    res.status(204).end();
});

// Enhanced error testing endpoint
app.post('/api/test/error-trace', async (req, res) => {
  try {
    const { stepName = 'TestStep', shouldFail = false, errorType = 'TestError' } = req.body;
    
    if (shouldFail) {
      // Simulate a trace error
      const error = new Error(`Simulated ${errorType} in ${stepName}`);
      error.traceError = true;
      error.errorType = errorType;
      error.stepName = stepName;
      
      console.error('[test-error] Simulating trace failure:', error.message);
      throw error;
    }
    
    res.json({
      status: 'success',
      message: 'Error trace test completed successfully',
      stepName,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[test-error] Trace error captured:', error.message);
    
    res.setHeader('x-trace-error', 'true');
    res.setHeader('x-error-type', error.errorType || 'TestError');
    
    res.status(500).json({
      status: 'error',
      error: error.message,
      errorType: error.errorType || 'TestError',
      traceError: true,
      stepName: error.stepName,
      timestamp: new Date().toISOString()
    });
  }
});

// --- Admin endpoint to reset all dynamic service ports (for UI Reset button) ---
app.post('/api/admin/reset-ports', async (req, res) => {
  try {
    console.log('🛑 [Admin] KILL ALL: Stopping all load generators and services...');
    
    // Step 0: Stop the auto-load watcher + all auto-load generators
    stopAutoLoadWatcher();
    stopAllAutoLoads();
    
    // Step 1: Stop all LoadRunner service tests (these respawn services if left running)
    try {
      const lrStopRes = await fetch(`http://localhost:${process.env.PORT || 8080}/api/loadrunner-service/stop-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const lrResult = await lrStopRes.json();
      console.log('🛑 [Admin] LoadRunner service tests stopped:', lrResult.message || 'done');
    } catch (e) {
      console.log('🛑 [Admin] No LoadRunner service tests to stop:', e.message);
    }
    
    // Step 2: Stop old-style loadTests (server.js managed)
    for (const [companyName, test] of Object.entries(loadTests)) {
      try {
        if (test.process) test.process.kill();
        console.log(`🛑 [Admin] Killed old-style load test for ${companyName}`);
      } catch (e) { /* ignore */ }
      delete loadTests[companyName];
    }
    
    // Step 3: Stop Continuous Journey Generator if running
    if (global.continuousJourneyProcess) {
      try {
        global.continuousJourneyProcess.kill();
        global.continuousJourneyProcess = null;
        console.log('🛑 [Admin] Continuous Journey Generator stopped');
      } catch (e) { /* ignore */ }
    }
    
    // Step 4: Stop all child services and free ports
    await stopAllServices();
    
    // Step 5: Force kill any remaining orphaned processes
    try {
      const { execSync } = await import('child_process');
      execSync('pkill -9 -f "dynamic-step-service" 2>/dev/null', { stdio: 'ignore' });
      execSync('pkill -9 -f "loadrunner-simulator" 2>/dev/null', { stdio: 'ignore' });
    } catch (e) { /* ignore if no processes found */ }
    
    console.log('✅ [Admin] KILL ALL complete: all load generators and services stopped');
    res.json({ ok: true, message: 'All load generators, services, and ports stopped and freed.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Reset endpoint — stops everything, leaves server clean (no default services)
app.post('/api/admin/reset-and-restart', async (req, res) => {
  try {
    // Stop all services and free ports
    stopAllServices();
    console.log('🔄 All dynamic services stopped and ports freed.');
    
    // Wait a moment for cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // No default services — everything starts on-demand from the Demonstrator UI
    console.log('✅ Reset complete — server is clean, launch journeys from the Demonstrator UI');
    
    res.json({ 
      ok: true, 
      message: 'Reset complete. All services stopped. Launch journeys from the Demonstrator UI to start services.'
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Admin endpoint to ensure a specific service is running (used by chained child services) ---
app.post('/api/admin/ensure-service', async (req, res) => {
  try {
    const { stepName, serviceName, context } = req.body || {};
    if (!stepName && !serviceName) {
      return res.status(400).json({ ok: false, error: 'stepName or serviceName required' });
    }
    const port = await ensureServiceRunning(stepName || serviceName, { serviceName, ...(context || {}) });
    res.json({ ok: true, port: port });  // Return the allocated port
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Admin endpoint to list running dynamic services (simple format) ---
app.get('/api/admin/services', (req, res) => {
  try {
    const running = getChildServices();
    const items = Object.entries(running).map(([name, proc]) => ({
      service: name,
      pid: proc?.pid || null
    }));
    res.json({ ok: true, services: items });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Admin endpoint to get detailed service status including startup information ---
app.get('/api/admin/services/status', (req, res) => {
  try {
    const running = getChildServices();
    const metadata = getChildServiceMeta();
    const detailedServices = Object.entries(running).map(([name, proc]) => {
      const meta = metadata[name] || {};
      const startTime = meta.startTime || null;
      const port = meta.port || 'unknown';  // Don't call async getServicePort here
      
      return {
        service: name,
        pid: proc?.pid || null,
        status: proc?.pid ? 'running' : 'stopped',
        startTime: startTime,
        uptime: startTime ? Math.floor((Date.now() - new Date(startTime).getTime()) / 1000) : 0,
        port: port,
        stepName: meta.stepName || meta.baseServiceName || name,  // Include step name for display
        companyContext: {
          companyName: meta.companyName || 'unknown',
          domain: meta.domain || 'unknown',
          industryType: meta.industryType || 'unknown'
        }
      };
    });
    
    res.json({ 
      ok: true, 
      timestamp: new Date().toISOString(),
      totalServices: detailedServices.length,
      runningServices: detailedServices.filter(s => s.status === 'running').length,
      services: detailedServices,
      serverUptime: Math.floor(process.uptime()),
      serverPid: process.pid
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- NEW: Enhanced service status grouped by company with detailed metrics ---
app.get('/api/admin/services/by-company', async (req, res) => {
  try {
    const { getServicesGroupedByCompany } = await import('./services/service-manager.js');
    const groupedServices = await getServicesGroupedByCompany();
    
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      ...groupedServices
    });
  } catch (e) {
    console.error('[API] Error fetching grouped services:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Service history tracking
const serviceHistory = {
  configurations: [],  // Historic service configs
  maxHistory: 50
};

// Load test tracking
const loadTests = {};

// Stop ALL services and load runners - complete reset
app.post('/api/admin/stop-all-and-clear', async (req, res) => {
  try {
    console.log('🛑 [Admin] Stopping all services and load runners...');
    
    // Stop the auto-load watcher completely
    stopAutoLoadWatcher();
    
    // Stop all auto-load generators
    stopAllAutoLoads();
    
    // Stop all LoadRunner tests
    const loadRunnerManager = (await import('./scripts/continuous-loadrunner.js')).default;
    const stoppedTests = await loadRunnerManager.stopAllTests();
    
    // Stop all child services (this clears internal tracking)
    await stopAllServices();
    
    // Force kill any remaining processes with extreme prejudice
    const { execSync } = await import('child_process');
    try {
      execSync('pkill -9 -f "dynamic-step-service" 2>/dev/null', { stdio: 'ignore' });
      execSync('pkill -9 -f "loadrunner-simulator" 2>/dev/null', { stdio: 'ignore' });
      execSync('pkill -9 -f "Service-" 2>/dev/null', { stdio: 'ignore' });
    } catch (e) {
      // Ignore errors if no processes found
    }
    
    // Double-check: Verify all services are cleared from service manager
    const { getChildServices } = await import('./services/service-manager.js');
    const remainingServices = Object.keys(getChildServices());
    if (remainingServices.length > 0) {
      console.warn(`[Admin] Warning: ${remainingServices.length} services still tracked:`, remainingServices);
    }
    
    console.log('✅ [Admin] All services and load runners stopped');
    
    res.json({
      ok: true,
      message: 'All services and load runners stopped and cleared',
      stoppedTests: stoppedTests || 0,
      servicesStopped: true,
      servicesCleared: remainingServices.length === 0,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    console.error('[Admin] Error stopping all:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stop individual service
app.post('/api/admin/services/stop', async (req, res) => {
  try {
    const { serviceName } = req.body;
    if (!serviceName) {
      return res.status(400).json({ ok: false, error: 'serviceName required' });
    }
    
    const { stopService, getChildServices } = await import('./services/service-manager.js');
    const services = getChildServices();
    
    if (!services[serviceName]) {
      return res.status(404).json({ ok: false, error: `Service ${serviceName} not found` });
    }
    
    await stopService(serviceName);
    res.json({ ok: true, message: `Service ${serviceName} stopped`, serviceName });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stop all services by company
app.post('/api/admin/services/stop-by-company', async (req, res) => {
  try {
    const { companyName, journeyType, allowRestart } = req.body;
    if (!companyName) {
      return res.status(400).json({ ok: false, error: 'companyName required' });
    }

    const normalizedJourneyType = String(journeyType || '').trim().toLowerCase();
    const stopExactJourneyOnly = normalizedJourneyType.length > 0;

    console.log(`🛑 [Admin] STOP ${stopExactJourneyOnly ? 'BY COMPANY+JOURNEY' : 'BY COMPANY'}: ${companyName}${stopExactJourneyOnly ? ` / ${journeyType}` : ''}`);

    // For whole-company stops, block recreation briefly while teardown completes.
    if (!stopExactJourneyOnly) {
      blockCompany(companyName);

      // Stop auto-load for this company (prevents watcher from firing new journeys)
      stopAutoLoad(companyName);

      // Stop the continuous LoadRunner test for this company
      try {
        await fetch(`http://localhost:${process.env.PORT || 8080}/api/journey-simulation/continuous-generation/stop/${encodeURIComponent(companyName)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }
        });
        console.log(`🛑 [Admin] Stopped continuous journey generation for ${companyName}`);
      } catch (e) { /* ignore */ }

      // Kill any loadrunner-simulator processes for this company
      try {
        const { execSync } = await import('child_process');
        execSync(`pkill -9 -f "loadrunner-simulator.*${companyName}"`, { stdio: 'ignore' });
        console.log(`🛑 [Admin] Killed loadrunner-simulator processes for ${companyName}`);
      } catch (e) { /* pkill returns 1 if no match, that's fine */ }
    }

    // Small delay to let in-flight requests drain
    await new Promise(resolve => setTimeout(resolve, 500));

    // Now stop the actual services
    const { getChildServices, getChildServiceMeta, stopService } = await import('./services/service-manager.js');
    const services = getChildServices();
    const metadata = getChildServiceMeta();
    
    const stoppedServices = [];
    for (const [serviceName] of Object.entries(services)) {
      const meta = metadata[serviceName] || {};
      const sameCompany = meta.companyName === companyName;
      const sameJourney = !stopExactJourneyOnly || String(meta.journeyType || meta.journeyDetail || '').trim().toLowerCase() === normalizedJourneyType;
      if (sameCompany && sameJourney) {
        await stopService(serviceName);
        stoppedServices.push(serviceName);
      }
    }
    
    // Force kill any zombie processes for this company only on full-company stops.
    if (!stopExactJourneyOnly) {
      try {
        const { execSync } = await import('child_process');
        execSync(`pkill -9 -f "${companyName}.*Service"`, { stdio: 'ignore' });
      } catch (e) { /* ignore */ }
    }

    if (allowRestart) {
      unblockCompany(companyName);
    }
    
    console.log(`✅ [Admin] Stopped ${stoppedServices.length} service(s) for ${companyName}${stopExactJourneyOnly ? ` / ${journeyType}` : ''}`);
    
    res.json({ 
      ok: true, 
      message: `Stopped ${stoppedServices.length} service(s) for ${companyName}${stopExactJourneyOnly ? ` / ${journeyType}` : ''}`,
      companyName,
      journeyType: journeyType || null,
      stoppedServices
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stop all services by industry type
app.post('/api/admin/services/stop-by-industry', async (req, res) => {
  try {
    const { industryType } = req.body;
    if (!industryType) {
      return res.status(400).json({ ok: false, error: 'industryType required' });
    }
    
    const { getChildServices, getChildServiceMeta, stopService } = await import('./services/service-manager.js');
    const services = getChildServices();
    const metadata = getChildServiceMeta();
    
    const stoppedServices = [];
    for (const [serviceName, proc] of Object.entries(services)) {
      const meta = metadata[serviceName] || {};
      if (meta.industryType === industryType) {
        await stopService(serviceName);
        stoppedServices.push(serviceName);
      }
    }
    
    res.json({ 
      ok: true, 
      message: `Stopped ${stoppedServices.length} services for industry ${industryType}`,
      industryType,
      stoppedServices
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stop all services and load generators (nuclear option)
app.post('/api/admin/services/stop-everything', async (req, res) => {
  try {
    console.log('🛑 [Admin] STOP EVERYTHING: Stopping all load generators and services...');
    
    // Stop the auto-load watcher completely (prevents new companies from being auto-loaded)
    stopAutoLoadWatcher();
    
    // Stop all auto-load generators
    stopAllAutoLoads();
    
    try {
      const lrStopRes = await fetch(`http://localhost:${process.env.PORT || 8080}/api/loadrunner-service/stop-all`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }
      });
      await lrStopRes.json();
    } catch (e) { /* ignore */ }
    
    // Stop old-style loadTests
    for (const [cn, test] of Object.entries(loadTests)) {
      try { if (test.process) test.process.kill(); } catch (e) { /* ignore */ }
      delete loadTests[cn];
    }
    
    // Stop continuous journey generator
    if (global.continuousJourneyProcess) {
      try { global.continuousJourneyProcess.kill(); global.continuousJourneyProcess = null; } catch (e) { /* ignore */ }
    }
    
    // Stop all child services
    await stopAllServices();
    
    // Force kill orphans
    try {
      const { execSync } = await import('child_process');
      execSync('pkill -9 -f "dynamic-step-service" 2>/dev/null', { stdio: 'ignore' });
    } catch (e) { /* ignore */ }
    
    console.log('✅ [Admin] STOP EVERYTHING complete');
    res.json({ ok: true, message: 'All load generators, services, and ports stopped.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ════════════════════════════════════════════════════════════
// DORMANT SERVICES ENDPOINTS
// ════════════════════════════════════════════════════════════

// Get dormant (stopped but remembered) services
app.get('/api/admin/services/dormant', (req, res) => {
  try {
    const dormant = getDormantServices();
    const dormantList = Object.entries(dormant).map(([name, meta]) => ({
      serviceName: name,
      companyName: meta.companyName || 'Unknown',
      domain: meta.domain || 'unknown',
      industryType: meta.industryType || 'unknown',
      journeyType: meta.journeyType || null,
      baseServiceName: meta.baseServiceName || name,
      stepName: meta.stepName || 'unknown',
      previousPort: meta.previousPort,
      serviceVersion: meta.serviceVersion || null,
      stoppedAt: meta.stoppedAt
    }));
    res.json({
      ok: true,
      dormantServices: dormantList,
      count: dormantList.length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Clear dormant services (all or per-company)
app.post('/api/admin/services/clear-dormant', (req, res) => {
  try {
    const { companyName } = req.body || {};
    let cleared;
    if (companyName) {
      cleared = clearDormantServicesForCompany(companyName);
    } else {
      cleared = clearDormantServices();
    }
    res.json({ ok: true, cleared });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Save service configuration to history
app.post('/api/admin/services/save-config', async (req, res) => {
  try {
    const { getChildServices, getChildServiceMeta } = await import('./services/service-manager.js');
    const services = getChildServices();
    const metadata = getChildServiceMeta();
    
    const config = {
      timestamp: new Date().toISOString(),
      services: Object.entries(services).map(([name, proc]) => ({
        serviceName: name,
        ...metadata[name]
      }))
    };
    
    serviceHistory.configurations.unshift(config);
    if (serviceHistory.configurations.length > serviceHistory.maxHistory) {
      serviceHistory.configurations.pop();
    }
    
    res.json({ ok: true, config, historyCount: serviceHistory.configurations.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get service history
app.get('/api/admin/services/history', (req, res) => {
  try {
    res.json({ 
      ok: true, 
      history: serviceHistory.configurations,
      count: serviceHistory.configurations.length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Restore services from history
app.post('/api/admin/services/restore', async (req, res) => {
  try {
    const { timestamp } = req.body;
    const config = serviceHistory.configurations.find(c => c.timestamp === timestamp);
    
    if (!config) {
      return res.status(404).json({ ok: false, error: 'Configuration not found' });
    }
    
    const { ensureServiceRunning } = await import('./services/service-manager.js');
    const restoredServices = [];
    
    for (const svc of config.services) {
      try {
        await ensureServiceRunning(svc.serviceName, svc);
        restoredServices.push(svc.serviceName);
      } catch (err) {
        console.error(`Failed to restore ${svc.serviceName}:`, err);
      }
    }
    
    res.json({ 
      ok: true, 
      message: `Restored ${restoredServices.length}/${config.services.length} services`,
      restoredServices
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Delete configuration from history
app.post('/api/admin/services/history/delete', (req, res) => {
  try {
    const { timestamp } = req.body;
    if (!timestamp) {
      return res.status(400).json({ ok: false, error: 'timestamp required' });
    }
    
    const index = serviceHistory.configurations.findIndex(c => c.timestamp === timestamp);
    if (index === -1) {
      return res.status(404).json({ ok: false, error: 'Configuration not found' });
    }
    
    serviceHistory.configurations.splice(index, 1);
    
    res.json({ 
      ok: true, 
      message: '✅ Configuration deleted',
      remaining: serviceHistory.configurations.length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Start load test
app.post('/api/admin/loadtest/start', async (req, res) => {
  try {
    const { companyName, scenarioType = 'light-load' } = req.body;
    if (!companyName) {
      return res.status(400).json({ ok: false, error: 'companyName required' });
    }
    
    if (loadTests[companyName]) {
      return res.status(400).json({ ok: false, error: `Load test already running for ${companyName}` });
    }
    
    const { spawn } = await import('child_process');
    const loadTestPath = path.join(process.cwd(), 'scripts', 'loadrunner-simulator.js');
    const testConfigPath = path.join(process.cwd(), 'loadrunner-tests', companyName);
    
    const proc = spawn('node', [loadTestPath, testConfigPath, scenarioType], {
      detached: false,
      stdio: 'pipe'
    });
    
    loadTests[companyName] = {
      pid: proc.pid,
      companyName,
      scenarioType,
      startTime: new Date().toISOString(),
      process: proc
    };
    
    proc.on('exit', () => {
      delete loadTests[companyName];
    });
    
    res.json({ 
      ok: true, 
      message: `Load test started for ${companyName}`,
      pid: proc.pid,
      companyName
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Stop load test
app.post('/api/admin/loadtest/stop', async (req, res) => {
  try {
    const { companyName } = req.body;
    if (!companyName) {
      return res.status(400).json({ ok: false, error: 'companyName required' });
    }
    
    const loadTest = loadTests[companyName];
    if (!loadTest) {
      return res.status(404).json({ ok: false, error: `No load test running for ${companyName}` });
    }
    
    loadTest.process.kill();
    delete loadTests[companyName];
    
    res.json({ 
      ok: true, 
      message: `Load test stopped for ${companyName}`,
      companyName
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Get load test status
app.get('/api/admin/loadtest/status', (req, res) => {
  try {
    const activeTests = Object.values(loadTests).map(test => ({
      companyName: test.companyName,
      pid: test.pid,
      scenarioType: test.scenarioType,
      startTime: test.startTime,
      uptime: Math.floor((Date.now() - new Date(test.startTime).getTime()) / 1000)
    }));
    
    res.json({ 
      ok: true, 
      activeTests,
      count: activeTests.length
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// --- Auto-Load Status endpoint ---
app.get('/api/admin/auto-load/status', (req, res) => {
  try {
    res.json({ ok: true, ...getAutoLoadStatus() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Global trace validation store for debugging
const traceValidationStore = {
  recentCalls: [],
  maxEntries: 50
};

// --- Admin endpoint for trace validation debugging ---
app.get('/api/admin/trace-validation', (req, res) => {
  try {
    const { limit = 10 } = req.query;
    const recentCalls = traceValidationStore.recentCalls
      .slice(-parseInt(limit))
      .reverse(); // Most recent first
    
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      totalCalls: traceValidationStore.recentCalls.length,
      recentCalls: recentCalls,
      summary: {
        callsWithTraceparent: recentCalls.filter(c => c.traceparent).length,
        callsWithTracestate: recentCalls.filter(c => c.tracestate).length,
        callsWithDynatraceId: recentCalls.filter(c => c.x_dynatrace_trace_id).length,
        uniqueTraceIds: [...new Set(recentCalls.map(c => c.traceparent?.split('-')[1]).filter(Boolean))].length
      }
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Helper function to record trace validation data
function recordTraceValidation(stepName, headers, response) {
  const entry = {
    timestamp: new Date().toISOString(),
    stepName,
    traceparent: headers.traceparent || null,
    tracestate: headers.tracestate || null,
    x_dynatrace_trace_id: headers['x-dynatrace-trace-id'] || null,
    x_correlation_id: headers['x-correlation-id'] || null,
    responseStatus: response?.httpStatus || null,
    responseTraceparent: response?.traceparent || null
  };
  
  traceValidationStore.recentCalls.push(entry);
  
  // Keep only recent entries
  if (traceValidationStore.recentCalls.length > traceValidationStore.maxEntries) {
    traceValidationStore.recentCalls = traceValidationStore.recentCalls.slice(-traceValidationStore.maxEntries);
  }
}

// Make recordTraceValidation available globally for journey simulation
global.recordTraceValidation = recordTraceValidation;

// --- Admin endpoint to restart all core services ---
app.post('/api/admin/services/restart-all', async (req, res) => {
  try {
    console.log('🔄 Stopping all services (clean restart)...');
    
    // Stop auto-load generators
    stopAllAutoLoads();
    
    // Stop all current services
    stopAllServices();
    
    // Wait a moment for cleanup
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // No default services — everything starts on-demand from the Demonstrator UI
    console.log('✅ All services stopped — server is clean, launch journeys from the Demonstrator UI');
    
    res.json({ ok: true, message: 'All services stopped. Launch journeys from the Demonstrator UI to start services.' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Simple test endpoint
app.get('/api/test', (req, res) => {
  // test endpoint log removed
  res.json({ status: 'working', timestamp: new Date().toISOString() });
});

// Health check with service status
// ============================================
// Dynatrace Credentials Management (UI-based)
// ============================================

// Save Dynatrace credentials from UI
app.post('/api/admin/dt-credentials', async (req, res) => {
  try {
    const { environmentUrl, apiToken } = req.body;
    
    if (!environmentUrl) {
      return res.status(400).json({
        ok: false,
        error: 'environmentUrl is required'
      });
    }
    
    // If no token provided and no existing token, require it
    if (!apiToken && !dtCredentials.apiToken) {
      return res.status(400).json({
        ok: false,
        error: 'apiToken is required (no existing token on server)'
      });
    }
    
    // Validate URL format
    if (!environmentUrl.startsWith('https://') && !environmentUrl.startsWith('http://')) {
      return res.status(400).json({
        ok: false,
        error: 'Environment URL must start with https:// or http://'
      });
    }
    
    // Clean up URL (remove trailing slash)
    const cleanUrl = environmentUrl.replace(/\/+$/, '');
    
    dtCredentials.environmentUrl = cleanUrl;
    if (apiToken) {
      dtCredentials.apiToken = apiToken;
    }
    dtCredentials.configuredAt = new Date().toISOString();
    dtCredentials.configuredBy = 'ui';
    
    const tokenForPreview = apiToken || dtCredentials.apiToken;
    console.log(`[DT Credentials] Configured via UI: ${cleanUrl}`);
    
    // Persist to file
    await saveDtCredentialsToFile();
    
    res.json({
      ok: true,
      environmentUrl: cleanUrl,
      tokenPreview: tokenForPreview.substring(0, 6) + '...' + tokenForPreview.slice(-4),
      configuredAt: dtCredentials.configuredAt
    });
  } catch (error) {
    console.error('[DT Credentials] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get credential status (never expose the actual token)
app.get('/api/admin/dt-credentials/status', (req, res) => {
  const hasEnv = !!dtCredentials.environmentUrl;
  const hasToken = !!dtCredentials.apiToken;
  
  res.json({
    ok: true,
    configured: hasEnv && hasToken,
    environmentUrl: dtCredentials.environmentUrl || null,
    tokenConfigured: hasToken,
    tokenPreview: hasToken ? dtCredentials.apiToken.substring(0, 6) + '...' + dtCredentials.apiToken.slice(-4) : null,
    configuredAt: dtCredentials.configuredAt,
    configuredBy: dtCredentials.configuredBy,
    source: dtCredentials.configuredBy === 'env' ? 'Environment Variables' : 
            dtCredentials.configuredBy === 'ui' ? 'UI Settings' : 'Not Configured'
  });
});

// Test Dynatrace connection by sending a test event
app.post('/api/admin/dt-credentials/test', async (req, res) => {
  try {
    const envUrl = dtCredentials.environmentUrl;
    const token = dtCredentials.apiToken;
    const normalizeDtEnvironmentUrl = (raw) => {
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
    };
    
    if (!envUrl || !token) {
      return res.json({
        ok: false,
        error: 'Credentials not configured. Please save your Environment URL and API Token first.'
      });
    }
    
    // Send a test event
    const testPayload = {
      eventType: 'CUSTOM_INFO',
      title: 'BizObs Generator Connection Test',
      timeout: 5,
      properties: {
        'source': 'BizObs Generator',
        'test.type': 'connection_verification',
        'timestamp': new Date().toISOString()
      }
    };
    
    const ingestBaseUrl = normalizeDtEnvironmentUrl(envUrl);
    const response = await fetch(`${ingestBaseUrl}/api/v2/events/ingest`, {
      method: 'POST',
      headers: {
        'Authorization': dtAuth.dtAuthHeader(token),
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(testPayload)
    });
    
    const body = await response.text();
    
    if (response.ok) {
      res.json({
        ok: true,
        message: 'Connection successful! Test event sent to Dynatrace.',
        status: response.status,
        response: body
      });
    } else {
      res.json({
        ok: false,
        error: `Dynatrace returned ${response.status}: ${body}`,
        status: response.status
      });
    }
  } catch (error) {
    console.error('[DT Test] Connection test error:', error);
    res.json({
      ok: false,
      error: `Connection failed: ${error.message}`
    });
  }
});

// Clear credentials
app.delete('/api/admin/dt-credentials', async (req, res) => {
  dtCredentials.environmentUrl = null;
  dtCredentials.apiToken = null;
  dtCredentials.configuredAt = null;
  dtCredentials.configuredBy = 'none';
  // Remove persisted file
  try { await fs.unlink(DT_CREDS_FILE); } catch (e) { /* ignore if not exists */ }
  console.log('[DT Credentials] Cleared via UI');
  res.json({ ok: true, message: 'Credentials cleared' });
});

// ============================================
// Dynatrace API Proxy — agents use these to query DT
// using the UI-configured credentials
// ============================================

// Helper: make authenticated DT API request using stored credentials
async function dtProxyFetch(apiPath, params = {}) {
  const envUrl = dtCredentials.environmentUrl || process.env.DT_ENVIRONMENT || process.env.DYNATRACE_URL;
  const token = dtCredentials.apiToken || process.env.DT_PLATFORM_TOKEN || process.env.DYNATRACE_TOKEN || process.env.DT_API_TOKEN;
  
  if (!envUrl || !token) {
    return { error: 'Dynatrace credentials not configured. Use the Settings gear icon to set them.', configured: false };
  }
  
  const url = new URL(apiPath, envUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  
  const res = await fetch(url.toString(), {
    headers: { 'Authorization': dtAuth.dtAuthHeader(token), 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000)
  });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`DT API ${res.status}: ${text.substring(0, 300)}`);
  }
  
  return await res.json();
}

// GET /api/dt-proxy/problems — fetch active problems from Dynatrace
app.get('/api/dt-proxy/problems', async (req, res) => {
  try {
    const timeframe = req.query.from || 'now-2h';
    const status = req.query.status || undefined;
    const params = { from: timeframe, pageSize: '50' };
    if (status) params.problemSelector = `status("${status}")`;
    
    const data = await dtProxyFetch('/api/v2/problems', params);
    if (data.error) return res.json({ ok: false, problems: [], ...data });
    
    res.json({ ok: true, problems: data.problems || [], totalCount: data.totalCount || 0 });
  } catch (err) {
    console.error('[DT Proxy] Problems fetch failed:', err.message);
    res.json({ ok: false, problems: [], error: err.message });
  }
});

// GET /api/dt-proxy/problems/:id — fetch specific problem details
app.get('/api/dt-proxy/problems/:problemId', async (req, res) => {
  try {
    const data = await dtProxyFetch(`/api/v2/problems/${req.params.problemId}`);
    if (data.error) return res.json({ ok: false, ...data });
    
    res.json({ ok: true, problem: data });
  } catch (err) {
    console.error('[DT Proxy] Problem details fetch failed:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/dt-proxy/events — fetch recent events from Dynatrace
app.get('/api/dt-proxy/events', async (req, res) => {
  try {
    const timeframe = req.query.from || 'now-2h';
    const eventType = req.query.eventType || undefined;
    const params = { from: timeframe, pageSize: '50' };
    if (eventType) params.eventSelector = `eventType("${eventType}")`;
    
    const data = await dtProxyFetch('/api/v2/events', params);
    if (data.error) return res.json({ ok: false, events: [], ...data });
    
    res.json({ ok: true, events: data.events || [], totalCount: data.totalCount || 0 });
  } catch (err) {
    console.error('[DT Proxy] Events fetch failed:', err.message);
    res.json({ ok: false, events: [], error: err.message });
  }
});

// GET /api/dt-proxy/metrics — query Dynatrace metrics
app.get('/api/dt-proxy/metrics', async (req, res) => {
  try {
    const { metricSelector, entitySelector, from } = req.query;
    if (!metricSelector) return res.status(400).json({ ok: false, error: 'metricSelector required' });
    
    const params = { metricSelector, from: from || 'now-30m', resolution: 'Inf' };
    if (entitySelector) params.entitySelector = entitySelector;
    
    const data = await dtProxyFetch('/api/v2/metrics/query', params);
    if (data.error) return res.json({ ok: false, ...data });
    
    res.json({ ok: true, result: data.result || [] });
  } catch (err) {
    console.error('[DT Proxy] Metrics fetch failed:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/dt-proxy/entities — query Dynatrace entities/topology
app.get('/api/dt-proxy/entities', async (req, res) => {
  try {
    const { entitySelector, fields } = req.query;
    if (!entitySelector) return res.status(400).json({ ok: false, error: 'entitySelector required' });
    
    const params = { entitySelector, fields: fields || 'properties', pageSize: '50' };
    
    const data = await dtProxyFetch('/api/v2/entities', params);
    if (data.error) return res.json({ ok: false, ...data });
    
    res.json({ ok: true, entities: data.entities || [], totalCount: data.totalCount || 0 });
  } catch (err) {
    console.error('[DT Proxy] Entities fetch failed:', err.message);
    res.json({ ok: false, error: err.message });
  }
});

// GET /api/dt-proxy/logs — search Dynatrace logs
app.get('/api/dt-proxy/logs', async (req, res) => {
  try {
    const { query, from, limit } = req.query;
    const params = {
      query: query || 'status="ERROR"',
      from: from || 'now-1h',
      limit: limit || '50',
      sort: '-timestamp'
    };
    
    const data = await dtProxyFetch('/api/v2/logs/search', params);
    if (data.error) return res.json({ ok: false, ...data });
    
    res.json({ ok: true, results: data.results || [] });
  } catch (err) {
    console.error('[DT Proxy] Logs fetch failed:', err.message);
    res.json({ ok: false, results: [], error: err.message });
  }
});

app.get('/api/health', (req, res) => {
  const runningServices = getChildServices();
  const metadata = getChildServiceMeta();
  const serviceStatuses = Object.keys(runningServices).map(serviceName => {
    const meta = metadata[serviceName] || {};
    return {
      service: serviceName,
      running: true,
      pid: runningServices[serviceName]?.pid || null,
      port: meta.port || null,
      companyName: meta.companyName || null,
      domain: meta.domain || null,
      industryType: meta.industryType || null,
      journeyType: meta.journeyType || null,
      journeyDetail: meta.journeyDetail || null,
      stepName: meta.stepName || null,
      baseServiceName: meta.baseServiceName || null,
      createdByUserEmail: meta.createdByUserEmail || null,
      createdByUserName: meta.createdByUserName || null,
      startTime: meta.startTime || null,
    };
  });

  const duplicateBuckets = serviceStatuses.reduce((acc, svc) => {
    const key = `${String(svc.companyName || '').toLowerCase()}::${String(svc.baseServiceName || svc.service || '').toLowerCase()}`;
    if (!acc[key]) acc[key] = [];
    acc[key].push(svc);
    return acc;
  }, {});

  const duplicateServices = Object.values(duplicateBuckets)
    .filter((group) => group.length > 1)
    .map((group) => ({
      companyName: group[0]?.companyName || null,
      baseServiceName: group[0]?.baseServiceName || group[0]?.service || null,
      count: group.length,
      ports: group.map((item) => item.port).filter(Boolean),
      services: group.map((item) => item.service),
    }));

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    backendVersion: BACKEND_VERSION,
    mainProcess: {
      pid: process.pid,
      uptime: process.uptime(),
      port: PORT
    },
    childServices: serviceStatuses,
    duplicateServices
  });
});

app.get('/api/ready', (req, res) => {
  const requiredChecks = [
    {
      name: 'serverListening',
      ready: server.listening,
      detail: server.listening ? 'HTTP listener is accepting connections' : 'HTTP listener is not active yet'
    },
    {
      name: 'compiledAgents',
      ready: existsSync(path.join(__dirname, 'dist', 'agents')),
      detail: 'Compiled TypeScript agent bundle present'
    },
    {
      name: 'dataDirectory',
      ready: existsSync(path.join(__dirname, 'data')),
      detail: 'Runtime data directory present'
    },
    {
      name: 'savedConfigsDirectory',
      ready: existsSync(path.join(__dirname, 'saved-configs')),
      detail: 'Saved configuration directory present'
    },
    {
      name: 'dependenciesValidated',
      ready: startupState.dependencyFailures.length === 0,
      detail: startupState.dependencyFailures.length === 0
        ? 'Essential dependency checks passed'
        : `Failed checks: ${startupState.dependencyFailures.join(', ')}`
    },
    {
      name: 'autoLoadWatcher',
      ready: startupState.autoLoadWatcherStarted,
      detail: startupState.autoLoadWatcherStarted ? 'Auto-load watcher started' : 'Auto-load watcher not started yet'
    }
  ];

  const optionalChecks = [
    {
      name: 'dynatraceCredentials',
      ready: Boolean(dtCredentials.environmentUrl && dtCredentials.apiToken),
      detail: dtCredentials.environmentUrl && dtCredentials.apiToken
        ? `Configured via ${dtCredentials.configuredBy}`
        : 'Credentials not configured'
    },
    {
      name: 'aiAgents',
      ready: startupState.aiAgentsReady,
      detail: startupState.aiAgentsReady ? 'Autonomous agents initialized' : 'Autonomous agents still initializing'
    },
    {
      name: 'mcpServer',
      ready: mcpServerStatus === 'running',
      detail: `MCP server status: ${mcpServerStatus}`
    }
  ];

  const ready = requiredChecks.every(check => check.ready);
  const statusCode = ready ? 200 : 503;

  res.status(statusCode).json({
    status: ready ? 'ready' : 'starting',
    ready,
    timestamp: new Date().toISOString(),
    mainProcess: {
      pid: process.pid,
      uptime: process.uptime(),
      port: PORT,
      listening: server.listening
    },
    startupState: {
      credentialsResolved: startupState.credentialsResolved,
      serviceStartupCompleted: startupState.serviceStartupCompleted,
      serviceStartupSuccessful: startupState.serviceStartupSuccessful,
      serviceStartupFailed: startupState.serviceStartupFailed,
      startupCompletedAt: startupState.startupCompletedAt,
    },
    requiredChecks,
    optionalChecks
  });
});

// Comprehensive health check endpoint with observability hygiene
app.get('/api/health/comprehensive', async (req, res) => {
  try {
    const healthReport = await performComprehensiveHealthCheck();
    const statusCode = healthReport.overallStatus === 'healthy' ? 200 : 
                      healthReport.overallStatus === 'critical' ? 503 : 202;
    
    res.status(statusCode).json(healthReport);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Comprehensive health check failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Comprehensive health check endpoint
app.get('/api/health/detailed', async (req, res) => {
  try {
    const healthCheck = await performHealthCheck();
    const serviceStatus = getServiceStatus();
    
    res.json({
      status: healthCheck.unhealthyServices === 0 ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      healthCheck,
      serviceStatus,
      mainProcess: {
        pid: process.pid,
        uptime: process.uptime(),
        port: PORT,
        memoryUsage: process.memoryUsage()
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ============================================
// Self-Healing / Remediation Endpoints
// ============================================

// Get current feature flags
app.get('/api/remediation/feature-flags', (req, res) => {
  res.json({
    ok: true,
    flags: featureFlags,
    timestamp: new Date().toISOString()
  });
});

// Toggle feature flag (for Dynatrace Workflow automation)
app.post('/api/remediation/feature-flag', async (req, res) => {
  try {
    const { flag, value, reason, problemId, triggeredBy = 'manual', dtEnvironment, dtToken, targetService } = req.body;
    
    if (!flag || value === undefined) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: flag, value'
      });
    }
    
    if (!(flag in featureFlags)) {
      return res.status(400).json({
        ok: false,
        error: `Unknown feature flag: ${flag}`,
        availableFlags: Object.keys(featureFlags)
      });
    }
    
    const previousValue = featureFlags[flag];
    featureFlags[flag] = value;
    
    console.log(`[Remediation] Feature flag changed: ${flag} = ${previousValue} → ${value}`);
    console.log(`[Remediation] Reason: ${reason || 'Not specified'}`);
    console.log(`[Remediation] Triggered by: ${triggeredBy}`);
    
    // Debug: Log credential availability
    const hasEnv = !!(dtEnvironment || dtCredentials.environmentUrl || process.env.DT_ENVIRONMENT || process.env.DYNATRACE_URL);
    const hasToken = !!(dtToken || dtCredentials.apiToken || process.env.DT_PLATFORM_TOKEN || process.env.DYNATRACE_TOKEN || process.env.DT_API_TOKEN);
    console.log(`[Remediation] Credentials available: environment=${hasEnv}, token=${hasToken}`);
    
    // Send CUSTOM_DEPLOYMENT event to Dynatrace — target specific service if provided, otherwise all
    let entitySelectorForEvent;
    if (targetService && targetService !== 'all') {
      entitySelectorForEvent = buildEntitySelector([targetService]);
    } else {
      const allSelectors = buildEntitySelectorsForServices(Object.keys(getChildServiceMeta()));
      entitySelectorForEvent = allSelectors.length > 0 ? allSelectors : undefined;
    }
    
    // Keep event open if triggered by config-manager (configuration change)
    const isConfigTriggered = triggeredBy === 'nemesis-agent' || triggeredBy === 'config-manager';
    
    const eventResult = await sendDynatraceEvent('CUSTOM_CONFIGURATION', {
      title: `Remediation: ${flag} ${value ? 'enabled' : 'disabled'}`,
      entitySelector: entitySelectorForEvent,
      keepOpen: isConfigTriggered,
      properties: {
        'dt.event.description': `Feature flag '${flag}' changed from ${previousValue} to ${value}. Reason: ${reason || 'Not specified'}. Triggered by ${triggeredBy}${problemId && problemId !== 'N/A' ? ` for problem ${problemId}` : ''}.`,
        'deployment.name': `Remediation: ${flag}`,
        'deployment.project': 'BizObs Feature Flags',
        'deployment.version': `remediation-${Date.now()}`,
        'feature.flag': flag,
        'previous.value': String(previousValue),
        'new.value': String(value),
        'change.reason': reason || 'Not specified',
        'triggered.by': triggeredBy,
        ...(problemId && problemId !== 'N/A' ? { 'problem.id': problemId } : {}),
        'remediation.type': 'feature_flag_toggle',
        'application': 'BizObs',
        'change.type': isConfigTriggered ? 'configuration-change' : 'remediation',
        'change.impact': value ? 'Service behavior modified' : 'Service configuration restored'
      }
    }, dtEnvironment, dtToken);

    // Nemesis chaos must never run without correlated deployment/configuration event.
    if ((triggeredBy === 'nemesis-agent' || triggeredBy === 'config-manager') && !eventResult.success) {
      featureFlags[flag] = previousValue;
      console.error(`[Remediation] ❌ Event creation failed for Nemesis. Rolling back ${flag} to ${previousValue}. Reason: ${eventResult.reason || eventResult.error || 'unknown'}`);
      return res.status(503).json({
        ok: false,
        error: 'Dynatrace event was not created (Dynatrace event creation failed; remediation change was rolled back to keep chaos correlation consistent.)',
        reason: eventResult.reason || eventResult.error || `events.ingest returned ${eventResult.status || 'unknown status'}`,
        flag,
        rolledBackTo: previousValue,
        eventDetails: eventResult,
        diagnostics: {
          credentialsConfigured: !!(dtCredentials.environmentUrl && dtCredentials.apiToken),
          environmentUrlSource: dtEnvironment ? 'request' : (dtCredentials.environmentUrl ? '.dt-credentials.json' : (process.env.DT_ENVIRONMENT ? 'env' : 'not configured')),
          environmentUrl: dtCredentials.environmentUrl ? dtCredentials.environmentUrl.substring(0, 50) + '...' : 'not configured',
          tokenConfigured: !!dtCredentials.apiToken
        },
        timestamp: new Date().toISOString()
      });
    }
    
    res.json({
      ok: true,
      flag: flag,
      previousValue: previousValue,
      newValue: value,
      reason: reason,
      triggeredBy: triggeredBy,
      eventSent: eventResult.success,
      eventDetails: eventResult,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[Remediation] Error:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Bulk toggle multiple flags (for complex remediation scenarios)
app.post('/api/remediation/feature-flags/bulk', async (req, res) => {
  try {
    const { flags, reason, problemId, triggeredBy = 'manual', dtEnvironment, dtToken, targetService } = req.body;
    
    if (!flags || typeof flags !== 'object') {
      return res.status(400).json({
        ok: false,
        error: 'Missing required field: flags (object)'
      });
    }
    
    const changes = [];
    const events = [];
    
    for (const [flag, value] of Object.entries(flags)) {
      if (flag in featureFlags) {
        const previousValue = featureFlags[flag];
        featureFlags[flag] = value;
        
        changes.push({ flag, previousValue, newValue: value });
        
        // Send individual CUSTOM_DEPLOYMENT event for each flag — target specific or all services
        let bulkEntitySelector;
        if (targetService && targetService !== 'all') {
          bulkEntitySelector = buildEntitySelector([targetService]);
        } else {
          const allSelectors = buildEntitySelectorsForServices(Object.keys(getChildServiceMeta()));
          bulkEntitySelector = allSelectors.length > 0 ? allSelectors : undefined;
        }
        
        // Keep event open if triggered by nemesis-agent (chaos injection)
        const isNemesisTriggered = triggeredBy === 'nemesis-agent';
        
        const eventResult = await sendDynatraceEvent('CUSTOM_CONFIGURATION', {
          title: `Bulk Remediation: ${flag} ${value ? 'enabled' : 'disabled'}`,
          entitySelector: bulkEntitySelector,
          keepOpen: isNemesisTriggered, // Keep open for chaos injection events
          properties: {
            'dt.event.description': `[REMEDIATION] Bulk remediation: '${flag}' changed from ${previousValue} to ${value}. Reason: ${reason || 'Bulk update'}. Triggered by: ${triggeredBy}. This bulk configuration change directly affects error rates across targeted services.`,
            'deployment.name': `Bulk Remediation: ${flag}`,
            'deployment.project': 'BizObs Chaos Engineering',
            'deployment.version': `bulk-remediation-${Date.now()}`,
            'feature.flag': flag,
            'previous.value': String(previousValue),
            'new.value': String(value),
            'change.reason': reason || 'Bulk update',
            'triggered.by': triggeredBy,
            'problem.id': problemId || 'N/A',
            'remediation.type': 'bulk_feature_flag_toggle',
            'application': 'BizObs',
            'change.type': isNemesisTriggered ? 'chaos-injection' : 'bulk-remediation',
            'change.impact': value ? 'Error injection enabled across services' : 'Error injection disabled - services should recover'
          }
        }, dtEnvironment, dtToken);
        
        events.push({ flag, eventSent: eventResult.success });
      }
    }
    
    res.json({
      ok: true,
      changes: changes,
      events: events,
      reason: reason,
      triggeredBy: triggeredBy,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('[Remediation] Bulk update error:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Port status endpoint
app.get('/api/admin/ports', (req, res) => {
  try {
    const serviceStatus = getServiceStatus();
    res.json({
      ok: true,
      timestamp: new Date().toISOString(),
      portStatus: {
        available: serviceStatus.availablePorts,
        allocated: serviceStatus.allocatedPorts,
        total: (parseInt(process.env.SERVICE_PORT_MAX || '8120') - parseInt(process.env.SERVICE_PORT_MIN || '8081') + 1), // Dynamic range
        range: serviceStatus.portRange
      },
      services: serviceStatus.services
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Force cleanup stale port allocations
app.post('/api/admin/ports/cleanup', async (req, res) => {
  try {
    const cleaned = await portManager.cleanupStaleAllocations();
    const serviceStatus = getServiceStatus();
    res.json({
      ok: true,
      message: `Cleaned ${cleaned} stale port allocations`,
      cleaned,
      portStatus: {
        available: serviceStatus.availablePorts,
        allocated: serviceStatus.allocatedPorts,
        total: (parseInt(process.env.SERVICE_PORT_MAX || '8120') - parseInt(process.env.SERVICE_PORT_MIN || '8081') + 1),
        range: serviceStatus.portRange
      }
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// OAuth SSO Endpoints
// ============================================

// Temporary storage for OAuth state and tokens (in production, use Redis or database)
const oauthSessions = new Map();

// PKCE helper functions (MCP server style - no client secret needed!)
function generateCodeVerifier() {
  // Generate 46 random bytes for code verifier (base64url encoded = ~61 chars)
  return crypto.randomBytes(46).toString('base64url');
}

function generateCodeChallenge(verifier) {
  // SHA256 hash of verifier, base64url encoded
  return crypto.createHash('sha256')
    .update(verifier)
    .digest('base64url');
}

// Initiate OAuth authorization flow (PKCE - automatic, simple!)
app.post('/api/oauth/authorize', async (req, res) => {
  const { environment } = req.body;
  
  if (!environment) {
    return res.status(400).json({
      ok: false,
      error: 'Missing Dynatrace environment URL'
    });
  }
  
  try {
    // Generate PKCE challenge (replaces client secret!)
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);
    
    // Generate state for CSRF protection
    const state = crypto.randomBytes(32).toString('hex');
    
    // Use same OAuth client as MCP server (has localhost:* already registered)
    const clientId = 'dt0s12.local-dt-mcp-server';
    
    // Use dynamic port for OAuth callback (like MCP server does with ports 5344-5349)
    const callbackPort = 5344 + Math.floor(Math.random() * 6); // Random port 5344-5349
    const redirectUri = `http://localhost:${callbackPort}/auth/login`;
    
    // Start temporary OAuth callback server on localhost (like MCP server)
    const callbackServer = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${callbackPort}`);
      
      if (url.pathname === '/auth/login') {
        const code = url.searchParams.get('code');
        const receivedState = url.searchParams.get('state');
        const error = url.searchParams.get('error');
        
        if (error) {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head><title>OAuth Error</title></head>
              <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1>❌ Authorization Failed</h1>
                <p><strong>Error:</strong> ${error}</p>
                <p>You can close this tab.</p>
              </body>
            </html>
          `);
          return;
        }
        
        if (code && receivedState === state) {
          // Exchange code for token
          try {
            const tokenUrl = `${environment}/sso/oauth2/token`;
            const tokenResponse = await fetch(tokenUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: clientId,
                code: code,
                redirect_uri: redirectUri,
                code_verifier: codeVerifier
              })
            });
            
            const tokenData = await tokenResponse.json();
            
            if (tokenData.access_token) {
              // Store token globally for reuse
              activeOAuthToken = tokenData.access_token;
              tokenEnvironment = environment.replace(/\/$/, '');
              // Propagate to env vars so routes (ai-dashboard) can use for Grail queries
              process.env.DT_PLATFORM_TOKEN = activeOAuthToken;
              process.env.DT_ENVIRONMENT = tokenEnvironment;
              
              console.log('[OAuth] ✅ Token received and stored!');
              
              res.writeHead(200, { 'Content-Type': 'text/html' });
              res.end(`
                <!DOCTYPE html>
                <html>
                  <head><title>Authorization Successful!</title></head>
                  <body style="font-family: Arial; padding: 40px; text-align: center;">
                    <h1>✅ Authorization Successful!</h1>
                    <p>You have successfully authorized the Dynatrace MCP Server.</p>
                    <p><strong>You can close this tab and return to your terminal.</strong></p>
                    <script>setTimeout(() => window.close(), 3000);</script>
                  </body>
                </html>
              `);
              
              // Close server after successful auth
              callbackServer.close();
            } else {
              throw new Error(tokenData.error || 'Failed to get token');
            }
          } catch (err) {
            console.error('[OAuth] Token exchange error:', err);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end(`
              <!DOCTYPE html>
              <html>
                <head><title>Token Exchange Failed</title></head>
                <body style="font-family: Arial; padding: 40px; text-align: center;">
                  <h1>❌ Token Exchange Failed</h1>
                  <p>${err.message}</p>
                  <p>You can close this tab.</p>
                </body>
              </html>
            `);
          }
        } else {
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(`
            <!DOCTYPE html>
            <html>
              <head><title>Invalid Request</title></head>
              <body style="font-family: Arial; padding: 40px; text-align: center;">
                <h1>❌ Invalid Request</h1>
                <p>Missing or invalid authorization code/state.</p>
                <p>You can close this tab.</p>
              </body>
            </html>
          `);
        }
      }
    });
    
    callbackServer.listen(callbackPort, 'localhost', () => {
      console.log(`[OAuth] Callback server listening on http://localhost:${callbackPort}/auth/login`);
    });
    
    // Store OAuth session with PKCE verifier and callback server
    oauthSessions.set(state, {
      environment: environment.replace(/\/$/, ''),
      clientId,
      codeVerifier, // Store for token exchange
      callbackServer, // Store server instance to close later
      timestamp: Date.now()
    });
    
    // Clean up old sessions (older than 10 minutes)
    for (const [key, session] of oauthSessions.entries()) {
      if (Date.now() - session.timestamp > 600000) {
        // Close callback server if it exists
        if (session.callbackServer) {
          session.callbackServer.close();
        }
        oauthSessions.delete(key);
      }
    }
    
    // Construct OAuth authorization URL with PKCE
    const scope = 'document:documents:read document:documents:write storage:buckets:read storage:metrics:read';
    
    // Auto-discover SSO URL by following redirect
    const envUrl = environment.replace(/\/$/, '');
    const ssoDiscoveryUrl = `${envUrl}/platform/oauth2/authorization/dynatrace-sso`;
    
    const authUrl = new URL(ssoDiscoveryUrl);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', scope);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('code_challenge', codeChallenge);
    authUrl.searchParams.set('state', state);
    
    console.log('[OAuth] Authorization URL generated (PKCE):', authUrl.toString());
    
    res.json({
      ok: true,
      authorizationUrl: authUrl.toString(),
      state: state,
      callbackPort: callbackPort // Send port to client
    });
    
  } catch (error) {
    console.error('[OAuth] Authorization error:', error);
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// OAuth callback endpoint
app.get('/api/oauth/callback', async (req, res) => {
  console.log('[OAuth Callback] Callback received');
  
  const { code, state, error: oauthError } = req.query;
  
  if (oauthError) {
    console.error('[OAuth Callback] OAuth error received:', oauthError);
    return res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #1a1a1a; color: white;">
          <h1 style="color: #ff5252;">❌ OAuth Authorization Failed</h1>
          <p>Error: ${oauthError}</p>
          <p>You can close this window.</p>
        </body>
      </html>
    `);
  }
  
  if (!code || !state) {
    return res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #1a1a1a; color: white;">
          <h1 style="color: #ff5252;">❌ Invalid Callback</h1>
          <p>Missing authorization code or state</p>
          <p>You can close this window.</p>
        </body>
      </html>
    `);
  }
  
  const session = oauthSessions.get(state);
  
  if (!session) {
    return res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #1a1a1a; color: white;">
          <h1 style="color: #ff5252;">❌ Invalid Session</h1>
          <p>OAuth session expired or not found</p>
          <p>Please try logging in again.</p>
        </body>
      </html>
    `);
  }
  
  try {
    // Exchange authorization code for access token (PKCE - use code_verifier instead of client_secret!)
    const redirectUri = `${req.protocol}://${req.get('host')}/api/oauth/callback`;
    const tokenUrl = `${session.environment}/sso/oauth2/token`;
    
    const tokenResponse = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
        // NO Authorization header with PKCE! code_verifier replaces client_secret
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: session.clientId,
        code: code,
        redirect_uri: redirectUri,
        code_verifier: session.codeVerifier // PKCE: code_verifier instead of client_secret!
      })
    });
    
    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('[OAuth] Token exchange failed:', errorText);
      throw new Error(`Token exchange failed: ${tokenResponse.statusText}`);
    }
    
    const tokenData = await tokenResponse.json();
    console.log('[OAuth] Access token received successfully (PKCE flow)');
    
    // Store token in session
    session.accessToken = tokenData.access_token;
    session.refreshToken = tokenData.refresh_token; // Store for automatic refresh
    session.expiresIn = tokenData.expires_in;
    session.tokenReceivedAt = Date.now();
    
    // Also store immediately in global variable for immediate access
    activeOAuthToken = tokenData.access_token;
    tokenEnvironment = session.environment;
    // Propagate to env vars so routes (ai-dashboard) can use for Grail queries
    process.env.DT_PLATFORM_TOKEN = activeOAuthToken;
    process.env.DT_ENVIRONMENT = tokenEnvironment;
    console.log('[OAuth] Token stored globally for environment:', tokenEnvironment);
    
    res.send(`
      <html>
        <head>
          <title>OAuth Success</title>
        </head>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #1a1a1a; color: white;">
          <h1 style="color: #4caf50;">✅ OAuth Login Successful!</h1>
          <p>You have successfully authenticated with Dynatrace.</p>
          <p style="margin-top: 20px; color: #64b5f6;">This window will close automatically...</p>
          <p style="margin-top: 10px; font-size: 12px; color: #999;">If it doesn't close, you can close it manually.</p>
          <script>
            console.log('[OAuth Callback] Starting auto-close sequence...');
            
            // Function to notify parent and attempt close
            function notifyAndClose() {
              if (window.opener && !window.opener.closed) {
                console.log('[OAuth Callback] Sending success message to parent...');
                window.opener.postMessage({ type: 'oauth-success', state: '${state}' }, '*');
              } else {
                console.log('[OAuth Callback] No opener window found');
              }
              
              // Try to close
              try {
                window.close();
                console.log('[OAuth Callback] Window close attempted');
              } catch (e) {
                console.log('[OAuth Callback] Window close failed:', e.message);
              }
            }
            
            // Try immediately
            notifyAndClose();
            
            // Try again after small delays (in case listener not ready)
            setTimeout(notifyAndClose, 100);
            setTimeout(notifyAndClose, 500);
            setTimeout(notifyAndClose, 1000);
            
            // Show manual close message after 2 seconds if still open
            setTimeout(() => {
              document.body.innerHTML = '<div style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #1a1a1a; color: white;"><h1 style="color: #4caf50;">✅ Success!</h1><p>Authentication complete!</p><p style="margin-top: 10px; color: #64b5f6;">You can close this window now.</p></div>';
            }, 2000);
              }, 1000);
            }, 500);
          </script>
        </body>
      </html>
    `);
    
  } catch (error) {
    console.error('[OAuth] Callback error:', error);
    res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center; background: #1a1a1a; color: white;">
          <h1 style="color: #ff5252;">❌ Token Exchange Failed</h1>
          <p>Error: ${error.message}</p>
          <p>Please try logging in again.</p>
        </body>
      </html>
    `);
  }
});

// Store the active OAuth token (persists across requests)
let activeOAuthToken = null;
let tokenEnvironment = null;

// Check OAuth token status (for frontend polling)
app.get('/api/oauth/token-status', (req, res) => {
  // Check if we have an active token
  if (activeOAuthToken) {
    return res.json({
      hasToken: true,
      environment: tokenEnvironment
    });
  }
  
  // Find any session with a valid access token
  for (const [state, session] of oauthSessions.entries()) {
    if (session.accessToken) {
      // Store token for subsequent use (don't delete!)
      activeOAuthToken = session.accessToken;
      tokenEnvironment = session.environment;
      // Propagate to env vars so routes (ai-dashboard) can use for Grail queries
      process.env.DT_PLATFORM_TOKEN = activeOAuthToken;
      process.env.DT_ENVIRONMENT = tokenEnvironment;
      
      console.log('[OAuth] Token stored for environment:', tokenEnvironment);
      
      return res.json({
        hasToken: true,
        environment: tokenEnvironment
      });
    }
  }
  
  res.json({
    hasToken: false
  });
});

// ============================================
// Dynatrace Dashboard Deployment
// ============================================

// Dynatrace Dashboard Deployment Endpoint
app.post('/api/dynatrace/deploy-dashboard', async (req, res) => {
  try {
    const { journeyConfig, dashboardDocument } = req.body;
    
    // If a pre-built dashboard document is provided (from AI Dashboard generator),
    // deploy it directly via the Document API instead of rebuilding from scratch
    const usePrebuilt = !!dashboardDocument;
    
    if (!usePrebuilt && (!journeyConfig || !journeyConfig.companyName || !journeyConfig.steps)) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required journeyConfig with companyName and steps, or provide dashboardDocument'
      });
    }
    
    // Check for active OAuth token first (takes precedence)
    let DT_ENVIRONMENT, DT_TOKEN;
    
    // OAuth token check
    
    if (activeOAuthToken && tokenEnvironment) {
      // Using stored OAuth token
      DT_ENVIRONMENT = tokenEnvironment;
      DT_TOKEN = activeOAuthToken;
    } else {
      // No OAuth token, checking fallback
      // Fall back to environment variables or headers
      DT_ENVIRONMENT = process.env.DT_ENVIRONMENT || req.headers['x-dt-environment'];
      DT_TOKEN = process.env.DT_PLATFORM_TOKEN || req.headers['x-dt-token'];
      // fallback log removed
    }
    
    const DT_BUDGET = process.env.DT_GRAIL_BUDGET || req.headers['x-dt-budget'] || '500';
    
    if (!DT_ENVIRONMENT || !DT_TOKEN) {
      return res.status(500).json({
        ok: false,
        needsOAuthLogin: true,
        error: 'Dynatrace not configured. Please sign in with OAuth SSO.'
      });
    }

    // verbose token/env logs removed
    
    // Check if this is a Sprint environment with Platform token
    const isSprintEnvironment = DT_ENVIRONMENT.includes('.sprint.') || DT_ENVIRONMENT.includes('sprint.apps.dynatrace');
    const isPlatformToken = dtAuth.isPlatformToken(DT_TOKEN) || dtAuth.isClassicToken(DT_TOKEN);
    const isOAuthToken = DT_TOKEN.length > 100 && !DT_TOKEN.startsWith('dt0');
    
    // detection results log removed
    
    // If Sprint environment + Platform token (not OAuth token), check if OAuth credentials are available
    if (isSprintEnvironment && isPlatformToken && !isOAuthToken) {
      // sprint + platform token check
      
      // Check if OAuth SSO credentials are in request body (from settings)
      const hasOAuthCreds = req.body.oauthClientId && req.body.oauthClientSecret && req.body.oauthAccountUrn;
      
      if (hasOAuthCreds) {
        // OAuth credentials available
        return res.json({
          ok: false,
          needsOAuthLogin: true,
          environment: DT_ENVIRONMENT,
          message: 'Sprint environment requires OAuth SSO authentication'
        });
      } else {
        // No OAuth credentials, trying deployment
      }
    } else if (isOAuthToken) {
      // OAuth token detected
    }
    
    // Set environment variables
    process.env.DT_ENVIRONMENT = DT_ENVIRONMENT;
    process.env.DT_PLATFORM_TOKEN = DT_TOKEN;
    process.env.DT_GRAIL_BUDGET = DT_BUDGET;
    
    // ========== PRE-BUILT DASHBOARD (from AI Dashboard Generator) ==========
    if (usePrebuilt) {
      console.log('[dynatrace-deploy] 📊 Deploying pre-built AI dashboard via Document API...');
      
      const companyName = dashboardDocument.metadata?.company || journeyConfig?.companyName || 'Dashboard';
      const dashboardName = dashboardDocument.name || `${companyName} Dashboard`;
      const dashboardContent = dashboardDocument.content;
      
      // Normalize environment URL for API calls
      let apiBaseUrl = DT_ENVIRONMENT;
      if (apiBaseUrl.includes('.sprint.apps.dynatracelabs.com')) {
        apiBaseUrl = apiBaseUrl.replace('.sprint.apps.dynatracelabs.com', '.sprint.dynatracelabs.com');
      }
      
      // dtAuthHeader covers all three cases: classic → Api-Token, platform token and
      // OAuth access token → Bearer. The old ternary sent platform tokens as Api-Token.
      const authHeader = dtAuth.dtAuthHeader(DT_TOKEN);
      
      // Try Document API first (for v21 dashboards / Grail Dashboards)
      try {
        console.log('[dynatrace-deploy] Trying Document API (platform/document/v1/documents)...');
        
        // Create the document payload
        const documentPayload = {
          name: dashboardName,
          type: 'dashboard',
          content: JSON.stringify(dashboardContent),
          isPrivate: false
        };
        
        const docResponse = await fetch(
          `${apiBaseUrl}/platform/document/v1/documents`,
          {
            method: 'POST',
            headers: {
              'Authorization': authHeader,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(documentPayload)
          }
        );
        
        if (docResponse.ok) {
          const docResult = await docResponse.json();
          const dashboardId = docResult.id;
          const dashboardUrl = `${DT_ENVIRONMENT}/ui/apps/dynatrace.dashboards/dashboard/${dashboardId}`;
          
          console.log(`[dynatrace-deploy] ✅ Dashboard deployed via Document API!`);
          console.log(`[dynatrace-deploy]    ID: ${dashboardId}`);
          console.log(`[dynatrace-deploy]    URL: ${dashboardUrl}`);
          
          return res.json({
            ok: true,
            success: true,
            dashboardId,
            dashboardUrl,
            companyName,
            message: `Dashboard "${dashboardName}" deployed successfully`
          });
        }
        
        // Document API failed — log and try classic API fallback
        const docError = await docResponse.text();
        console.warn(`[dynatrace-deploy] ⚠️ Document API returned ${docResponse.status}: ${docError.substring(0, 200)}`);
        console.log('[dynatrace-deploy] Falling back to classic Dashboard API...');
      } catch (docErr) {
        console.warn(`[dynatrace-deploy] ⚠️ Document API error: ${docErr.message}`);
        console.log('[dynatrace-deploy] Falling back to classic Dashboard API...');
      }
      
      // Fallback: Try classic dashboard API v2 (convert v21 → v20 format)
      try {
        // Strip version 21 features for v2 API compatibility
        const classicDashboard = {
          dashboardMetadata: {
            name: dashboardName,
            owner: 'BizObs Generator',
            shared: true
          },
          ...dashboardContent
        };
        // Downgrade version for classic API
        if (classicDashboard.version > 20) {
          classicDashboard.version = 20;
        }
        
        const classicResponse = await fetch(
          `${apiBaseUrl}/platform/classic/environment-api/v2/dashboards`,
          {
            method: 'POST',
            headers: {
              'Authorization': authHeader,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(classicDashboard)
          }
        );
        
        if (classicResponse.ok) {
          const classicResult = await classicResponse.json();
          const dashboardId = classicResult.id;
          const dashboardUrl = `${DT_ENVIRONMENT}/ui/dashboards/${dashboardId}`;
          
          console.log(`[dynatrace-deploy] ✅ Dashboard deployed via classic API!`);
          console.log(`[dynatrace-deploy]    ID: ${dashboardId}`);
          console.log(`[dynatrace-deploy]    URL: ${dashboardUrl}`);
          
          return res.json({
            ok: true,
            success: true,
            dashboardId,
            dashboardUrl,
            companyName,
            message: `Dashboard "${dashboardName}" deployed successfully (classic API)`
          });
        }
        
        const classicError = await classicResponse.text();
        throw new Error(`Both Document API and classic API failed. Classic: ${classicResponse.status} - ${classicError.substring(0, 300)}`);
      } catch (classicErr) {
        console.error('[dynatrace-deploy] ❌ Classic API fallback failed:', classicErr.message);
        return res.status(500).json({
          ok: false,
          error: classicErr.message,
          companyName
        });
      }
    }
    
    // ========== LEGACY: Build dashboard from journeyConfig via deployer script ==========
    const { deployJourneyDashboard } = await import('./scripts/dynatrace-dashboard-deployer.js');
    
    const result = await deployJourneyDashboard(journeyConfig);
    
    if (result.success) {
      res.json({
        ok: true,
        dashboardId: result.dashboardId,
        dashboardUrl: result.dashboardUrl,
        companyName: result.companyName,
        message: `Dashboard created for ${result.companyName}`
      });
    } else {
      res.status(500).json({
        ok: false,
        error: result.error,
        companyName: result.companyName
      });
    }
  } catch (error) {
    console.error('[dynatrace-deploy] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// Dynatrace Dashboard Deployment via MCP Proxy
// ============================================

// Deploy dashboard via Dynatrace MCP Server
// ============================================
// MCP Server Management
// ============================================

let mcpServerProcess = null;
let mcpServerStatus = 'stopped'; // stopped, starting, running, error
let mcpServerAuthUrl = null;

async function probeMcpServer(port = 3000) {
  try {
    const testResponse = await fetch(`http://localhost:${port}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {}
      }),
      timeout: 2000
    }).catch(() => null);

    return Boolean(testResponse && testResponse.ok);
  } catch (error) {
    return false;
  }
}

async function startMcpServer(environmentUrl, port = 3000) {
  console.log('[MCP] Starting MCP server on port', port, 'for environment:', environmentUrl);
  mcpServerStatus = 'starting';
  mcpServerAuthUrl = null;

  mcpServerProcess = spawn('npx', [
    '-y',
    '@dynatrace-oss/dynatrace-mcp-server@latest',
    '--http',
    '-p',
    port.toString()
  ], {
    env: {
      ...process.env,
      DT_ENVIRONMENT: environmentUrl,
      DT_MCP_DISABLE_TELEMETRY: 'false'
    },
    cwd: process.cwd()
  });

  let outputBuffer = '';

  mcpServerProcess.stdout.on('data', (data) => {
    const output = data.toString();
    outputBuffer += output;
    console.log('[MCP stdout]', output);

    const oauthMatch = output.match(/https:\/\/[^\s]+oauth2\/authorize[^\s]+/);
    if (oauthMatch) {
      mcpServerAuthUrl = oauthMatch[0];
      console.log('[MCP] OAuth URL detected:', mcpServerAuthUrl);
    }

    if (output.includes('Dynatrace MCP Server running on HTTP')) {
      mcpServerStatus = 'running';
      console.log('[MCP] Server is now running');
    }
  });

  mcpServerProcess.stderr.on('data', (data) => {
    const errOutput = data.toString();
    console.error('[MCP stderr]', errOutput);

    // OAuth URL often appears on stderr
    const oauthMatch = errOutput.match(/https:\/\/[^\s]+oauth2\/authorize[^\s]+/);
    if (oauthMatch) {
      mcpServerAuthUrl = oauthMatch[0];
      console.log('[MCP] OAuth URL detected (stderr):', mcpServerAuthUrl);
    }

    if (errOutput.includes('Dynatrace MCP Server running on HTTP') || errOutput.includes('MCP Server listening')) {
      mcpServerStatus = 'running';
      console.log('[MCP] Server is now running (detected via stderr)');
    }
  });

  mcpServerProcess.on('exit', (code) => {
    console.log('[MCP] Process exited with code:', code);
    mcpServerStatus = code === 0 ? 'stopped' : 'error';
    mcpServerProcess = null;
  });

  await new Promise(resolve => setTimeout(resolve, 3000));

  return {
    status: mcpServerStatus,
    authUrl: mcpServerAuthUrl,
    logs: outputBuffer
  };
}

// Start MCP Server
app.post('/api/mcp/start', async (req, res) => {
  try {
    const { environmentUrl, port = 3000 } = req.body;
    
    if (!environmentUrl) {
      return res.status(400).json({
        ok: false,
        error: 'Missing Dynatrace environment URL'
      });
    }
    
    // Check if already running
    if (mcpServerProcess && mcpServerStatus === 'running') {
      return res.json({
        ok: true,
        status: 'already_running',
        message: 'MCP server is already running',
        port: port
      });
    }

    const startResult = await startMcpServer(environmentUrl, port);
    
    res.json({
      ok: true,
      status: startResult.status,
      message: startResult.status === 'running' ? 'MCP server started successfully' : 'MCP server is starting...',
      authUrl: startResult.authUrl,
      port: port,
      logs: startResult.logs
    });
    
  } catch (error) {
    console.error('[MCP] Start error:', error);
    mcpServerStatus = 'error';
    res.status(500).json({
      ok: false,
      error: error.message
    });
  }
});

// Get MCP Server Status
app.get('/api/mcp/status', async (req, res) => {
  // Double-check by pinging the MCP server
  let actuallyRunning = mcpServerStatus === 'running';
  
  if (!actuallyRunning) {
    const running = await probeMcpServer();
    if (running) {
      mcpServerStatus = 'running';
      actuallyRunning = true;
      console.log('[MCP] Status verified - server is running');
    }
  }
  
  res.json({
    ok: true,
    status: mcpServerStatus,
    running: actuallyRunning,
    authUrl: mcpServerAuthUrl,
    pid: mcpServerProcess?.pid || null
  });
});

// Stop MCP Server
app.post('/api/mcp/stop', (req, res) => {
  if (mcpServerProcess) {
    mcpServerProcess.kill();
    mcpServerProcess = null;
    mcpServerStatus = 'stopped';
    mcpServerAuthUrl = null;
    res.json({ ok: true, message: 'MCP server stopped' });
  } else {
    res.json({ ok: true, message: 'MCP server was not running' });
  }
});

// ============================================
// Dashboard Generation - Download JSON
// ============================================

app.post('/api/dynatrace/generate-dashboard-json', async (req, res) => {
  try {
    const { journeyConfig } = req.body;
    
    if (!journeyConfig) {
      return res.status(400).json({
        ok: false,
        error: 'Missing journey configuration'
      });
    }
    
    console.log('[Dashboard Generator] Generating dashboard JSON for:', journeyConfig.companyName);
    
    // Import dashboard generator
    const { generateDashboardJson } = await import('./scripts/dynatrace-dashboard-deployer.js');
    
    // Generate dashboard JSON (no deployment)
    const dashboardJson = generateDashboardJson(journeyConfig);
    
    // Prepare file name
    const fileName = `${journeyConfig.companyName.replace(/[^a-z0-9]/gi, '_')}_Dashboard.json`;
    
    console.log(`✅ Dashboard JSON generated: ${fileName}`);
    
    res.json({
      ok: true,
      success: true,
      dashboardJson: dashboardJson,
      fileName: fileName,
      companyName: journeyConfig.companyName,
      message: 'Dashboard JSON generated. Download and upload to Dynatrace manually.'
    });
  } catch (error) {
    console.error('[Dashboard Generator] Error:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message 
    });
  }
});

// ============================================
// Dashboard Deployment via MCP (Legacy - requires platform token)
// ============================================

app.post('/api/dynatrace/deploy-dashboard-via-mcp', async (req, res) => {
  try {
    const { mcpServerUrl, environmentUrl, journeyConfig } = req.body;
    
    if (!mcpServerUrl) {
      return res.status(400).json({
        ok: false,
        error: 'Missing MCP server URL'
      });
    }
    
    if (!environmentUrl) {
      return res.status(400).json({
        ok: false,
        error: 'Missing Dynatrace environment URL'
      });
    }
    
    if (!journeyConfig) {
      return res.status(400).json({
        ok: false,
        error: 'Missing journey configuration'
      });
    }
    
    let effectiveMcpServerUrl = mcpServerUrl;
    try {
      const parsedUrl = new URL(mcpServerUrl);
      const port = parsedUrl.port || '3000';
      const isCodespacesHost = parsedUrl.hostname.endsWith('.app.github.dev');
      if (isCodespacesHost || parsedUrl.hostname === req.hostname) {
        effectiveMcpServerUrl = `http://localhost:${port}`;
      }
    } catch (urlError) {
      console.warn('[MCP Proxy] Invalid MCP server URL, using provided value:', urlError.message);
    }

    let mcpPort = 3000;
    try {
      const parsedMcpUrl = new URL(effectiveMcpServerUrl);
      mcpPort = parsedMcpUrl.port ? parseInt(parsedMcpUrl.port, 10) : 3000;
    } catch (error) {
      // Keep default
    }

    let isRunning = await probeMcpServer(mcpPort);
    if (!isRunning) {
      const startResult = await startMcpServer(environmentUrl, mcpPort);

      for (let attempt = 0; attempt < 5; attempt++) {
        if (await probeMcpServer(mcpPort)) {
          isRunning = true;
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }

      if (!isRunning) {
        return res.status(503).json({
          ok: false,
          error: 'MCP server is not ready. Please complete OAuth if prompted and try again.',
          authUrl: startResult.authUrl || null
        });
      }
    }

    console.log('[MCP Proxy] Deploying dashboard via MCP server:', effectiveMcpServerUrl);
    console.log('[MCP Proxy] Dynatrace environment:', environmentUrl);
    console.log('[MCP Proxy] Journey:', journeyConfig.companyName, journeyConfig.journeyType);
    
    // Import deployer dynamically
    const { deployJourneyDashboard } = await import('./scripts/dynatrace-dashboard-deployer.js');
    
    // Call the dashboard deployer through MCP server
    const deployResult = await deployJourneyDashboard(journeyConfig, {
      useMcpProxy: true,
      mcpServerUrl: effectiveMcpServerUrl,
      environmentUrl: environmentUrl
    });
    
    if (deployResult.success) {
      res.json({
        ok: true,
        success: true,
        dashboardId: deployResult.dashboardId,
        dashboardUrl: deployResult.dashboardUrl,
        companyName: deployResult.companyName
      });
    } else {
      res.status(500).json({
        ok: false,
        error: deployResult.error,
        companyName: deployResult.companyName
      });
    }
  } catch (error) {
    console.error('[MCP Proxy] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// Dynatrace Dashboard Deployment (Legacy/Direct)
// ============================================

// Dynatrace Dashboard Deployment Endpoint
app.post('/api/dynatrace/deploy-dashboard', async (req, res) => {
  try {
    const { journeyConfig } = req.body;
    
    // request received
    
    if (!journeyConfig || !journeyConfig.companyName || !journeyConfig.steps) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required journeyConfig with companyName and steps'
      });
    }
    
    // Try to get credentials from headers first (from UI), then fall back to environment variables
    const DT_ENVIRONMENT = req.headers['x-dt-environment'] || process.env.DT_ENVIRONMENT;
    const DT_TOKEN = req.headers['x-dt-token'] || process.env.DT_PLATFORM_TOKEN;
    const DT_BUDGET = req.headers['x-dt-budget'] || process.env.DT_BUDGET || '100';
    
    // verbose credential dump removed
    
    if (!DT_ENVIRONMENT || !DT_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: 'Dynatrace not configured. Set credentials in environment variables or MCP Settings UI.'
      });
    }
    
    // sprint/platform token check (verbose logs removed)
    
    // Check if this is a Sprint environment with Platform token (unsupported combination)
    const isSprintEnvironment = DT_ENVIRONMENT.includes('.sprint.') || DT_ENVIRONMENT.includes('sprint.apps.dynatrace');
    const isPlatformToken = DT_TOKEN.length < 100 && (DT_TOKEN.startsWith('dt0s') || DT_TOKEN.startsWith('dt0c'));
    
    // detection results log removed
    
    if (isSprintEnvironment && isPlatformToken) {
      console.error('[dynatrace-deploy] ❌ Sprint environment detected with Platform token - OAuth required');
      return res.status(403).json({
        ok: false,
        error: 'Sprint environment requires OAuth SSO authentication. Platform tokens are not supported.',
        needsOAuth: true,
        environment: DT_ENVIRONMENT,
        suggestion: 'Use MCP OAuth flow to authenticate with Sprint environment'
      });
    }
    
    // Set environment variables for the deployer script
    process.env.DT_ENVIRONMENT = DT_ENVIRONMENT;
    process.env.DT_PLATFORM_TOKEN = DT_TOKEN;
    process.env.DT_BUDGET = DT_BUDGET;
    
    // Import deployer dynamically
    const { deployJourneyDashboard } = await import('./scripts/dynatrace-dashboard-deployer.js');
    
    const result = await deployJourneyDashboard(journeyConfig);
    
    if (result.success) {
      res.json({
        ok: true,
        dashboardId: result.dashboardId,
        dashboardUrl: result.dashboardUrl,
        companyName: result.companyName,
        message: `Dashboard created for ${result.companyName}`
      });
    } else {
      res.status(500).json({
        ok: false,
        error: result.error,
        companyName: result.companyName
      });
    }
  } catch (error) {
    console.error('[dynatrace-deploy] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Query Dynatrace for journey analytics
app.post('/api/dynatrace/query-journey', async (req, res) => {
  try {
    const { companyName, timeframe } = req.body;
    
    if (!companyName) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required companyName'
      });
    }
    
    // Try environment variables first, then headers from UI
    const DT_ENVIRONMENT = process.env.DT_ENVIRONMENT || req.headers['x-dt-environment'];
    const DT_TOKEN = process.env.DT_PLATFORM_TOKEN || req.headers['x-dt-token'];
    const DT_BUDGET = process.env.DT_GRAIL_BUDGET || req.headers['x-dt-budget'] || '500';
    
    if (!DT_ENVIRONMENT || !DT_TOKEN) {
      return res.status(500).json({
        ok: false,
        error: 'Dynatrace not configured. Set credentials in environment variables or MCP Settings UI.'
      });
    }
    
    // Set environment variables for deployer script
    process.env.DT_ENVIRONMENT = DT_ENVIRONMENT;
    process.env.DT_PLATFORM_TOKEN = DT_TOKEN;
    process.env.DT_GRAIL_BUDGET = DT_BUDGET;
    
    const { queryJourneyData } = await import('./scripts/dynatrace-dashboard-deployer.js');
    const result = await queryJourneyData(companyName, timeframe || '24h');
    
    res.json({
      ok: true,
      companyName,
      data: result
    });
  } catch (error) {
    console.error('[dynatrace-query] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Verify Dynatrace deployment (BizEvents, Services, Entities)
app.post('/api/dynatrace/verify-deployment', async (req, res) => {
  try {
    const { companyName, correlationId, steps } = req.body;
    
    if (!companyName) {
      return res.status(400).json({ ok: false, error: 'Missing required companyName' });
    }
    
    const DT_ENVIRONMENT = process.env.DT_ENVIRONMENT || req.headers['x-dt-environment'];
    const DT_TOKEN = process.env.DT_PLATFORM_TOKEN || req.headers['x-dt-token'];
    
    if (!DT_ENVIRONMENT || !DT_TOKEN) {
      return res.status(500).json({ ok: false, error: 'Dynatrace not configured' });
    }
    
    const baseUrl = DT_ENVIRONMENT.replace(/\/$/, '');
    const headers = { 'Authorization': dtAuth.dtAuthHeader(DT_TOKEN), 'Content-Type': 'application/json' };
    
    console.log(`[verify] Checking deployment for ${companyName}...`);
    
    // Query 1: Check BizEvents
    const bizEventsQuery = correlationId 
      ? `fetch bizevents | filter event.provider == "${companyName}" and correlationId == "${correlationId}" | summarize count()`
      : `fetch bizevents | filter event.provider == "${companyName}" | summarize count()`;
    
    let bizEventsFound = false, bizEventsCount = 0;
    try {
      const bizRes = await fetch(`${baseUrl}/platform/storage/query/v1/query:execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: bizEventsQuery, requestTimeoutMilliseconds: 30000 })
      });
      const bizData = await bizRes.json();
      if (bizData.result && bizData.result.records && bizData.result.records[0]) {
        bizEventsCount = bizData.result.records[0]['count()'] || 0;
        bizEventsFound = bizEventsCount > 0;
      }
    } catch (e) {
      console.log('[verify] BizEvents query failed:', e.message);
    }
    
    // Query 2: Check Services
    const serviceQuery = steps && steps.length > 0
      ? `fetch dt.entity.service | filter entity.name in (${steps.map(s => `"${s}Service"`).join(',')}) | summarize count()`
      : `fetch dt.entity.service | filter contains(entity.name, "${companyName}") | summarize count()`;
    
    let servicesFound = false, serviceCount = 0;
    try {
      const svcRes = await fetch(`${baseUrl}/platform/storage/query/v1/query:execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query: serviceQuery, requestTimeoutMilliseconds: 30000 })
      });
      const svcData = await svcRes.json();
      if (svcData.result && svcData.result.records && svcData.result.records[0]) {
        serviceCount = svcData.result.records[0]['count()'] || 0;
        servicesFound = serviceCount > 0;
      }
    } catch (e) {
      console.log('[verify] Services query failed:', e.message);
    }
    
    // Query 3: Check Entities (process groups, hosts)
    let entitiesFound = false, entityCount = 0;
    try {
      const entRes = await fetch(`${baseUrl}/platform/storage/query/v1/query:execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ 
          query: `fetch dt.entity.process_group | filter contains(entity.name, "bizobs") | summarize count()`,
          requestTimeoutMilliseconds: 30000 
        })
      });
      const entData = await entRes.json();
      if (entData.result && entData.result.records && entData.result.records[0]) {
        entityCount = entData.result.records[0]['count()'] || 0;
        entitiesFound = entityCount > 0;
      }
    } catch (e) {
      console.log('[verify] Entities query failed:', e.message);
    }
    
    console.log(`[verify] Results: BizEvents=${bizEventsCount}, Services=${serviceCount}, Entities=${entityCount}`);
    
    res.json({
      ok: true,
      verification: {
        bizEventsFound,
        bizEventsCount,
        servicesFound,
        serviceCount,
        entitiesFound,
        entityCount,
        timeframe: '2h',
        companyName
      }
    });
    
  } catch (error) {
    console.error('[verify] Error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Test Dynatrace connection
app.post('/api/dynatrace/test-connection', async (req, res) => {
  try {
    const { environment, token } = req.body;
    
    if (!environment || !token) {
      return res.status(400).json({
        ok: false,
        error: 'Missing environment URL or token'
      });
    }
    
    // Normalize environment URL (remove trailing slash)
    const baseUrl = environment.replace(/\/$/, '');
    
    // For Sprint/SaaS environments, try the app-engine health endpoint
    // This is the most reliable endpoint that exists across all environment types
    const testUrl = `${baseUrl}/platform/app-engine/v2/app-engines`;
    
    console.log('[dynatrace-test] Testing connection to:', testUrl);
    console.log('[dynatrace-test] Using token prefix:', token.substring(0, 10) + '...');
    
    const response = await fetch(testUrl, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json'
      }
    });
    
    console.log('[dynatrace-test] Response status:', response.status);
    
    // Try to get response body for debugging
    let responseBody = '';
    try {
      responseBody = await response.text();
      console.log('[dynatrace-test] Response body:', responseBody.substring(0, 500));
    } catch (e) {
      console.log('[dynatrace-test] Could not read response body');
    }
    
    if (response.ok) {
      res.json({
        ok: true,
        message: 'Connection successful - Token validated',
        environment: baseUrl
      });
    } else if (response.status === 401) {
      res.json({
        ok: false,
        error: 'Authentication failed - Check your token is valid and not expired'
      });
    } else if (response.status === 403) {
      // 403 might actually mean auth worked but missing scope - that's OK for testing
      res.json({
        ok: true,
        message: 'Connection successful - Token authenticated (some scopes may be missing for this test endpoint)',
        environment: baseUrl
      });
    } else if (response.status === 404) {
      // 404 likely means auth worked but endpoint not available - try one more
      console.log('[dynatrace-test] First endpoint returned 404, trying alternative...');
      
      // Try DQL query endpoint - should work in Sprint
      const dqlTestUrl = `${baseUrl}/platform/storage/query/v1/query:execute`;
      const dqlTest = await fetch(dqlTestUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        body: JSON.stringify({
          query: "fetch bizevents | limit 1",
          requestTimeoutMilliseconds: 5000
        })
      });
      
      console.log('[dynatrace-test] DQL test status:', dqlTest.status);
      
      if (dqlTest.status === 200 || dqlTest.status === 403 || dqlTest.status === 400) {
        // Any of these means auth worked
        res.json({
          ok: true,
          message: 'Connection successful - Token validated via query endpoint',
          environment: baseUrl
        });
      } else if (dqlTest.status === 401) {
        res.json({
          ok: false,
          error: 'Authentication failed - Token may be invalid or expired'
        });
      } else {
        res.json({
          ok: false,
          error: `Could not verify connection - HTTP ${dqlTest.status}. Token may be valid but unable to confirm.`
        });
      }
    } else {
      res.json({
        ok: false,
        error: `HTTP ${response.status}: ${response.statusText}`,
        details: responseBody.substring(0, 200)
      });
    }
  } catch (error) {
    console.error('[dynatrace-test] Error:', error);
    res.json({
      ok: false,
      error: `Network error: ${error.message}`
    });
  }
});


// New Customer Journey endpoint - clears all services to start fresh
app.post('/api/admin/new-customer-journey', (req, res) => {
  try {
    console.log('[server] New Customer Journey requested - stopping customer journey services while preserving essential infrastructure');
    stopAllAutoLoads();
    stopCustomerJourneyServices();
    res.json({
      ok: true,
      message: 'Customer journey services stopped, essential infrastructure services preserved',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('[server] Error during new customer journey cleanup:', error);
    res.status(500).json({ 
      ok: false, 
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Configuration Persistence Endpoints
const configDir = path.join(__dirname, 'saved-configs');

// Ensure config directory exists
async function ensureConfigDir() {
  try {
    if (!existsSync(configDir)) {
      await fs.mkdir(configDir, { recursive: true });
      console.log(`📁 Created config directory: ${configDir}`);
    }
  } catch (error) {
    console.error('❌ Error creating config directory:', error);
  }
}

// Initialize config directory on startup
ensureConfigDir();

// Get all saved configurations
app.get('/api/admin/configs', async (req, res) => {
  try {
    await ensureConfigDir();
    const files = await fs.readdir(configDir);
    const configs = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const filePath = path.join(configDir, file);
          const data = await fs.readFile(filePath, 'utf8');
          const config = JSON.parse(data);
          // Use filename (without .json) as the ID for API calls
          const fileId = file.replace('.json', '').replace('config-', '');
          
          // Filter out user-saved configs (numeric-only IDs from timestamps)
          // Only include default library configs (descriptive names like "banking-account-opening")
          if (!/^\d+$/.test(fileId)) {
            configs.push({
              id: fileId,
              name: config.name,
              companyName: config.companyName,
              timestamp: config.timestamp,
              filename: file
            });
          }
        } catch (error) {
          console.warn(`⚠️ Error reading config file ${file}:`, error.message);
        }
      }
    }
    
    // Sort by name (alphabetically)
    configs.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    
    res.json({
      ok: true,
      configs: configs,
      count: configs.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error getting configs:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Save a configuration
app.post('/api/admin/configs', async (req, res) => {
  try {
    await ensureConfigDir();
    const config = req.body;
    
    // Validate required fields
    if (!config.name || !config.id) {
      return res.status(400).json({
        ok: false,
        error: 'Missing required fields: name and id',
        timestamp: new Date().toISOString()
      });
    }
    
    // Add server timestamp
    config.serverTimestamp = new Date().toISOString();
    config.version = '1.0';
    
    // Create filename from ID
    const filename = `config-${config.id}.json`;
    const filePath = path.join(configDir, filename);
    
    // Save to file
    await fs.writeFile(filePath, JSON.stringify(config, null, 2));
    
    console.log(`💾 Saved configuration "${config.name}" to ${filename}`);
    
    res.json({
      ok: true,
      message: `Configuration "${config.name}" saved successfully`,
      id: config.id,
      filename: filename,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error saving config:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// List journeys with full step/service detail (for AI Agent Hub)
// Includes servicesRunning flag based on whether child services are actively running
app.get('/api/admin/journeys', async (req, res) => {
  try {
    await ensureConfigDir();
    const files = await fs.readdir(configDir);
    const journeys = [];

    // Get currently running service metadata to check which journeys are active
    const runningMeta = getChildServiceMeta();
    const runningByCompany = {};  // companyName -> Set of running service base names
    Object.entries(runningMeta).forEach(([svcKey, meta]) => {
      const company = (meta.companyName || '').toLowerCase().trim();
      if (!company) return;
      if (!runningByCompany[company]) runningByCompany[company] = new Set();
      // Track both the internal key and the Dynatrace-style base service name
      runningByCompany[company].add(svcKey.toLowerCase());
      if (meta.baseServiceName) runningByCompany[company].add(meta.baseServiceName.toLowerCase());
      if (meta.stepName) runningByCompany[company].add(meta.stepName.toLowerCase());
    });

    // Also check active LoadRunner tests
    Object.values(loadTests).forEach(test => {
      const company = (test.companyName || '').toLowerCase().trim();
      if (!company) return;
      if (!runningByCompany[company]) runningByCompany[company] = new Set();
      runningByCompany[company].add('__loadtest__');
    });

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const filePath = path.join(configDir, file);
        const data = await fs.readFile(filePath, 'utf8');
        const config = JSON.parse(data);
        const steps = (config.steps || []).map(s => ({
          stepName: s.stepName || s.name || '',
          serviceName: s.serviceName || '',
          category: s.category || '',
          description: s.description || ''
        }));
        const services = [...new Set(steps.map(s => s.serviceName).filter(Boolean))];

        // Check if this journey's services are currently running
        const configCompany = (config.companyName || '').toLowerCase().trim();
        const runningSet = runningByCompany[configCompany] || new Set();
        let runningServiceCount = services.filter(svc => runningSet.has(svc.toLowerCase())).length;
        
        // If config has no steps but services ARE running for this company,
        // detect them from the running metadata and inject steps/services
        if (steps.length === 0 && runningSet.size > 0) {
          const dynamicSteps = [];
          const dynamicServices = [];
          Object.entries(runningMeta).forEach(([svcKey, meta]) => {
            if ((meta.companyName || '').toLowerCase().trim() === configCompany) {
              const stepName = meta.stepName || meta.baseServiceName || svcKey;
              const serviceName = meta.baseServiceName || svcKey.replace(/-[^-]*$/, '');
              if (!dynamicServices.includes(serviceName)) {
                dynamicServices.push(serviceName);
                dynamicSteps.push({
                  stepName: stepName,
                  serviceName: serviceName,
                  category: '',
                  description: ''
                });
              }
            }
          });
          if (dynamicSteps.length > 0) {
            steps.push(...dynamicSteps);
            services.push(...dynamicServices);
            runningServiceCount = dynamicServices.length;
          }
        }
        
        const servicesRunning = runningServiceCount > 0 || runningSet.has('__loadtest__');

        journeys.push({
          id: file.replace(/\.json$/, '').replace(/^config-/, ''),
          filename: file,
          companyName: config.companyName || '',
          industryType: config.industryType || '',
          journeyType: config.journeyType || config.journeyDetail || '',
          domain: config.domain || '',
          stepsCount: steps.length,
          services,
          steps,
          servicesRunning,
          runningServiceCount
        });
      } catch (err) {
        console.warn(`⚠️ Error reading journey file ${file}:`, err.message);
      }
    }

    // Sort: active journeys first, then alphabetically
    journeys.sort((a, b) => {
      if (a.servicesRunning !== b.servicesRunning) return b.servicesRunning ? 1 : -1;
      return a.companyName.localeCompare(b.companyName);
    });

    const activeCount = journeys.filter(j => j.servicesRunning).length;
    res.json({
      ok: true,
      journeys,
      count: journeys.length,
      activeCount
    });
  } catch (error) {
    console.error('❌ Error listing journeys:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// List saved configurations (simplified for CLI/automation access)
app.get('/api/admin/configs/list', async (req, res) => {
  try {
    await ensureConfigDir();
    const files = await fs.readdir(configDir);
    const configs = [];
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const filePath = path.join(configDir, file);
          const data = await fs.readFile(filePath, 'utf8');
          const config = JSON.parse(data);
          configs.push({
            id: config.id,
            name: config.name,
            companyName: config.companyName,
            stepsCount: config.steps?.length || 0,
            timestamp: config.timestamp
          });
        } catch (error) {
          console.warn(`⚠️ Error reading config file ${file}:`, error.message);
        }
      }
    }
    
    res.json({
      ok: true,
      configs: configs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)),
      count: configs.length
    });
    
  } catch (error) {
    console.error('❌ Error listing configs:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// Get a specific configuration
app.get('/api/admin/configs/:id', async (req, res) => {
  try {
    const configId = req.params.id;
    
    // Try multiple filename patterns to support both old UUID-based and new named configs
    const possibleFilenames = [
      `config-${configId}.json`,           // New format: config-banking-account-opening.json
      `config-${configId.toLowerCase()}.json`  // Case insensitive variant
    ];
    
    let filePath = null;
    let filename = null;
    
    // Try each possible filename
    for (const fn of possibleFilenames) {
      const testPath = path.join(configDir, fn);
      if (existsSync(testPath)) {
        filePath = testPath;
        filename = fn;
        break;
      }
    }
    
    // If still not found, search by internal ID in all config files
    if (!filePath) {
      const files = await fs.readdir(configDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const testPath = path.join(configDir, file);
            const data = await fs.readFile(testPath, 'utf8');
            const config = JSON.parse(data);
            if (config.id === configId) {
              filePath = testPath;
              filename = file;
              break;
            }
          } catch (err) {
            // Skip files that can't be read
          }
        }
      }
    }
    
    // Check if file was found
    if (!filePath) {
      return res.status(404).json({
        ok: false,
        error: 'Configuration not found',
        id: configId,
        timestamp: new Date().toISOString()
      });
    }
    
    // Read and parse config
    const data = await fs.readFile(filePath, 'utf8');
    const config = JSON.parse(data);
    
    res.json({
      ok: true,
      config: config,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error getting config:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Delete a configuration
app.delete('/api/admin/configs/:id', async (req, res) => {
  try {
    const configId = req.params.id;
    
    // Try multiple filename patterns to support both old UUID-based and new named configs
    const possibleFilenames = [
      `config-${configId}.json`,           // New format: config-banking-account-opening.json
      `config-${configId.toLowerCase()}.json`  // Case insensitive variant
    ];
    
    let filePath = null;
    let filename = null;
    
    // Try each possible filename
    for (const fn of possibleFilenames) {
      const testPath = path.join(configDir, fn);
      if (existsSync(testPath)) {
        filePath = testPath;
        filename = fn;
        break;
      }
    }
    
    // If still not found, search by internal ID in all config files
    if (!filePath) {
      const files = await fs.readdir(configDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          try {
            const testPath = path.join(configDir, file);
            const data = await fs.readFile(testPath, 'utf8');
            const config = JSON.parse(data);
            if (config.id === configId) {
              filePath = testPath;
              filename = file;
              break;
            }
          } catch (err) {
            // Skip files that can't be read
          }
        }
      }
    }
    
    // Check if file was found
    if (!filePath) {
      return res.status(404).json({
        ok: false,
        error: 'Configuration not found',
        id: configId,
        timestamp: new Date().toISOString()
      });
    }
    
    // Read config name for logging
    let configName = 'Unknown';
    try {
      const data = await fs.readFile(filePath, 'utf8');
      const config = JSON.parse(data);
      configName = config.name;
    } catch (e) {
      // Ignore error, just use Unknown
    }
    
    // Delete file
    await fs.unlink(filePath);
    
    console.log(`🗑️ Deleted configuration "${configName}" (${filename})`);
    
    res.json({
      ok: true,
      message: `Configuration "${configName}" deleted successfully`,
      id: configId,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ Error deleting config:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Run a saved configuration (programmatic access for LoadRunner/automation)
app.post('/api/admin/configs/:id/run', async (req, res) => {
  try {
    const configId = req.params.id;
    const { 
      testProfile = 'medium', 
      durationMinutes = 5, 
      featureFlags = {},
      useLoadRunner = false
    } = req.body;
    
    // Legacy support: convert errorSimulationEnabled to feature flags
    if (req.body.errorSimulationEnabled === true && Object.keys(featureFlags).length === 0) {
      console.log('⚠️ Legacy errorSimulationEnabled detected, converting to feature flags');
      featureFlags.payment_gateway_timeout = {
        enabled: true,
        errorRate: 0.15,
        errorType: 'timeout',
        affectedSteps: ['PaymentProcessing', 'CheckoutService']
      };
    }
    
    // Load the configuration
    const filename = `config-${configId}.json`;
    const filePath = path.join(configDir, filename);
    
    if (!existsSync(filePath)) {
      return res.status(404).json({
        ok: false,
        error: 'Configuration not found',
        id: configId,
        timestamp: new Date().toISOString()
      });
    }
    
    const data = await fs.readFile(filePath, 'utf8');
    const config = JSON.parse(data);
    
    console.log(`🚀 Running configuration "${config.name}" programmatically`);
    
    if (useLoadRunner) {
      // Forward to LoadRunner integration
      try {
        const loadrunnerPayload = {
          journeyConfig: config,
          testProfile,
          durationMinutes,
          featureFlags
        };
        
        // Make internal request to LoadRunner endpoint
        const fetch = (await import('node-fetch')).default;
        const loadrunnerResponse = await fetch(`http://localhost:${PORT || 8080}/api/loadrunner/start-test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(loadrunnerPayload)
        });
        
        const loadrunnerResult = await loadrunnerResponse.json();
        
        res.json({
          ok: true,
          message: `LoadRunner test started for configuration "${config.name}"`,
          configId: configId,
          configName: config.name,
          loadrunnerResult: loadrunnerResult,
          timestamp: new Date().toISOString()
        });
        
      } catch (loadrunnerError) {
        console.error('❌ LoadRunner execution error:', loadrunnerError);
        res.status(500).json({
          ok: false,
          error: 'Failed to start LoadRunner test: ' + loadrunnerError.message,
          configId: configId,
          timestamp: new Date().toISOString()
        });
      }
    } else {
      // Run as a regular journey simulation
      try {
        // Execute the journey steps programmatically
        let journeyResults = [];
        
        for (const step of config.steps) {
          const stepResult = {
            stepName: step.stepName,
            timestamp: new Date().toISOString(),
            status: 'completed'
          };
          
          journeyResults.push(stepResult);
          
          // Ensure the service is running for this step
          if (step.stepName) {
            ensureServiceRunning(step.stepName, { 
              companyName: config.companyName,
              domain: config.domain 
            });
          }
        }
        
        res.json({
          ok: true,
          message: `Configuration "${config.name}" executed successfully`,
          configId: configId,
          configName: config.name,
          executionType: 'journey-simulation',
          results: journeyResults,
          timestamp: new Date().toISOString()
        });
        
      } catch (executionError) {
        console.error('❌ Journey execution error:', executionError);
        res.status(500).json({
          ok: false,
          error: 'Failed to execute journey: ' + executionError.message,
          configId: configId,
          timestamp: new Date().toISOString()
        });
      }
    }
    
  } catch (error) {
    console.error('❌ Error running config:', error);
    res.status(500).json({
      ok: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Simple metrics endpoint to silence polling 404s
app.get('/api/metrics', (req, res) => {
  res.setHeader('Content-Type', 'text/plain');
  res.send('# Basic metrics placeholder\napp_status 1\n');
});

// MongoDB Analytics Endpoints
// MongoDB analytics and journey endpoints removed

// Expose event service for routes
app.locals.eventService = eventService;

// Error handling with metadata injection
app.use((err, req, res, next) => {
  console.error('Server error:', err);
  
  // Inject error metadata for Dynatrace
  const errorMetadata = injectErrorMetadata(err, req, res);
  
  res.status(500).json({
    error: 'Internal Server Error',
    message: err.message,
    timestamp: new Date().toISOString(),
    correlationId: req.correlationId,
    metadata: errorMetadata
  });
});

// ============================================
// Startup: Prompt for credentials, then start server
// ============================================
(async () => {
  // Prompt for Dynatrace credentials if not already configured
  await promptForCredentials();
  startupState.credentialsResolved = true;

  // Start the server and initialize child services
  server.listen(PORT, () => {
    console.log(`🚀 Business Observability Server running on port ${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);

    // Auto disk cleanup on boot if disk > 90%
    if (systemMaintenanceRouter.autoCleanupOnBoot) {
      systemMaintenanceRouter.autoCleanupOnBoot().catch(e => console.warn('[auto-cleanup] Boot cleanup failed:', e.message));
    }
    // Scheduled disk cleanup every 15 minutes
    if (systemMaintenanceRouter.startScheduledCleanup) {
      server.diskCleanupTimer = systemMaintenanceRouter.startScheduledCleanup();
    }
    app.locals.port = PORT;

  // --- Pre-startup dependency validation ---
  console.log('🔍 Validating dependencies and environment...');
  
  // Check essential dependencies
  const essentialDependencies = [
    { name: 'Express', check: () => app && typeof app.listen === 'function' },
    { name: 'Socket.IO', check: () => io && typeof io.emit === 'function' },
    { name: 'Service Manager', check: () => typeof ensureServiceRunning === 'function' },
    { name: 'Event Service', check: () => typeof eventService === 'object' },
    { name: 'UUID Generator', check: () => typeof uuidv4 === 'function' }
  ];
  
  const failedDependencies = essentialDependencies.filter(dep => {
    try {
      return !dep.check();
    } catch (error) {
      console.error(`❌ Dependency check failed for ${dep.name}:`, error.message);
      return true;
    }
  });
  
  if (failedDependencies.length > 0) {
    console.error('❌ Critical dependencies missing:', failedDependencies.map(d => d.name).join(', '));
    console.error('⚠️  Some features may not work correctly.');
  } else {
    console.log('✅ All essential dependencies validated successfully.');
  }
  startupState.dependencyFailures = failedDependencies.map(dep => dep.name);

  // --- Clean up orphaned service processes from previous server sessions ---
  // These zombie processes hold ports in the service port range and cause
  // "No available ports" errors for new journeys
  try {
    const killed = cleanupOrphanedServiceProcesses();
    if (killed > 0) {
      console.log(`🧹 Cleaned up ${killed} orphaned service processes from previous sessions`);
      // Give ports a moment to be released by the OS after process termination
      setTimeout(() => {
        console.log('✅ Port cleanup settling complete - ports should be available now');
      }, 2000);
    }
  } catch (error) {
    console.warn('⚠️  Orphan process cleanup failed:', error.message);
  }

  // --- Check directory structure and permissions ---
  const requiredDirectories = [
    './services',
    './services/.dynamic-runners',
    './routes',
    './public'
  ];
  
  requiredDirectories.forEach(dir => {
    try {
      import('fs').then(fs => {
        if (!fs.existsSync(dir)) {
          console.warn(`⚠️  Required directory missing: ${dir}`);
        }
      });
    } catch (error) {
      console.warn(`⚠️  Cannot verify directory: ${dir}`);
    }
  });

  // --- Auto-start disabled - all services now start on-demand per company ---
  const coreServices = [
    // All services start on-demand when journeys are run
    // No default services - prevents ShopMart, Global Financial, DefaultCompany from running
  ];
  
  // ⚠️ No default company context - services only start when explicitly requested per journey
  console.log(`🚀 Auto-start disabled - all services will start on-demand when journeys are run`);
  console.log(`⚠️ No default services (ShopMart, Global Financial, DefaultCompany will NOT start)`);

  
  // Start services with proper error handling and logging
  const serviceStartPromises = coreServices.map(async (stepName, index) => {
    try {
      // Add a small delay between service starts to prevent port conflicts
      await new Promise(resolve => setTimeout(resolve, index * 100));
      
      ensureServiceRunning(stepName, companyContext);
      console.log(`✅ Essential service for step "${stepName}" started successfully.`);
      return { stepName, status: 'started' };
    } catch (err) {
      console.error(`❌ Failed to start essential service for step "${stepName}":`, err.message);
      return { stepName, status: 'failed', error: err.message };
    }
  });
  
  // Wait for all services to attempt startup
  Promise.all(serviceStartPromises).then(results => {
    const successful = results.filter(r => r.status === 'started').length;
    const failed = results.filter(r => r.status === 'failed').length;
    startupState.serviceStartupCompleted = true;
    startupState.serviceStartupSuccessful = successful;
    startupState.serviceStartupFailed = failed;
    startupState.startupCompletedAt = new Date().toISOString();
    
    console.log(`🔧 Service startup completed: ${successful} successful, ${failed} failed`);
    
    if (failed > 0) {
      console.log('⚠️  Failed services:', results.filter(r => r.status === 'failed').map(r => r.stepName).join(', '));
    }
    
    // Additional startup validation
    setTimeout(async () => {
      try {
        const runningServices = getChildServices();
        const runningCount = Object.keys(runningServices).length;
        console.log(`📊 Status check: ${runningCount} services currently running`);
        
        if (runningCount < successful * 0.8) {
          console.warn('⚠️  Some services may have failed to start properly. Check logs for details.');
        } else {
          console.log('✨ All core services appear to be running successfully!');
        }
      } catch (error) {
        console.error('❌ Error during startup validation:', error.message);
      }
    }, 3000);
    }).catch(error => {
    startupState.serviceStartupCompleted = true;
    startupState.serviceStartupFailed = serviceStartPromises.length;
    startupState.startupCompletedAt = new Date().toISOString();
    console.error('❌ Critical error during service startup:', error.message);
  });
  
  // --- Start Auto-Load Watcher ---
  // Monitors running services and auto-generates 30-60 journeys/min per company
  startAutoLoadWatcher();
  startupState.autoLoadWatcherStarted = true;
  
  // Make startAutoLoadWatcher available globally so journey routes can restart it after a stop
  global.startAutoLoadWatcher = startAutoLoadWatcher;

  // --- Auto-start Dynatrace MCP Server if environment is configured ---
  if (dtCredentials.environmentUrl) {
    // Normalize URL to .apps. format required by MCP server
    let mcpEnvUrl = dtCredentials.environmentUrl;
    mcpEnvUrl = mcpEnvUrl.replace(/\/+$/, '');
    if (!mcpEnvUrl.includes('.apps.')) {
      // e.g. https://abc123.sprint.dynatracelabs.com → https://abc123.sprint.apps.dynatracelabs.com
      mcpEnvUrl = mcpEnvUrl.replace(/\.sprint\.dynatracelabs\.com/, '.sprint.apps.dynatracelabs.com')
                           .replace(/\.dynatrace\.com/, '.apps.dynatrace.com');
    }
    console.log(`[MCP] Auto-starting Dynatrace MCP Server for ${mcpEnvUrl}...`);
    startMcpServer(mcpEnvUrl, 3000)
      .then(result => {
        if (result.status === 'running') {
          console.log('[MCP] ✅ Dynatrace MCP Server auto-started on port 3000');
        } else {
          console.log(`[MCP] ⚠️  MCP Server status: ${result.status} (may need OAuth — check UI)`);
        }
        if (result.authUrl) {
          console.log(`[MCP] 🔑 OAuth URL: ${result.authUrl}`);
        }
      })
      .catch(err => {
        console.warn('[MCP] ⚠️  Auto-start failed:', err.message, '— start manually from UI');
      });
  } else {
    console.log('[MCP] No Dynatrace environment configured — MCP Server will start when you connect via UI');
  }
  
  // Start periodic health monitoring every 15 minutes
  const healthMonitor = setInterval(async () => {
    try {
      const healthCheck = await performHealthCheck();
      if (healthCheck.unhealthyServices > 0 || healthCheck.portConflicts > 0) {
        console.warn(`⚠️  Health check issues: ${healthCheck.unhealthyServices} unhealthy services, ${healthCheck.portConflicts} port conflicts, ${healthCheck.availablePorts} ports available`);
        if (healthCheck.issues.length > 0) {
          console.warn('Issues:', healthCheck.issues.slice(0, 3).join(', '));
        }
      }
    } catch (error) {
      console.error('❌ Health monitor error:', error.message);
    }
  }, 900000); // 15 minutes = 900,000 milliseconds
  
  // Store health monitor for cleanup
  server.healthMonitor = healthMonitor;
  
  // --- Auto-start AI Agents ---
  console.log('🤖 Starting autonomous AI agents...');
  try {
    // Start Nemesis Chaos Scheduler (auto-enabled, 2-hour warmup, volume-based triggering)
    if (startNemesisScheduler) {
      startNemesisScheduler();
      console.log('✅ Nemesis AI Agent: Started (warmup: 2 hours, volume-based triggering)');
    } else {
      console.log('⚠️  Nemesis AI Agent: Skipped (scheduler not compiled)');
    }
    
    // Fix-It Agent: triggered by Dynatrace workflow webhook (POST /api/workflow-webhook/problem)
    // No auto-polling — Dynatrace detects problems and calls the webhook (~5-10 min after problem opens)
    console.log('✅ Fix-It AI Agent: Ready (workflow webhook mode — waiting for Dynatrace problem notifications)');
    startupState.aiAgentsReady = true;
  } catch (agentError) {
    startupState.aiAgentsReady = false;
    console.error('⚠️  AI Agents startup error (non-fatal):', agentError.message);
  }
  
  // --- Auto-start MCP Server ---
  console.log('🔍 Checking for Dynatrace MCP Server configuration...');
  
  // Check for environment variable first, then check if we can load from some config
  const dtEnvironment = process.env.DT_ENVIRONMENT || process.env.DT_MCP_ENVIRONMENT;
  
  if (dtEnvironment) {
    console.log(`🚀 Starting Dynatrace MCP Server for environment: ${dtEnvironment}`);
    
    // Start MCP server automatically
    mcpServerStatus = 'starting';
    mcpServerProcess = spawn('npx', [
      '-y',
      '@dynatrace-oss/dynatrace-mcp-server@latest',
      '--http',
      '-p',
      '3000'
    ], {
      env: {
        ...process.env,
        DT_ENVIRONMENT: dtEnvironment,
        DT_MCP_DISABLE_TELEMETRY: 'false'
      },
      cwd: process.cwd()
    });
    
    // Capture stdout for OAuth URL
    mcpServerProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('[MCP]', output.trim());
      
      // Look for OAuth URL
      const oauthMatch = output.match(/https:\/\/[^\s]+oauth2\/authorize[^\s]+/);
      if (oauthMatch) {
        mcpServerAuthUrl = oauthMatch[0];
        console.log('🔐 [MCP] OAuth URL available (open in browser if needed)');
      }
      
      // Check if server started successfully
      if (output.includes('Dynatrace MCP Server running on HTTP')) {
        mcpServerStatus = 'running';
        console.log('✅ [MCP] Server is now running on port 3000');
      }
    });
    
    mcpServerProcess.stderr.on('data', (data) => {
      const error = data.toString().trim();
      if (!error.includes('npm warn') && !error.includes('nohup:')) {
        console.error('[MCP ERROR]', error);
      }
    });
    
    mcpServerProcess.on('exit', (code) => {
      console.log(`[MCP] Process exited with code: ${code}`);
      mcpServerStatus = code === 0 ? 'stopped' : 'error';
      mcpServerProcess = null;
    });
  } else {
    console.log('ℹ️  No DT_ENVIRONMENT set - MCP server will start on first connection test');
    console.log('💡 Set DT_ENVIRONMENT env var to auto-start MCP server on app startup');
  }
  
  // --- Auto-start Continuous Journey Generator ---
  let continuousJourneyProcess = null;
  const ENABLE_CONTINUOUS_JOURNEYS = process.env.ENABLE_CONTINUOUS_JOURNEYS === 'true';
  
  // Function to start continuous journey generator
  function startContinuousJourneyGenerator() {
    if (continuousJourneyProcess) {
      console.log('ℹ️  Continuous Journey Generator already running');
      return;
    }
    
    console.log('🔄 Starting Continuous Journey Generator...');
    
    continuousJourneyProcess = spawn('node', [
      path.join(__dirname, 'scripts', 'continuous-journey-generator.js')
    ], {
      env: {
        ...process.env,
        BIZOBS_API_URL: `http://localhost:${PORT}`,
        JOURNEY_INTERVAL_MS: process.env.JOURNEY_INTERVAL_MS || '30000',
        JOURNEY_BATCH_SIZE: process.env.JOURNEY_BATCH_SIZE || '5'
      },
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    continuousJourneyProcess.stdout.on('data', (data) => {
      console.log('[Continuous Journey]', data.toString().trim());
    });
    
    continuousJourneyProcess.stderr.on('data', (data) => {
      console.error('[Continuous Journey ERROR]', data.toString().trim());
    });
    
    continuousJourneyProcess.on('exit', (code) => {
      console.log(`[Continuous Journey] Process exited with code: ${code}`);
      continuousJourneyProcess = null;
      server.continuousJourneyProcess = null;
    });
    
    // Store reference for cleanup
    server.continuousJourneyProcess = continuousJourneyProcess;
    global.continuousJourneyProcess = continuousJourneyProcess;
    
    console.log('✅ Continuous Journey Generator started');
  }
  
  // Store the start function globally for access from routes
  global.startContinuousJourneyGenerator = startContinuousJourneyGenerator;
  
  // Auto-start if environment variable is set
  if (ENABLE_CONTINUOUS_JOURNEYS) {
    startContinuousJourneyGenerator();
  } else {
    console.log('ℹ️  Continuous Journey Generator disabled');
    console.log('💡 Will auto-start when you create a journey simulation');
    console.log('💡 Or set ENABLE_CONTINUOUS_JOURNEYS=true to start immediately');
  }
});

})(); // end async startup IIFE

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully...');
  
  // Stop auto-load watcher and all auto-loads
  stopAutoLoadWatcher();
  
  // Save port allocations before shutdown
  portManager.saveState();
  
  // Save chaos/feature flag state before shutdown
  saveChaosState();
  
  // Stop continuous journey generator if running
  if (server.continuousJourneyProcess) {
    console.log('[Continuous Journey] Stopping generator...');
    server.continuousJourneyProcess.kill();
    server.continuousJourneyProcess = null;
  }
  
  // Stop MCP server if running
  if (mcpServerProcess) {
    console.log('[MCP] Stopping MCP server...');
    mcpServerProcess.kill();
    mcpServerProcess = null;
  }
  
  // Stop health monitor
  if (server.healthMonitor) {
    clearInterval(server.healthMonitor);
  }
  
  // Close child services
  stopAllServices();
  
  server.close(() => {
    console.log('👋 Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully...');
  
  // Stop auto-load watcher and all auto-loads
  stopAutoLoadWatcher();
  
  // Save port allocations before shutdown
  portManager.saveState();
  
  // Save chaos/feature flag state before shutdown
  saveChaosState();
  
  // Stop continuous journey generator if running
  if (server.continuousJourneyProcess) {
    console.log('[Continuous Journey] Stopping generator...');
    server.continuousJourneyProcess.kill();
    server.continuousJourneyProcess = null;
  }
  
  // Stop MCP server if running
  if (mcpServerProcess) {
    console.log('[MCP] Stopping MCP server...');
    mcpServerProcess.kill();
    mcpServerProcess = null;
  }
  
  // Stop health monitor
  if (server.healthMonitor) {
    clearInterval(server.healthMonitor);
  }
  
  // Close child services using service manager
  stopAllServices();
  
  server.close(() => {
    console.log('👋 Server closed');
    process.exit(0);
  });
});

// Prevent silent crashes — log unhandled errors instead of killing the process
// Exception: EADDRINUSE means another server is already running on this port.
// Exit immediately so the existing process stays in control and we don't run as a zombie.
process.on('uncaughtException', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`🚨 Port ${err.port || PORT} is already in use. Another server instance is running.`);
    console.error('   Run ./stop.sh first, then restart.');
    process.exit(1);
  }
  console.error('🚨 UNCAUGHT EXCEPTION (process kept alive):', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  console.error('🚨 UNHANDLED REJECTION (process kept alive):', reason);
});

export default app;