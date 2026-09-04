/**
 * OpenTelemetry Bootstrap — loaded via  node --require ./otel.js server.js
 *
 * Follows the official Dynatrace walkthrough:
 * https://docs.dynatrace.com/docs/shortlink/otel-wt-nodejs
 *
 * Automatically instruments HTTP calls
 * and exports traces + metrics + logs to Dynatrace via OTLP.
 *
 * Token scopes required (stored in .dt-credentials.json → otelToken):
 *   - openTelemetryTrace.ingest
 *   - metrics.ingest
 *   - logs.ingest
 */

// Load .env first so all modules (including config.ts) see env vars at import time
require('dotenv').config();

const opentelemetry = require("@opentelemetry/api");
const {
  resourceFromAttributes,
  emptyResource,
  defaultResource,
} = require("@opentelemetry/resources");
const {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} = require("@opentelemetry/semantic-conventions");
const { NodeTracerProvider } = require("@opentelemetry/sdk-trace-node");
const { registerInstrumentations } = require("@opentelemetry/instrumentation");
const { BatchSpanProcessor } = require("@opentelemetry/sdk-trace-base");
const {
  OTLPTraceExporter,
} = require("@opentelemetry/exporter-trace-otlp-proto");
const {
  OTLPMetricExporter,
} = require("@opentelemetry/exporter-metrics-otlp-proto");
const {
  MeterProvider,
  PeriodicExportingMetricReader,
  AggregationTemporality,
} = require("@opentelemetry/sdk-metrics");
const {
  LoggerProvider,
  BatchLogRecordProcessor,
} = require("@opentelemetry/sdk-logs");
const {
  OTLPLogExporter,
} = require("@opentelemetry/exporter-logs-otlp-proto");
const {
  HttpInstrumentation,
} = require("@opentelemetry/instrumentation-http");
const {
  UndiciInstrumentation,
} = require("@opentelemetry/instrumentation-undici");

const { logs: logsAPI } = require("@opentelemetry/api-logs");
const fs = require("fs");

// Surface exporter/runtime issues in logs without flooding normal output.
opentelemetry.diag.setLogger(
  new opentelemetry.DiagConsoleLogger(),
  opentelemetry.DiagLogLevel.ERROR
);

function deriveOtlpBaseUrl(rawUrl) {
  const base = String(rawUrl || "").trim().replace(/\/+$/, "");
  if (!base) return "";

  // Sprint/labs: UI + platform uses *.sprint.apps.dynatracelabs.com,
  // OTLP ingest uses *.sprint.dynatracelabs.com.
  if (base.includes(".sprint.apps.dynatracelabs.com")) {
    return base.replace(".sprint.apps.dynatracelabs.com", ".sprint.dynatracelabs.com");
  }

  // Dynatrace SaaS: UI uses *.apps.dynatrace.com,
  // OTLP ingest uses *.live.dynatrace.com.
  if (base.includes(".apps.dynatrace.com")) {
    return base.replace(".apps.dynatrace.com", ".live.dynatrace.com");
  }

  return base;
}

// ===== LOAD CREDENTIALS =====
// Prefer the dedicated otelToken from .dt-credentials.json (has ingest scopes)
// Fall back to env vars or the general apiToken

const { dtAuthHeader, dtAuthScheme, isPlatformToken, isClassicToken } = require("./utils/dt-auth.cjs");

let DT_API_URL = "";
let DT_API_TOKEN = "";

// 1. Try env vars first
if (process.env.DT_OTLP_ENDPOINT) {
  DT_API_URL = process.env.DT_OTLP_ENDPOINT.replace(/\/+$/, "") + "/api/v2/otlp";
} else if (process.env.DT_ENVIRONMENT) {
  DT_API_URL = deriveOtlpBaseUrl(process.env.DT_ENVIRONMENT) + "/api/v2/otlp";
}
DT_API_TOKEN = process.env.DT_OTEL_TOKEN || "";

// 2. Fill gaps from .dt-credentials.json (resolve relative to this file's directory, not cwd)
const credentialsPath = require("path").resolve(__dirname, ".dt-credentials.json");
try {
  const creds = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));
  if (!DT_API_URL && creds.environmentUrl) {
    DT_API_URL = deriveOtlpBaseUrl(creds.environmentUrl) + "/api/v2/otlp";
  }
  // Prefer the dedicated otelToken (has ingest scopes).
  // A Gen3 platform token (dt0s16.*) with openpipeline:*:ingest works here too, and is
  // now the preferred option. It just needs the Bearer scheme instead of Api-Token,
  // which dtAuthHeader() handles. (The previous note here claimed platform tokens
  // "often lack ingest scopes" — that was a scopes problem, not an auth-scheme one.)
  if (!DT_API_TOKEN) {
    DT_API_TOKEN = creds.otelToken || creds.apiToken || "";
  }
  if (DT_API_URL) {
    console.log("[otel.js] 📦 Loaded credentials from .dt-credentials.json");
    console.log("[otel.js]    Token type:", creds.otelToken ? "otelToken (ingest scopes)" : "apiToken (general)");
  }
} catch {
  // file not present
}

if (!DT_API_URL || !DT_API_TOKEN) {
  console.warn("[otel.js] ⚠️  Missing DT URL or token — OTel will NOT export");
  console.warn("[otel.js] 💡 Configure credentials at startup or via the UI, then restart for OTel export");
} else {
  console.log(`[otel.js] ✅ OTLP endpoint: ${DT_API_URL}`);
  console.log(`[otel.js]    Auth scheme: ${dtAuthScheme(DT_API_TOKEN)}`
    + (isPlatformToken(DT_API_TOKEN) ? " (Gen3 platform token)" : isClassicToken(DT_API_TOKEN) ? " (classic access token)" : ""));
}

const CAN_EXPORT = !!(DT_API_URL && DT_API_TOKEN);
// Classic tokens use "Api-Token", platform tokens and OAuth tokens use "Bearer".
// See utils/dt-auth.cjs for the rule and the empirical verification behind it.
const AUTH_HEADER = { Authorization: dtAuthHeader(DT_API_TOKEN) };

// ===== GENERAL SETUP =====

registerInstrumentations({
  instrumentations: [
    // Instruments http/https module (legacy requests)
    new HttpInstrumentation(),
    // Instruments native fetch() (undici) — required for Node >= 18
    new UndiciInstrumentation(),
  ],
});

// ===== DT METADATA ENRICHMENT =====
// Read OneAgent metadata files to link OTel data with host/process topology

let dtmetadata = emptyResource();
for (const name of [
  "dt_metadata_e617c525669e072eebe3d0f08212e8f2.json",
  "/var/lib/dynatrace/enrichment/dt_metadata.json",
  "/var/lib/dynatrace/enrichment/dt_host_metadata.json",
]) {
  try {
    dtmetadata = dtmetadata.merge(
      resourceFromAttributes(
        JSON.parse(
          fs.readFileSync(
            name.startsWith("/var")
              ? name
              : fs.readFileSync(name).toString("utf-8").trim()
          ).toString("utf-8")
        )
      )
    );
    console.log(`[otel.js] 📎 Loaded DT metadata from: ${name}`);
    break;
  } catch {
    // metadata file not present — skip
  }
}

// Use env var for service name so child services get their own identity.
// Guard against invalid method-only names (GET/POST/etc.) becoming service entities.
function resolveOtelServiceName() {
  const fallback = "bizobs-ai-engine";
  const candidate = String(process.env.OTEL_SERVICE_NAME || process.env.DT_SERVICE_NAME || fallback).trim();
  const methodOnly = /^(get|post|put|delete|patch|head|options)$/i.test(candidate);
  if (!candidate || methodOnly) {
    const safeFallback = String(process.env.DT_APPLICATION_ID || process.env.SERVICE_NAME || process.env.DYNATRACE_SERVICE_NAME || fallback).trim();
    return safeFallback || fallback;
  }
  return candidate;
}

const otelServiceName = resolveOtelServiceName();

const resource = defaultResource()
  .merge(
    resourceFromAttributes({
      [ATTR_SERVICE_NAME]: otelServiceName,
      [ATTR_SERVICE_VERSION]: "2.9.10",
      "deployment.environment": process.env.NODE_ENV || "production",
      "service.namespace": "bizobs",
    })
  )
  .merge(dtmetadata);

// ===== TRACING SETUP =====

if (CAN_EXPORT) {
  const traceExporter = new OTLPTraceExporter({
    url: DT_API_URL + "/v1/traces",
    headers: AUTH_HEADER,
  });

  const traceProcessor = new BatchSpanProcessor(traceExporter);

  const tracerProvider = new NodeTracerProvider({
    resource: resource,
    spanProcessors: [traceProcessor],
  });

  tracerProvider.register();
  console.log("[otel.js] 📡 Traces → " + DT_API_URL + "/v1/traces");

  // ===== METRIC SETUP =====

  const metricExporter = new OTLPMetricExporter({
    url: DT_API_URL + "/v1/metrics",
    headers: AUTH_HEADER,
    temporalityPreference: AggregationTemporality.DELTA,
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 3000,
  });

  const meterProvider = new MeterProvider({
    resource: resource,
    readers: [metricReader],
  });

  opentelemetry.metrics.setGlobalMeterProvider(meterProvider);
  console.log("[otel.js] 📊 Metrics → " + DT_API_URL + "/v1/metrics");

  // ===== LOG SETUP =====

  const logExporter = new OTLPLogExporter({
    url: DT_API_URL + "/v1/logs",
    headers: AUTH_HEADER,
  });

  const loggerProvider = new LoggerProvider({
    resource: resource,
    processors: [new BatchLogRecordProcessor(logExporter)],
  });

  logsAPI.setGlobalLoggerProvider(loggerProvider);
  console.log("[otel.js] 📝 Logs   → " + DT_API_URL + "/v1/logs");

  // ===== READY =====
  console.log("[otel.js] 🎯 OpenTelemetry initialized — traces + metrics + logs → Dynatrace");
} else {
  // No credentials — register a basic tracer for local context propagation only
  const tracerProvider = new NodeTracerProvider({ resource: resource });
  tracerProvider.register();
  console.log("[otel.js] 🔇 OTel initialized (local only — no export). Configure DT credentials to enable export.");
}
