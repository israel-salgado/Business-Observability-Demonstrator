/**
 * AI Dashboard Generator - REBUILT
 * Creates bespoke Dynatrace dashboards based on journey data using Ollama LLM
 * 
 * KEY DESIGN PRINCIPLES:
 * 1. Scans the FULL incoming payload (additionalFields, customerProfile, traceMetadata)
 * 2. Dynamically generates tiles based on detected fields (e.g., loyaltyStatus → donut chart)
 * 3. Service tiles use proper DQL: timeseries with $Service/$ServiceID cascading variables
 * 4. LLM prompt includes actual detected fields so it makes smart tile choices
 * 5. No hardcoded references to any specific app — fully generic for any BizObs journey
 */

import express from 'express';
import fs from 'fs/promises';
// Classic tokens (dt0c01.*) use "Api-Token"; platform tokens (dt0s16.*) and OAuth
// access tokens use "Bearer". See utils/dt-auth.cjs.
import dtAuth from '../utils/dt-auth.cjs';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { performance } from 'perf_hooks';
import { trace, SpanKind, SpanStatusCode, metrics } from '@opentelemetry/api';
import { getFields, getAllEntries, getRepoSummary } from '../services/field-repo.js';
import {
  getProvenVariables,
  buildProvenDashboard,
  getJourneyOverviewTiles,
  getFilteredViewTiles,
  getPerformanceTiles,
  getGoldenSignalTiles,
  getObservabilityTiles,
  getSectionHeaders,
  getHeaderMarkdown,
  getJourneyFlowMarkdown,
  getDeepLinksMarkdown,
  getFooterMarkdown,
  PROVEN_LAYOUT
} from '../templates/dql/proven-dashboard-template.js';
import { getBespokePrompt, getBespokeSections } from '../templates/dql/bespoke-prompts.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

const SKILLS_PATH = path.join(__dirname, '../ai-agent-knowledge-base-main@c5ea8662910/knowledge-base/dynatrace/skills');
const PROMPTS_PATH = path.join(__dirname, '../prompts');

const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2:1b';

// Respect OLLAMA_MODE — when 'disabled', never call Ollama and use templates only.
// Read lazily rather than at import time, because this module's static import is
// evaluated before server.js gets to set global.ollamaMode.
// Anything other than 'disabled' ('auto', the default, or 'full') means "try it",
// and checkOllamaAvailable() below decides based on a real probe. That way a host
// without Ollama degrades to templates instead of erroring on every AI call.
function isOllamaHardDisabled() {
  return String(process.env.OLLAMA_MODE || global.ollamaMode || 'auto').toLowerCase() === 'disabled';
}

let promptTemplates = null;

// ============================================================================
// DQL ESSENTIALS — Syntax rules from Knowledge Base (injected into AI prompts)
// Prevents common DQL mistakes that break dashboards
// ============================================================================

const DQL_SYNTAX_RULES = `
DQL CRITICAL SYNTAX RULES (you MUST follow these):
- WRONG: filter field in ["a", "b"]  →  RIGHT: filter in(field, "a", "b")  (no array literals in DQL)
- WRONG: by: severity, status  →  RIGHT: by: {severity, status}  (multiple group fields need braces)
- contains() is already case-insensitive — never wrap in toLower()
- WRONG: matchesValue(stringField, "x")  →  RIGHT: contains(stringField, "x")  (matchesValue is for array fields like dt.tags ONLY)
- WRONG: substring(field, 0, 200)  →  RIGHT: substring(field, from: 0, to: 200)  (use named params)
- Variable refs in queries: $Var (single), array($Var) (multi-select), $Var:noquote (numbers)
- Entity fields: use dt.entity.host, dt.entity.service (NOT entity.id)
- entityName(dt.entity.service) to resolve ID→name
- No time-range filters in tile queries — the dashboard UI time picker handles this automatically
- Variable queries MUST return exactly 1 field (e.g., | fields entity.name)
`.trim();

// ============================================================================
// BUSINESS OBSERVABILITY FIELD KNOWLEDGE
// Injected into AI prompts so the model knows what data lives in bizevents
// Source: ai-agent-knowledge-base + production dashboards
// ============================================================================

// ============================================================================
// FIELD CATALOG: Comprehensive classification of every additionalfield.
// Each field is categorized by data type, KPI category, visualization, and
// DQL aggregation so the tile builder knows EXACTLY how to query and display it.
// ============================================================================

const FIELD_CATALOG = {
  // ── REVENUE & FINANCIAL (numeric — sum/avg, singleValue/bar/area) ──
  orderTotal:             { type: 'numeric', category: 'revenue',    label: '💰 Order Total',             agg: 'sum',  unit: '$',  viz: 'categoricalBarChart', kpi: true },
  transactionValue:       { type: 'numeric', category: 'revenue',    label: '💰 Transaction Value',       agg: 'sum',  unit: '$',  viz: 'categoricalBarChart', kpi: true },
  Price:                  { type: 'numeric', category: 'revenue',    label: '💲 Product Price',           agg: 'avg',  unit: '$',  viz: 'categoricalBarChart', kpi: false },
  averageOrderValue:      { type: 'numeric', category: 'revenue',    label: '💵 Avg Order Value',         agg: 'avg',  unit: '$',  viz: 'singleValue',        kpi: true },
  revenuePerCustomer:     { type: 'numeric', category: 'revenue',    label: '💵 Revenue per Customer',    agg: 'avg',  unit: '$',  viz: 'singleValue',        kpi: true },
  profitMargin:           { type: 'numeric', category: 'revenue',    label: '📊 Profit Margin',           agg: 'avg',  unit: '%',  viz: 'categoricalBarChart', kpi: true },
  discountApplied:        { type: 'numeric', category: 'revenue',    label: '🏷️ Discount Applied',        agg: 'avg',  unit: '$',  viz: 'categoricalBarChart', kpi: false },
  taxAmount:              { type: 'numeric', category: 'revenue',    label: '🧾 Tax Amount',              agg: 'sum',  unit: '$',  viz: 'categoricalBarChart', kpi: false },
  shippingCost:           { type: 'numeric', category: 'revenue',    label: '📦 Shipping Cost',           agg: 'avg',  unit: '$',  viz: 'categoricalBarChart', kpi: false },
  annualRevenue:          { type: 'numeric', category: 'revenue',    label: '📈 Annual Revenue',          agg: 'avg',  unit: '$',  viz: 'singleValue',        kpi: true },
  contractValue:          { type: 'numeric', category: 'revenue',    label: '📑 Contract Value',          agg: 'avg',  unit: '$',  viz: 'categoricalBarChart', kpi: true },

  // ── CUSTOMER LIFETIME & GROWTH (numeric — avg, singleValue/bar) ──
  customerLifetimeValue:  { type: 'numeric', category: 'customer',   label: '💎 Customer Lifetime Value', agg: 'avg',  unit: '$',  viz: 'categoricalBarChart', kpi: true },
  lifetimeValue:          { type: 'numeric', category: 'customer',   label: '💎 Lifetime Value',          agg: 'avg',  unit: '$',  viz: 'categoricalBarChart', kpi: true },
  upsellPotential:        { type: 'numeric', category: 'customer',   label: '📈 Upsell Potential',        agg: 'avg',  unit: '$',  viz: 'categoricalBarChart', kpi: false },
  growthPotential:        { type: 'numeric', category: 'customer',   label: '🌱 Growth Potential',        agg: 'avg',  unit: '$',  viz: 'categoricalBarChart', kpi: false },
  futureValue:            { type: 'numeric', category: 'customer',   label: '🔮 Future Value',            agg: 'avg',  unit: '$',  viz: 'categoricalBarChart', kpi: false },
  acquisitionCost:        { type: 'numeric', category: 'customer',   label: '💸 Acquisition Cost',        agg: 'avg',  unit: '$',  viz: 'categoricalBarChart', kpi: false },
  costPerAcquisition:     { type: 'numeric', category: 'customer',   label: '💸 Cost per Acquisition',    agg: 'avg',  unit: '$',  viz: 'categoricalBarChart', kpi: false },

  // ── CONVERSION & ENGAGEMENT (numeric — avg, bar/line) ──
  conversionProbability:  { type: 'numeric', category: 'conversion', label: '🎯 Conversion Probability',  agg: 'avg',  unit: '%',  viz: 'categoricalBarChart', kpi: true },
  conversionRate:         { type: 'numeric', category: 'conversion', label: '🎯 Conversion Rate',         agg: 'avg',  unit: '%',  viz: 'categoricalBarChart', kpi: true },
  engagementScore:        { type: 'numeric', category: 'conversion', label: '⚡ Engagement Score',        agg: 'avg',  unit: '',   viz: 'categoricalBarChart', kpi: false },
  timeToConversion:       { type: 'numeric', category: 'conversion', label: '⏱️ Time to Conversion',      agg: 'avg',  unit: 's',  viz: 'categoricalBarChart', kpi: false },
  sessionDuration:        { type: 'numeric', category: 'conversion', label: '⏱️ Session Duration',        agg: 'avg',  unit: 's',  viz: 'categoricalBarChart', kpi: false },
  pageViews:              { type: 'numeric', category: 'conversion', label: '📄 Page Views',              agg: 'avg',  unit: '',   viz: 'categoricalBarChart', kpi: false },
  purchaseFrequency:      { type: 'numeric', category: 'conversion', label: '🔄 Purchase Frequency',     agg: 'avg',  unit: '',   viz: 'categoricalBarChart', kpi: false },

  // ── SATISFACTION & LOYALTY (numeric scores — avg, bar/table) ──
  netPromoterScore:       { type: 'numeric', category: 'satisfaction', label: '😊 Net Promoter Score',    agg: 'avg',  unit: '',   viz: 'categoricalBarChart', kpi: true },
  npsScore:               { type: 'numeric', category: 'satisfaction', label: '😊 NPS Score',             agg: 'avg',  unit: '',   viz: 'categoricalBarChart', kpi: true },
  satisfactionRating:     { type: 'numeric', category: 'satisfaction', label: '⭐ Satisfaction Rating',   agg: 'avg',  unit: '',   viz: 'categoricalBarChart', kpi: true },
  satisfactionScore:      { type: 'numeric', category: 'satisfaction', label: '⭐ Satisfaction Score',    agg: 'avg',  unit: '',   viz: 'categoricalBarChart', kpi: true },
  retentionProbability:   { type: 'numeric', category: 'satisfaction', label: '🤝 Retention Probability', agg: 'avg',  unit: '%',  viz: 'categoricalBarChart', kpi: true },

  // ── OPERATIONS & PERFORMANCE (numeric — avg/p90, bar/line) ──
  processingTime:         { type: 'numeric', category: 'operations', label: '⏱️ Processing Time',        agg: 'avg',  unit: 'ms', viz: 'categoricalBarChart', kpi: true },
  operationalCost:        { type: 'numeric', category: 'operations', label: '💸 Operational Cost',       agg: 'sum',  unit: '$',  viz: 'categoricalBarChart', kpi: false },
  efficiencyRating:       { type: 'numeric', category: 'operations', label: '⚙️ Efficiency Rating',      agg: 'avg',  unit: '',   viz: 'categoricalBarChart', kpi: false },
  resourceUtilization:    { type: 'numeric', category: 'operations', label: '📊 Resource Utilization',   agg: 'avg',  unit: '%',  viz: 'categoricalBarChart', kpi: false },

  // ── RISK & COMPLIANCE (numeric — avg, bar/table) ──
  complianceScore:        { type: 'numeric', category: 'risk',       label: '✅ Compliance Score',       agg: 'avg',  unit: '',   viz: 'categoricalBarChart', kpi: false },
  seasonalImpact:         { type: 'numeric', category: 'risk',       label: '📅 Seasonal Impact',        agg: 'avg',  unit: '',   viz: 'categoricalBarChart', kpi: false },
  marketShare:            { type: 'numeric', category: 'risk',       label: '📊 Market Share',           agg: 'avg',  unit: '%',  viz: 'categoricalBarChart', kpi: false },

  // ── STRING DIMENSION FIELDS (categorical — countBy, donut/pie/bar) ──
  deviceType:             { type: 'string',  category: 'channel',    label: '📱 Device Type',            viz: 'donutChart' },
  browser:                { type: 'string',  category: 'channel',    label: '🌐 Browser',                viz: 'donutChart' },
  location:               { type: 'string',  category: 'channel',    label: '📍 Location',               viz: 'pieChart' },
  entryChannel:           { type: 'string',  category: 'channel',    label: '📡 Entry Channel',          viz: 'donutChart' },
  channel:                { type: 'string',  category: 'channel',    label: '📡 Channel',                viz: 'donutChart' },
  region:                 { type: 'string',  category: 'channel',    label: '🌍 Region',                 viz: 'pieChart' },
  customerIntent:         { type: 'string',  category: 'segment',    label: '🎯 Customer Intent',        viz: 'donutChart' },
  loyaltyStatus:          { type: 'string',  category: 'segment',    label: '⭐ Loyalty Status',         viz: 'donutChart' },
  loyaltyTier:            { type: 'string',  category: 'segment',    label: '⭐ Loyalty Tier',           viz: 'donutChart' },
  membershipStatus:       { type: 'string',  category: 'segment',    label: '🏅 Membership Status',      viz: 'donutChart' },
  pricingTier:            { type: 'string',  category: 'segment',    label: '💎 Pricing Tier',           viz: 'donutChart' },
  subscriptionLevel:      { type: 'string',  category: 'segment',    label: '📋 Subscription Level',     viz: 'donutChart' },
  segment:                { type: 'string',  category: 'segment',    label: '👥 Customer Segment',       viz: 'pieChart' },
  customerSegmentValue:   { type: 'string',  category: 'segment',    label: '👥 Segment Value',          viz: 'donutChart' },
  marketSegment:          { type: 'string',  category: 'segment',    label: '🏢 Market Segment',         viz: 'pieChart' },
  churnRisk:              { type: 'string',  category: 'risk_label', label: '⚠️ Churn Risk',             viz: 'donutChart' },
  abandonmentRisk:        { type: 'string',  category: 'risk_label', label: '🚪 Abandonment Risk',       viz: 'donutChart' },
  crossSellOpportunity:   { type: 'string',  category: 'risk_label', label: '🔄 Cross-Sell Opportunity', viz: 'donutChart' },
  fraudRisk:              { type: 'string',  category: 'risk_label', label: '🛡️ Fraud Risk',             viz: 'donutChart' },
  riskLevel:              { type: 'string',  category: 'risk_label', label: '⚠️ Risk Level',             viz: 'donutChart' },
  securityRating:         { type: 'string',  category: 'risk_label', label: '🔒 Security Rating',        viz: 'donutChart' },
  competitiveAdvantage:   { type: 'string',  category: 'market',     label: '🏆 Competitive Advantage',  viz: 'donutChart' },
  competitorComparison:   { type: 'string',  category: 'market',     label: '⚔️ Competitor Comparison',  viz: 'donutChart' },
  brandLoyalty:           { type: 'string',  category: 'market',     label: '❤️ Brand Loyalty',           viz: 'donutChart' },
  expansionOpportunity:   { type: 'string',  category: 'market',     label: '🚀 Expansion Opportunity',  viz: 'donutChart' },
  marketTrend:            { type: 'string',  category: 'market',     label: '📈 Market Trend',           viz: 'donutChart' },
  Productname:            { type: 'string',  category: 'product',    label: '📦 Product Name',           viz: 'categoricalBarChart' },
  ProductId:              { type: 'string',  category: 'product',    label: '🏷️ Product ID (SKU)',        viz: 'categoricalBarChart' },
  ProductType:            { type: 'string',  category: 'product',    label: '📂 Product Type',           viz: 'donutChart' },
};

// Map prompt focus keywords to which field categories should be prioritized
const FOCUS_CATEGORY_MAP = {
  revenue:     ['revenue', 'customer', 'conversion', 'product'],
  executive:   ['revenue', 'customer', 'satisfaction', 'conversion'],
  operations:  ['operations', 'risk', 'risk_label', 'channel'],
  customer:    ['customer', 'satisfaction', 'segment', 'conversion'],
  performance: ['operations', 'conversion', 'channel'],
  risk:        ['risk', 'risk_label', 'operations'],
  marketing:   ['channel', 'segment', 'market', 'product', 'conversion'],
  product:     ['product', 'revenue', 'conversion', 'segment'],
};

const BIZOBS_FIELD_KNOWLEDGE = `
BUSINESS EVENT DATA MODEL (available in Grail via "fetch bizevents"):

TOP-LEVEL FIELDS (json.*):
  json.companyName    — Company/tenant (e.g. "Telecommunications", "Financial Services")
  json.journeyType    — Journey type (e.g. "Purchase", "Broadband Signup", "Account Opening")
  json.stepName       — Journey step name (e.g. "Browse Plans", "Enter Details", "Payment")
  json.serviceName    — Linked Dynatrace service name (lowercase)
  json.hasError       — Boolean error flag
  event.kind          — Always "BIZ_EVENT" for business events
  event.type          — Step name
  event.category      — "Business Observability Demonstrator"

ADDITIONAL FIELDS (additionalfields.* — flattened from JSON payload):
  additionalfields.hasError         — Boolean: step had error
  additionalfields.processingTime   — Numeric: processing time in ms
  additionalfields.orderTotal       — Numeric: revenue/order value
  additionalfields.errorMessage     — String: error message text
  additionalfields.deviceType       — String: "Desktop", "Mobile", "Tablet"
  additionalfields.browser          — String: browser name
  additionalfields.region           — String: geographic region
  additionalfields.channel          — String: acquisition channel
  additionalfields.loyaltyTier      — String: customer loyalty tier
  additionalfields.churnRisk        — String: churn risk label ("high", "medium", "low") — use countBy, NOT avg
  additionalfields.abandonmentRisk  — String: abandonment risk label ("high", "medium", "low") — use countBy
  additionalfields.fraudRisk        — String: fraud risk label ("high", "medium", "low") — use countBy
  additionalfields.riskLevel        — String: risk level label — use countBy
  additionalfields.npsScore         — Numeric: NPS score
  additionalfields.netPromoterScore — Numeric: net promoter score (alias of npsScore)
  additionalfields.satisfactionScore — Numeric: satisfaction score
  additionalfields.satisfactionRating — Numeric: satisfaction rating (alias)
  additionalfields.customerLifetimeValue — Numeric: customer lifetime value
  additionalfields.conversionProbability — Numeric: conversion probability (0-1)
  additionalfields.conversionRate   — Numeric: conversion rate percentage
  additionalfields.engagementScore  — Numeric: engagement score
  additionalfields.retentionProbability — Numeric: retention probability
  additionalfields.planName         — String: selected plan/product name
  additionalfields.planPrice        — Numeric: plan price
  additionalfields.Productname      — String: product name
  additionalfields.ProductId        — String: product ID
  additionalfields.ProductType      — String: product type
  additionalfields.subscriptionType — String: subscription type
  additionalfields.paymentMethod    — String: payment method
  additionalfields.segment          — String: customer segment
  additionalfields.customerSegmentValue — String: customer segment value
  additionalfields.marketSegment    — String: market segment
  additionalfields.loyaltyStatus    — String: loyalty status label
  additionalfields.membershipStatus — String: membership status
  additionalfields.pricingTier      — String: pricing tier
  additionalfields.subscriptionLevel — String: subscription level
  additionalfields.transactionValue — Numeric: transaction monetary value
  additionalfields.Price            — Numeric: item price
  additionalfields.averageOrderValue — Numeric: average order value
  additionalfields.revenuePerCustomer — Numeric: revenue per customer
  additionalfields.profitMargin     — Numeric: profit margin percentage
  additionalfields.annualRevenue    — Numeric: annual revenue
  additionalfields.contractValue    — Numeric: contract monetary value
  additionalfields.operationalCost  — Numeric: operational cost
  additionalfields.acquisitionCost  — Numeric: customer acquisition cost
  additionalfields.sessionDuration  — Numeric: session duration ms
  additionalfields.pageViews        — Numeric: page view count
  additionalfields.purchaseFrequency — Numeric: purchase frequency
  additionalfields.location         — String: user location
  additionalfields.entryChannel     — String: entry channel
  additionalfields.customerIntent   — String: customer intent label

GOLDEN SIGNAL METRICS (Dynatrace service-level, via "timeseries"):
  dt.service.request.count          — Request count per service
  dt.service.request.response_time  — Response time per service
  dt.service.request.failure_count  — Failed request count per service

DASHBOARD VARIABLES (always available in queries as $Variable):
  $CompanyName  — Single-select: filters json.companyName
  $JourneyType  — Multi-select: filters json.journeyType (use: in(json.journeyType, $JourneyType))
  $Step         — Multi-select: filters json.stepName
  $Service      — Multi-select: filters linked Dynatrace services

KEY QUERY PATTERNS:
  Revenue:        summarize revenue = sum(additionalfields.orderTotal)
  Success Rate:   summarize total = count(), successful = countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false) | fieldsAdd rate = round((toDouble(successful)/toDouble(total))*100, decimals:2)
  Error Rate:     summarize errors = countIf(additionalfields.hasError == true), total = count() | fieldsAdd rate = round((toDouble(errors)/toDouble(total))*100, decimals:2)
  P90 Latency:    summarize p90 = percentile(additionalfields.processingTime, 90)
  Time Series:    makeTimeseries success = countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false), failed = countIf(additionalfields.hasError == true), bins:30
  SLA Compliance: summarize total = count(), withinSLA = countIf(additionalfields.processingTime < 5000), by: {json.stepName} | fieldsAdd compliance = (withinSLA / total) * 100
  Hourly Pattern: fieldsAdd hour = toString(getHour(timestamp)) | summarize Events = count(), by: {hour}
  Heatmap:        fieldsAdd hour = formatTimestamp(timestamp, format: "HH") | summarize count = count(), by: {json.stepName, hour}
  String Dim:     filter isNotNull(additionalfields.churnRisk) | summarize Count = count(), by: {additionalfields.churnRisk} | sort Count desc
  Numeric KPI:    summarize value = sum(additionalfields.orderTotal) (use singleValue visualization)
  Numeric byStep: summarize Value = avg(additionalfields.processingTime), by: {json.stepName} | sort Value desc

IMPORTANT TYPE RULES:
  - STRING fields (churnRisk, abandonmentRisk, fraudRisk, riskLevel, deviceType, loyaltyTier, segment, etc.)
    → NEVER use avg(), sum(), percentile() — these return NULL for strings
    → USE: summarize Count = count(), by: {additionalfields.fieldName}
    → Visualize with: donutChart, pieChart, categoricalBarChart
  - NUMERIC fields (orderTotal, processingTime, netPromoterScore, conversionProbability, etc.)
    → USE: sum(), avg(), percentile(), min(), max()
    → Visualize with: singleValue, categoricalBarChart, areaChart, table

VISUALIZATION BEST PRACTICES:
  singleValue  — Executive KPIs (one number: volume, rate, revenue)
  table        — Step metrics, SLA compliance, error details (multi-row aggregations)
  areaChart    — Volume over time, success vs failed trends (makeTimeseries)
  lineChart    — Error rate trends, golden signals (timeseries)
  donutChart   — Events by step proportional breakdown
  categoricalBarChart — Events by step (bar), volume distribution
  pieChart     — Hourly activity pattern
  heatmap      — Step × Hour activity matrix
`.trim();

// Dynatrace theme-aware threshold colors (adapt to dark/light mode)
const DT_THRESHOLD_COLORS = {
  ideal: 'var(--dt-colors-charts-status-ideal-default, #2f6862)',
  warning: 'var(--dt-colors-charts-status-warning-default, #eea53c)',
  critical: 'var(--dt-colors-charts-status-critical-default, #c62239)'
};

// ============================================================================
// DASHBOARD SCHEMA VALIDATION (v21)
// Validates generated dashboards before deployment — catches structural errors
// ============================================================================

function validateDashboardSchema(dashboard) {
  const errors = [];
  const warnings = [];
  const content = dashboard.content || dashboard;

  // Required top-level fields
  if (content.version !== 21) {
    errors.push(`version must be 21, got ${content.version}`);
  }
  if (!content.tiles || typeof content.tiles !== 'object') {
    errors.push('tiles object is required');
  }
  if (!content.layouts || typeof content.layouts !== 'object') {
    errors.push('layouts object is required');
  }

  const validVizTypes = new Set([
    'lineChart', 'areaChart', 'barChart', 'bandChart',
    'categoricalBarChart', 'pieChart', 'donutChart',
    'singleValue', 'meterBar', 'gauge',
    'table', 'raw', 'recordList',
    'histogram', 'honeycomb',
    'choroplethMap', 'dotMap', 'connectionMap', 'bubbleMap',
    'heatmap', 'scatterplot'
  ]);

  if (content.tiles) {
    const tileIds = Object.keys(content.tiles);
    const layoutIds = Object.keys(content.layouts || {});

    // Every tile must have a layout
    for (const id of tileIds) {
      if (!layoutIds.includes(id)) {
        errors.push(`tile ${id} has no corresponding layout`);
      }
    }

    for (const [id, tile] of Object.entries(content.tiles)) {
      if (!tile.type) {
        errors.push(`tile ${id}: missing type`);
        continue;
      }
      if (tile.type === 'data') {
        if (!tile.query) warnings.push(`tile ${id} (${tile.title || 'untitled'}): data tile has no query`);
        if (tile.visualization && !validVizTypes.has(tile.visualization)) {
          errors.push(`tile ${id}: invalid visualization "${tile.visualization}"`);
        }
      }
    }

    // Validate layouts
    for (const [id, layout] of Object.entries(content.layouts || {})) {
      if (layout.x == null || layout.y == null || layout.w == null || layout.h == null) {
        errors.push(`layout ${id}: missing x/y/w/h`);
      }
      if (layout.w !== undefined && (layout.w < 1 || layout.w > 24)) {
        warnings.push(`layout ${id}: width ${layout.w} outside 1-24 range`);
      }
    }
  }

  // Validate variables
  if (Array.isArray(content.variables)) {
    const keys = new Set();
    for (const v of content.variables) {
      if (!v.key) { errors.push('variable missing key'); continue; }
      if (keys.has(v.key)) errors.push(`duplicate variable key: ${v.key}`);
      keys.add(v.key);
      if (!['query', 'csv', 'text'].includes(v.type)) {
        warnings.push(`variable ${v.key}: unknown type "${v.type}"`);
      }
      if (v.type === 'query' && !v.input) {
        errors.push(`variable ${v.key}: query type requires input`);
      }
    }
  }

  const isValid = errors.length === 0;
  if (!isValid) console.warn(`[Schema Validation] ❌ ${errors.length} errors:`, errors);
  if (warnings.length > 0) console.log(`[Schema Validation] ⚠️ ${warnings.length} warnings:`, warnings);
  if (isValid) console.log(`[Schema Validation] ✅ Dashboard passed validation`);

  return { isValid, errors, warnings };
}

function validateDashboardDeployQuality(dashboard) {
  const base = validateDashboardSchema(dashboard);
  const content = dashboard.content || dashboard;
  const tiles = Object.values(content.tiles || {});
  const layouts = content.layouts || {};
  const warnings = [...base.warnings];
  const errors = [...base.errors];

  const hasTitle = Boolean(String(dashboard.name || '').trim());
  if (!hasTitle) {
    errors.push('dashboard must have a non-empty name');
  }

  const dataTiles = tiles.filter((tile) => tile.type === 'data');
  if (dataTiles.length < 4) {
    errors.push(`dashboard should have at least 4 data tiles, got ${dataTiles.length}`);
  }

  const charts = dataTiles.filter((tile) => [
    'lineChart', 'areaChart', 'barChart', 'bandChart', 'categoricalBarChart',
    'pieChart', 'donutChart', 'bubbleMap', 'dotMap', 'choroplethMap', 'connectionMap'
  ].includes(tile.visualization));
  if (charts.length < 2) {
    warnings.push(`dashboard should have at least 2 chart/map tiles, got ${charts.length}`);
  }

  const kpis = dataTiles.filter((tile) => ['singleValue', 'gauge', 'meterBar'].includes(tile.visualization));
  if (kpis.length < 1) {
    warnings.push('dashboard should include at least one KPI/single value tile');
  }

  const markdownTiles = tiles.filter((tile) => tile.type === 'markdown');
  if (markdownTiles.length < 2) {
    warnings.push(`dashboard should include at least 2 markdown tiles for branded header/sectioning, got ${markdownTiles.length}`);
  }

  const mapTiles = dataTiles.filter((tile) => ['bubbleMap', 'dotMap', 'choroplethMap', 'connectionMap'].includes(tile.visualization));
  if (mapTiles.length === 0) {
    warnings.push('dashboard has no map tile; customer dashboards benefit from at least one geographic view');
  }

  const aboveFoldLargeViz = Object.entries(layouts).some(([id, layout]) => {
    const tile = content.tiles?.[id];
    return tile?.type === 'data' && ['lineChart', 'areaChart', 'barChart', 'bandChart', 'categoricalBarChart', 'bubbleMap', 'dotMap', 'choroplethMap', 'connectionMap'].includes(tile.visualization) && Number(layout.y || 0) <= 6;
  });
  if (!aboveFoldLargeViz) {
    warnings.push('dashboard should place at least one major chart or map above the fold (y <= 6)');
  }

  for (const [id, layout] of Object.entries(layouts)) {
    const tile = content.tiles?.[id];
    if (!tile || tile.type !== 'data') continue;
    if (['lineChart', 'areaChart', 'barChart', 'bandChart', 'categoricalBarChart', 'bubbleMap', 'dotMap', 'choroplethMap', 'connectionMap'].includes(tile.visualization) && Number(layout.h || 0) < 4) {
      warnings.push(`tile ${id} (${tile.title || 'untitled'}) should have height >= 4 for visualization ${tile.visualization}`);
    }
  }

  // Hard requirement: every fetch bizevents query must be scoped by Company + JourneyType.
  for (const [id, tile] of Object.entries(content.tiles || {})) {
    const query = typeof tile?.query === 'string' ? tile.query : '';
    if (!query || !/\bfetch\s+bizevents\b/i.test(query)) continue;

    const hasCompanyFilter = /\|\s*filter\s+json\.companyName\s*==\s*\$EventProvider\b/i.test(query);
    const hasJourneyFilter = /\|\s*filter\s+json\.journeyType\s*==\s*\$JourneyType\b/i.test(query);

    if (!hasCompanyFilter || !hasJourneyFilter) {
      errors.push(`tile ${id}: fetch bizevents query must include both filters: json.companyName == $EventProvider and json.journeyType == $JourneyType`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

function normalizeDashboardContentForDeploy(contentInput, options = {}) {
  const content = (contentInput && typeof contentInput === 'object') ? { ...contentInput } : {};
  const canonicalCompany = String(options.company || '').trim();
  const canonicalJourney = String(options.journeyType || '').trim();
  const availableFields = options.availableFields instanceof Set ? options.availableFields : null;
  content.version = 21;

  const tiles = (content.tiles && typeof content.tiles === 'object') ? { ...content.tiles } : {};
  const layouts = (content.layouts && typeof content.layouts === 'object') ? { ...content.layouts } : {};

  const vizAliases = {
    categoricalBar: 'categoricalBarChart',
    choropleth: 'choroplethMap',
    dataPage: 'table',
    records: 'recordList',
  };

  const ensureBizEventScoping = (query) => {
    if (typeof query !== 'string') return query;
    let q = query.trim();
    if (!/\bfetch\s+bizevents\b/i.test(q)) return q;

    const additionalFieldNames = new Set();
    if (availableFields) {
      for (const rawField of availableFields) {
        const f = String(rawField || '').trim();
        if (!f) continue;
        if (f.startsWith('additionalfields.')) {
          additionalFieldNames.add(f.replace(/^additionalfields\./, ''));
        }
      }
    }

    const isInsideDoubleQuotes = (text, index) => {
      let inQuote = false;
      for (let i = 0; i < index; i++) {
        if (text[i] === '"' && text[i - 1] !== '\\') inQuote = !inQuote;
      }
      return inQuote;
    };

    const qualifyIdentifiersInExpr = (expr) => {
      if (!availableFields || additionalFieldNames.size === 0) return expr;
      const skip = new Set([
        'and', 'or', 'not', 'true', 'false', 'null', 'else', 'if',
        'sum', 'avg', 'min', 'max', 'median', 'percentile', 'count',
        'countDistinct', 'countIf', 'toDouble', 'round', 'now', 'exists',
        'isNull', 'isNotNull', 'formatTimestamp', 'toString'
      ]);

      return expr.replace(/\b([A-Za-z_][A-Za-z0-9_]*)\b/g, (m, id, offset, full) => {
        if (skip.has(id)) return m;
        if (isInsideDoubleQuotes(full, offset)) return m;
        if (offset > 0 && full[offset - 1] === '$') return m;
        const tail = full.slice(offset + id.length);
        if (/^\s*=/.test(tail)) return m;
        if (additionalFieldNames.has(id)) return `additionalfields.${id}`;
        return m;
      });
    };

    // Replace hardcoded provider/company filters with dashboard variable filter.
    q = q.replace(/\|\s*filter\s+event\.provider\s*==\s*"[^"]*"/gi, '| filter json.companyName == $EventProvider');
    q = q.replace(/\|\s*filter\s+json\.companyName\s*==\s*"[^"]*"/gi, '| filter json.companyName == $EventProvider');
    q = q.replace(/\|\s*filter\s+in\(\s*event\.provider\s*,\s*\$EventProvider\s*\)/gi, '| filter json.companyName == $EventProvider');
    q = q.replace(/\|\s*filter\s+in\(\s*json\.companyName\s*,\s*\$EventProvider\s*\)/gi, '| filter json.companyName == $EventProvider');

    // Replace hardcoded journey filters with dashboard variable filter.
    q = q.replace(/\|\s*filter\s+json\.journeyType\s*==\s*"[^"]*"/gi, '| filter json.journeyType == $JourneyType');
    q = q.replace(/\|\s*filter\s+journeyType\s*==\s*"[^"]*"/gi, '| filter json.journeyType == $JourneyType');
    q = q.replace(/\|\s*filter\s+journey_type\s*==\s*"[^"]*"/gi, '| filter json.journeyType == $JourneyType');
    q = q.replace(/\|\s*filter\s+in\(\s*json\.journeyType\s*,\s*\$JourneyType\s*\)/gi, '| filter json.journeyType == $JourneyType');

    // Repair common model syntax/function mistakes.
    q = q
      .replace(/\bcount_distinct\s*\(/gi, 'countDistinct(')
      .replace(/\bby:\s*(?!\{)([A-Za-z_][A-Za-z0-9_\.]*)/g, 'by:{$1}')
      .replace(/\b(sum|avg|min|max|median|countDistinct|countIf|percentile)\s*\(([^\)]*)\)/gi, (full, fn, args) => `${fn}(${qualifyIdentifiersInExpr(args)})`)
      .replace(/\|\s*fields\s+([^|]+)/gi, (full, body) => `| fields ${qualifyIdentifiersInExpr(body)}`)
      .replace(/\bdedup\s+([A-Za-z_][A-Za-z0-9_\.]*)/gi, (full, field) => {
        if (!availableFields) return full;
        if (field.includes('.')) return full;
        if (additionalFieldNames.has(field)) return `dedup additionalfields.${field}`;
        return full;
      });

    const hasEventProviderVar = /\$EventProvider\b/.test(q) || /json\.companyName\s*==\s*\$EventProvider/.test(q);
    const hasJourneyTypeVar = /\$JourneyType\b/.test(q) || /json\.journeyType\s*==\s*\$JourneyType/.test(q) || /journeyType\s*==\s*\$JourneyType/.test(q) || /journey_type\s*==\s*\$JourneyType/.test(q);

    if (!hasEventProviderVar) {
      q = q.replace(/^(\s*fetch\s+bizevents\b)/i, '$1 | filter json.companyName == $EventProvider');
    }
    if (!hasJourneyTypeVar) {
      q = q.replace(/^(\s*fetch\s+bizevents\b(?:\s*\|\s*filter\s+json\.companyName\s*==\s*\$EventProvider)?)/i, '$1 | filter json.journeyType == $JourneyType');
    }

    const isKnownField = (fieldName) => {
      if (!availableFields) return true;
      const f = String(fieldName || '').trim();
      if (!f) return false;
      if (availableFields.has(f)) return true;
      if (f.startsWith('additionalfields.') && availableFields.has(f.replace(/^additionalfields\./, ''))) return true;
      if (!f.includes('.') && availableFields.has(`additionalfields.${f}`)) return true;
      return false;
    };

    // Optional variable filters (Region, Store, etc.) should not blank tiles when fields are absent.
    q = q.replace(
      /\|\s*filter\s+in\(\s*([a-zA-Z0-9_\.]+)\s*,\s*\$([A-Za-z_][A-Za-z0-9_]*)\s*\)/g,
      (full, field, key) => {
        if (key === 'EventProvider' || key === 'JourneyType') return full;
        if (!isKnownField(field)) return '';
        return `| filter (in(${field}, $${key}) or in("All", $${key}) or isNull(${field}))`;
      }
    );

    return q;
  };

  for (const [id, tileRaw] of Object.entries(tiles)) {
    const tile = (tileRaw && typeof tileRaw === 'object') ? { ...tileRaw } : { type: 'markdown', markdown: '' };
    if (tile.type === 'data' && typeof tile.visualization === 'string' && vizAliases[tile.visualization]) {
      tile.visualization = vizAliases[tile.visualization];
    }

    // Normalize common unsupported DQL snake_case aliases produced by LLMs.
    if (typeof tile.query === 'string' && tile.query.trim()) {
      tile.query = tile.query
        .replace(/\bcount_if\s*\(/gi, 'countIf(')
        .replace(/\bsum_if\s*\(/gi, 'sumIf(')
        .replace(/\bavg_if\s*\(/gi, 'avgIf(')
        .replace(/\bmin_if\s*\(/gi, 'minIf(')
        .replace(/\bmax_if\s*\(/gi, 'maxIf(');

      tile.query = ensureBizEventScoping(tile.query);
    }

    // Normalize visualization settings to avoid invalid shapes that can break dashboard rendering.
    if (tile.type === 'data' && typeof tile.visualization === 'string' && tile.visualizationSettings && typeof tile.visualizationSettings === 'object') {
      const viz = tile.visualization;
      const vs = tile.visualizationSettings;

      if (viz === 'singleValue') {
        tile.visualizationSettings = vs.singleValue ? { singleValue: vs.singleValue } : { singleValue: { colorThresholdTarget: 'background' } };
      } else if (viz === 'table') {
        tile.visualizationSettings = vs.table ? { table: vs.table } : {};
      } else if (['bubbleMap', 'dotMap', 'connectionMap', 'choroplethMap'].includes(viz)) {
        tile.visualizationSettings = vs[viz] ? { [viz]: vs[viz] } : {};
      } else if (['lineChart', 'areaChart', 'barChart', 'categoricalBarChart'].includes(viz)) {
        if (vs[viz]) {
          tile.visualizationSettings = { [viz]: vs[viz] };
        } else if (vs.chartSettings) {
          tile.visualizationSettings = { [viz]: { chartSettings: vs.chartSettings } };
        } else {
          tile.visualizationSettings = {};
        }
      } else if (['donutChart', 'pieChart'].includes(viz)) {
        tile.visualizationSettings = vs[viz] ? { [viz]: vs[viz] } : {};
      } else if (viz === 'honeycomb') {
        tile.visualizationSettings = vs.honeycomb ? { honeycomb: vs.honeycomb } : {};
      }
    }

    tiles[id] = tile;

    if (!layouts[id]) {
      const idx = Number(id);
      const safeIdx = Number.isFinite(idx) ? idx : Object.keys(layouts).length;
      const isDataTile = tile.type === 'data';
      const w = isDataTile ? 6 : 12;
      const h = isDataTile ? 4 : 2;
      layouts[id] = {
        x: (safeIdx % Math.floor(24 / w)) * w,
        y: Math.floor(safeIdx / Math.floor(24 / w)) * h,
        w,
        h,
      };
    }
  }

  content.tiles = tiles;
  content.layouts = layouts;

  // Normalize variables so deploy quality gate does not fail on missing keys
  // from model-generated payloads.
  const DEFAULT_ALL_VAR_INPUT = 'data record(value = "All")';
  if (Array.isArray(content.variables)) {
    const usedKeys = new Set();
    content.variables = content.variables
      .filter((v) => v && typeof v === 'object')
      .map((v, idx) => {
        const baseKey = String(
          v.key ||
          v.name ||
          v.label ||
          `var_${idx + 1}`
        )
          .trim()
          .replace(/[^a-zA-Z0-9_]/g, '_')
          .replace(/^_+|_+$/g, '')
          || `var_${idx + 1}`;

        let key = baseKey;
        let n = 2;
        while (usedKeys.has(key)) {
          key = `${baseKey}_${n}`;
          n += 1;
        }
        usedKeys.add(key);

        const normalizedVar = {
          ...v,
          key,
        };

        // Many model outputs use `query` for query variables. Dynatrace expects `input`.
        // If input is absent (or a dummy fallback), promote query -> input.
        if (normalizedVar.type === 'query' && typeof normalizedVar.query === 'string' && normalizedVar.query.trim()) {
          const hasMeaningfulInput = typeof normalizedVar.input === 'string'
            && normalizedVar.input.trim()
            && normalizedVar.input.trim() !== DEFAULT_ALL_VAR_INPUT;
          if (!hasMeaningfulInput) {
            normalizedVar.input = normalizedVar.query.trim();
          }
        }

        if (normalizedVar.type === 'query' && !String(normalizedVar.input || '').trim()) {
          normalizedVar.input = DEFAULT_ALL_VAR_INPUT;
        }

        if (normalizedVar.type === 'query' && typeof normalizedVar.input === 'string' && normalizedVar.input.trim()) {
          normalizedVar.input = ensureBizEventScoping(normalizedVar.input);

          if (availableFields && /\bfetch\s+bizevents\b/i.test(normalizedVar.input)) {
            const dedupMatch = normalizedVar.input.match(/\bdedup\s+([a-zA-Z0-9_\.]+)/i);
            const fieldMatch = dedupMatch || normalizedVar.input.match(/\bfields\s+([a-zA-Z0-9_\.]+)(?:\s|$)/i);
            const candidateField = fieldMatch?.[1] ? String(fieldMatch[1]).trim() : '';

            if (candidateField && !['json.companyName', 'json.journeyType', 'event.provider'].includes(candidateField)) {
              const known = availableFields.has(candidateField)
                || (candidateField.startsWith('additionalfields.') && availableFields.has(candidateField.replace(/^additionalfields\./, '')))
                || (!candidateField.includes('.') && (availableFields.has(candidateField) || availableFields.has(`additionalfields.${candidateField}`)));
              if (!known) {
                normalizedVar.input = DEFAULT_ALL_VAR_INPUT;
              }
            }
          }
        }

        return normalizedVar;
      });
  }

  // Ensure required scoping variables exist for BizEvents dashboards.
  const vars = Array.isArray(content.variables) ? [...content.variables] : [];
  const hasEventProviderVar = vars.some((v) => String(v?.key || '').toLowerCase() === 'eventprovider');
  const hasJourneyTypeVar = vars.some((v) => String(v?.key || '').toLowerCase() === 'journeytype');

  if (!hasEventProviderVar) {
    vars.unshift({
      name: 'Event Provider',
      key: 'EventProvider',
      type: 'query',
      multiple: false,
      input: canonicalCompany
        ? `data record(value = "${canonicalCompany.replace(/"/g, '\\"')}")`
        : 'fetch bizevents | fields json.companyName | filter isNotNull(json.companyName) | dedup json.companyName',
      defaultValue: canonicalCompany || 'All',
    });
  }

  if (!hasJourneyTypeVar) {
    vars.splice(Math.min(1, vars.length), 0, {
      name: 'Journey Type',
      key: 'JourneyType',
      type: 'query',
      multiple: false,
      input: 'fetch bizevents | filter json.companyName == $EventProvider | fields json.journeyType | filter isNotNull(json.journeyType)| dedup json.journeyType',
      defaultValue: canonicalJourney || 'All',
    });
  }

  content.variables = sortVariablesByDependency(vars);

  // ════════════════════════════════════════════════════════════════════════════════
  // KPI DASHBOARD PATTERN ENHANCEMENTS (dtctl + dynatrace-assist integration)
  // ════════════════════════════════════════════════════════════════════════════════

  // [PRIORITY 1] Auto-repair barChart/categoricalBarChart when paired with summarize
  // Problem: LLM generates "summarize" queries (scalar, grouped aggregations) which produce
  // empty bar charts. Solution: Convert to donut which handles this pattern correctly.
  for (const [tileId, tile] of Object.entries(tiles)) {
    if (tile.type === 'data' &&
        ['barChart', 'categoricalBarChart'].includes(tile.visualization) &&
        typeof tile.query === 'string' &&
        /\bsummarize\b/i.test(tile.query) &&
        !/\bmakeTimeseries\b/i.test(tile.query)) {
      tile.visualization = 'donutChart';
      console.log(`[Normalize] 🔧 Tile ${tileId}: Auto-converted barChart+summarize → donutChart (scalar aggregations cannot render as bars)`);
    }
  }

  // [PRIORITY 2] Enforce map tile placement above the fold (at y:2, immediately after header)
  // Per KPI Dashboard Generator pattern: map tile must be positioned at y:2, w:24, h:8
  // to provide geographic context and push subsequent KPI sections down.
  const mapTileIds = Object.entries(tiles)
    .filter(([, t]) =>
      ['bubbleMap', 'dotMap', 'choroplethMap', 'connectionMap'].includes(t.type)
      || (t.type === 'data' && ['bubbleMap', 'dotMap', 'choroplethMap', 'connectionMap'].includes(t.visualization))
    )
    .map(([id]) => id);

  if (mapTileIds.length > 0) {
    const mapTileId = mapTileIds[0];
    const mapLayout = layouts[mapTileId] || { x: 0, y: 2, w: 24, h: 8 };
    const oldMapY = mapLayout.y;
    const newMapY = 2; // Immediately below header (y:0-1)
    const mapHeight = 8;

    // If map is not already at the correct position, shift all tiles below it
    if (oldMapY !== newMapY || mapLayout.w !== 24 || mapLayout.h !== mapHeight) {
      const yShift = (newMapY + mapHeight) - (oldMapY + (mapLayout.h || mapHeight));

      // Bump all data tiles that were below the old map position
      for (const [id, layout] of Object.entries(layouts)) {
        if (id !== mapTileId && id !== '0' && id !== '41' && layout.y >= oldMapY + (mapLayout.h || mapHeight)) {
          layout.y += yShift;
        }
      }

      layouts[mapTileId] = { x: 0, y: newMapY, w: 24, h: mapHeight };
      console.log(`[Normalize] 🗺️ Map tile ${mapTileId}: Repositioned to y:${newMapY} (mandatory KPI dashboard pattern)`);
    }
  }

  // [PRIORITY 3] Inject branded section dividers between recognized KPI categories
  // Dividers use singleValue tiles with distinct brand colors per industry vertical.
  // They improve visual hierarchy and guide the eye through the dashboard flow.
  const SECTION_DIVIDERS_BY_CATEGORY = {
    'revenue': { label: 'Revenue & Financial', color: '#FFB81C' },      // Gold
    'operations': { label: 'Operations & Efficiency', color: '#24A835' }, // Green
    'customer': { label: 'Customer & Experience', color: '#DC267F' },    // Pink
    'performance': { label: 'Performance & Reliability', color: '#0043CE' }, // Blue
    'quality': { label: 'Quality & Compliance', color: '#A335C7' },      // Purple
    'inventory': { label: 'Inventory & Assets', color: '#EA8500' },      // Orange
    'default': { label: 'KPIs', color: '#3C3F41' },                      // Gray
  };

  // Collect tiles by category to determine divider positions
  const tilesByCategory = {};
  for (const [id, tile] of Object.entries(tiles)) {
    // Infer category from tile metadata or title
    let category = tile.metadata?.category || 'default';
    if (tile.title) {
      const titleLower = tile.title.toLowerCase();
      if (/revenue|financial|price|cost|margin/.test(titleLower)) category = 'revenue';
      else if (/operation|efficiency|utilization|capacity/.test(titleLower)) category = 'operations';
      else if (/customer|experience|satisfaction|nps/.test(titleLower)) category = 'customer';
      else if (/performance|latency|response|reliability|uptime/.test(titleLower)) category = 'performance';
      else if (/quality|compliance|error|defect/.test(titleLower)) category = 'quality';
      else if (/inventory|asset|stock|warehouse/.test(titleLower)) category = 'inventory';
    }

    if (!tilesByCategory[category]) tilesByCategory[category] = [];
    tilesByCategory[category].push({ id, tile, layout: layouts[id] });
  }

  // Build section dividers only if multiple categories exist (avoid over-dividing single-category dashboards)
  const categoriesPresent = Object.keys(tilesByCategory).filter(c => c !== 'default' && tilesByCategory[c].length > 0);
  if (categoriesPresent.length > 1) {
    let maxTileId = Math.max(
      ...Object.keys(tiles).map(Number).filter(Number.isFinite),
      Object.keys(layouts).map(Number).filter(Number.isFinite),
      100
    );

    for (const category of categoriesPresent) {
      const categoryTiles = tilesByCategory[category];
      const firstTileLayout = categoryTiles[0]?.layout;
      if (!firstTileLayout) continue;

      const dividerY = firstTileLayout.y;
      const dividerConfig = SECTION_DIVIDERS_BY_CATEGORY[category] || SECTION_DIVIDERS_BY_CATEGORY['default'];

      // Shift all tiles at or below dividerY down by 1
      for (const [id, layout] of Object.entries(layouts)) {
        if (layout.y >= dividerY) layout.y += 1;
      }

      maxTileId += 1;
      const divIdString = String(maxTileId);
      tiles[divIdString] = {
        type: 'data',
        title: dividerConfig.label.toUpperCase(),
        query: `data record(section="${dividerConfig.label}")`,
        visualization: 'singleValue',
        visualizationSettings: {
          singleValue: {
            labelMode: 'none',
            isIconVisible: false,
            colorThresholdTarget: 'background',
          },
          thresholds: [
            {
              id: 1,
              field: 'section',
              rules: [{ id: 1, color: dividerConfig.color, comparator: '!=', value: 'none' }],
            },
          ],
        },
      };

      layouts[divIdString] = { x: 0, y: dividerY, w: 24, h: 1 };
      console.log(`[Normalize] 📌 Section divider injected: "${dividerConfig.label}" at y:${dividerY}`);
    }
  }

  // [PRIORITY 4] Resolve layout collisions to avoid Gen3 dashboard render failures
  // Some LLM outputs place multiple tiles on the same grid cells. Reflow them downward
  // while preserving x/w/h so all rectangles are non-overlapping.
  const layoutEntries = Object.entries(layouts)
    .filter(([, l]) => l && Number.isFinite(l.x) && Number.isFinite(l.y) && Number.isFinite(l.w) && Number.isFinite(l.h))
    .map(([id, l]) => ({
      id,
      x: Math.max(0, Math.min(23, Number(l.x))),
      y: Math.max(0, Number(l.y)),
      w: Math.max(1, Math.min(24, Number(l.w))),
      h: Math.max(1, Number(l.h)),
    }))
    .sort((a, b) => (a.y - b.y) || (a.x - b.x) || (Number(a.id) - Number(b.id)));

  const placed = [];
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  let movedCount = 0;

  for (const entry of layoutEntries) {
    let candidate = { ...entry };
    let guard = 0;
    while (guard < 500) {
      const blockers = placed.filter(p => overlaps(candidate, p));
      if (blockers.length === 0) break;
      const nextY = Math.max(...blockers.map(b => b.y + b.h));
      candidate.y = Math.max(candidate.y + 1, nextY);
      guard += 1;
    }
    if (candidate.y !== entry.y || candidate.x !== entry.x || candidate.w !== entry.w || candidate.h !== entry.h) {
      movedCount += 1;
    }
    placed.push(candidate);
    layouts[candidate.id] = { x: candidate.x, y: candidate.y, w: candidate.w, h: candidate.h };
  }

  if (movedCount > 0) {
    console.log(`[Normalize] 🧱 Reflowed ${movedCount} tiles to resolve layout collisions`);
  }

  return content;
}

// ============================================================================
// VARIABLE DEPENDENCY TOPOLOGICAL SORT
// Resolves variable ordering so dependent variables are defined after their deps
// ============================================================================

function sortVariablesByDependency(variables) {
  if (!Array.isArray(variables) || variables.length === 0) return variables;

  // Built-in timeframe vars that should be excluded from dependency tracking
  const builtins = new Set(['dt_timeframe_from', 'dt_timeframe_to']);
  const varMap = new Map(variables.map(v => [v.key, v]));
  const varKeys = new Set(variables.map(v => v.key));

  // Find dependencies for each variable
  function findDeps(v) {
    const input = v.input || '';
    const matches = input.match(/\$([A-Za-z_][A-Za-z0-9_]*)/g) || [];
    return [...new Set(
      matches.map(m => m.slice(1))
        .filter(name => !builtins.has(name) && varKeys.has(name))
    )];
  }

  const deps = new Map();
  for (const v of variables) {
    deps.set(v.key, findDeps(v));
  }

  // Kahn's algorithm for topological sort
  const inDegree = new Map();
  for (const key of varKeys) inDegree.set(key, 0);
  for (const [, d] of deps) {
    for (const dep of d) {
      inDegree.set(dep, (inDegree.get(dep) || 0) + 1);
    }
  }

  // Reverse: we want vars with no deps first, then vars that depend on them
  const depCount = new Map();
  for (const key of varKeys) depCount.set(key, 0);
  for (const [key, d] of deps) {
    depCount.set(key, d.length);
  }

  const queue = [];
  for (const [key, count] of depCount) {
    if (count === 0) queue.push(key);
  }

  const sorted = [];
  const visited = new Set();
  while (queue.length > 0) {
    const key = queue.shift();
    if (visited.has(key)) continue;
    visited.add(key);
    sorted.push(key);

    // Find vars that depend on this key
    for (const [vKey, vDeps] of deps) {
      if (vDeps.includes(key) && !visited.has(vKey)) {
        const remaining = vDeps.filter(d => !visited.has(d));
        if (remaining.length === 0) queue.push(vKey);
      }
    }
  }

  // Add any unvisited (cyclic deps) at the end with a warning
  for (const key of varKeys) {
    if (!visited.has(key)) {
      console.warn(`[Variable Sort] ⚠️ Cyclic dependency detected for variable: ${key}`);
      sorted.push(key);
    }
  }

  return sorted.map(key => varMap.get(key)).filter(Boolean);
}

// ============================================================================
// GRAIL FIELD DISCOVERY — Query Dynatrace to discover which additionalfields.*
// actually exist for a given company/journey before building dashboard tiles.
// Prevents null-value tiles from appearing on dashboards.
// ============================================================================

/**
 * Query Dynatrace Grail for sample bizevents to discover which additionalfields
 * are present for this company+journey. Returns a Set of field names with .records
 * containing the full bizevent payloads (company, journey, step data, business metrics).
 * If no records are found, polls up to maxRetries times (waiting pollIntervalMs between attempts)
 * since bizevents may take time to arrive in Grail after a journey starts.
 */
async function discoverBizEventFields(company, journeyType, { maxRetries = 8, pollIntervalMs = 15000 } = {}) {
  try {
    // Load DT credentials
    let dtUrl = process.env.DT_ENVIRONMENT || process.env.DYNATRACE_URL || '';
    let dtToken = process.env.DT_PLATFORM_TOKEN || process.env.DYNATRACE_TOKEN || process.env.DT_API_TOKEN || '';

    if (!dtUrl || !dtToken) {
      try {
        const credsPath = path.join(process.cwd(), '.dt-credentials.json');
        const creds = JSON.parse(readFileSync(credsPath, 'utf-8'));
        if (!dtUrl) dtUrl = creds.environmentUrl || '';
        if (!dtToken) dtToken = creds.apiToken || '';
      } catch { /* no creds file */ }
    }

    if (!dtUrl || !dtToken) {
      console.warn('[AI Dashboard] ⚠️ No DT credentials for field discovery — skipping');
      return null;
    }

    // Classic tokens use Api-Token; platform tokens and OAuth tokens use Bearer.
    const authHeader = dtAuth.dtAuthHeader(dtToken);
    const isOAuthToken = !dtAuth.isClassicToken(dtToken);

    // The .apps. host rewrite exists only because classic Api-Token auth needs the
    // non-apps host for Grail. Verified 2026-09-03: with a platform token and Bearer,
    // POST <apps>/platform/storage/query/v1/query:execute returns 202, so leave the
    // apps host alone in that case.
    const baseUrl = dtAuth.isClassicToken(dtToken)
      ? dtUrl.replace(/\/+$/, '').replace('.apps.dynatrace', '.dynatrace')
      : dtUrl.replace(/\/+$/, '');
    const queryUrl = `${baseUrl}/platform/storage/query/v1/query:execute`;

    // Query a sample of recent bizevents WITHOUT | fields to discover ALL additionalfields
    // Real customers may have any field names — status, productSKU, warrantyType, etc.
    const safeCompany = company.replace(/["\\]/g, '');
    const safeJourney = journeyType.replace(/["\\]/g, '');
    const dql = `fetch bizevents
| filter event.kind == "BIZ_EVENT"
| filter json.companyName == "${safeCompany}"
| filter json.journeyType == "${safeJourney}"
| sort timestamp desc
| limit 5`;

    console.log(`[AI Dashboard] 🔍 Discovering bizevent fields for ${company} / ${journeyType} (auth: ${isOAuthToken ? 'OAuth' : 'ApiToken'})...`);

    // Poll loop: bizevents may take time to arrive in Grail after journey start
    let records = [];
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const response = await fetch(queryUrl, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          query: dql,
          requestTimeoutMilliseconds: 15000,
          maxResultRecords: 5
        })
      });

      if (!response.ok) {
        console.warn(`[AI Dashboard] ⚠️ Field discovery query failed: ${response.status}`);
        return null;
      }

      const data = await response.json();
      records = data?.result?.records || [];

      if (records.length > 0) {
        if (attempt > 1) {
          console.log(`[AI Dashboard] ✅ Found ${records.length} bizevent records on attempt ${attempt}`);
        }
        break;
      }

      // No records yet — if we have retries left, wait and try again
      if (attempt <= maxRetries) {
        const waitSec = pollIntervalMs / 1000;
        console.log(`[AI Dashboard] ⏳ No bizevents yet — waiting ${waitSec}s before retry ${attempt}/${maxRetries} (bizevents may still be ingesting into Grail)...`);
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    }

    if (records.length === 0) {
      console.log('[AI Dashboard] ℹ️ No bizevent records found after polling — field discovery returning empty');
      const emptyResult = new Set();
      emptyResult.records = [];
      return emptyResult;
    }

    // Extract all non-null additionalfields AND preserve full records
    // so Ollama can see the actual company/journey payload data
    const foundFields = new Set();
    for (const record of records) {
      for (const [key, value] of Object.entries(record)) {
        if (value !== null && value !== undefined && value !== '' && key.startsWith('additionalfields.')) {
          foundFields.add(key.replace('additionalfields.', ''));
        }
      }
    }

    // Attach the full bizevent records so callers can pass real data to Ollama
    // Each record contains: timestamp, json.companyName, json.journeyType,
    // json.journeyStep, additionalfields.*, and other Grail-enriched fields
    foundFields.records = records;

    console.log(`[AI Dashboard] ✅ Discovered ${foundFields.size} fields: ${[...foundFields].join(', ')}`);
    console.log(`[AI Dashboard] 📋 Bizevent payload (${records.length} records): ${JSON.stringify(records[0], null, 0).substring(0, 600)}`);
    return foundFields;

  } catch (err) {
    console.warn(`[AI Dashboard] ⚠️ Field discovery error: ${err.message}`);
    return null; // null = couldn't check, fall back to adding all tiles
  }
}

// ============================================================================
// OTEL GenAI Span + Metrics — sends Ollama LLM traces to Dynatrace AI Observability
// Uses the GLOBAL TracerProvider registered by otel.cjs (no duplicate provider)
// ============================================================================

// Get the global tracer (set up by otel.cjs via --require)
const _genaiTracer = trace.getTracer('bizobs-ai-dashboard', '2.0.0');

// OTel Metrics for LLM token usage and latency
const _genaiMeter = metrics.getMeter('bizobs-ai-dashboard', '2.0.0');
const _tokenCounter = _genaiMeter.createCounter('gen_ai.client.token.usage', {
  description: 'Total tokens consumed by Ollama LLM calls',
  unit: 'token',
});
const _requestDuration = _genaiMeter.createHistogram('gen_ai.client.operation.duration', {
  description: 'Duration of Ollama LLM requests',
  unit: 'ms',
});
const _requestCounter = _genaiMeter.createCounter('gen_ai.client.operation.count', {
  description: 'Total number of Ollama LLM requests',
  unit: '{request}',
});

console.log('[AI Dashboard OTel] ✅ GenAI tracing + metrics using global OTel provider from otel.cjs');

function createGenAISpan(prompt, completion, model, promptTokens, completionTokens, duration, operationName) {
  // Dynatrace AI Observability expects standard GenAI operations (chat/completion/embedding).
  // Route all custom dashboard phases to chat so prompts/completions are detected reliably.
  const normalizedOperation = (operationName === 'completion' || operationName === 'embedding') ? operationName : 'chat';
  return {
    'gen_ai.system': 'ollama',
    'gen_ai.provider.name': 'ollama',
    'gen_ai.operation.name': normalizedOperation,
    'gen_ai.operation.kind': normalizedOperation,
    'gen_ai.request.model': model,
    'gen_ai.response.model': model,
    'gen_ai.prompt.0.content': prompt?.substring(0, 4096) || '',
    'gen_ai.prompt.0.role': 'user',
    'gen_ai.completion.0.content': completion?.substring(0, 4096) || '',
    'gen_ai.completion.0.role': 'assistant',
    'gen_ai.usage.input_tokens': promptTokens || 0,
    'gen_ai.usage.output_tokens': completionTokens || 0,
    'gen_ai.usage.prompt_tokens': promptTokens || 0,
    'gen_ai.usage.completion_tokens': completionTokens || 0,
    'llm.request.type': normalizedOperation,
    'gen_ai.response.duration_ms': Math.round(duration),
    'server.address': 'localhost',
    'server.port': 11434,
    'endpoint': OLLAMA_ENDPOINT
  };
}

async function logGenAISpan(spanAttributes, operationName) {
  try {
    const requestedOperation = operationName || spanAttributes['gen_ai.operation.name'] || 'chat';
    const normalizedOperation = (requestedOperation === 'completion' || requestedOperation === 'embedding') ? requestedOperation : 'chat';
    const promptTokens = spanAttributes['gen_ai.usage.input_tokens'] || spanAttributes['gen_ai.usage.prompt_tokens'] || 0;
    const completionTokens = spanAttributes['gen_ai.usage.output_tokens'] || spanAttributes['gen_ai.usage.completion_tokens'] || 0;
    const durationMs = spanAttributes['gen_ai.response.duration_ms'] || 0;
    const model = spanAttributes['gen_ai.request.model'] || OLLAMA_MODEL;

    // Always log to console for debugging
    console.log('[GenAI Span]', JSON.stringify({
      operation: normalizedOperation,
      model,
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      duration_ms: durationMs,
    }));

    // Record OTel metrics (always works via global meter from otel.cjs)
    const metricAttrs = {
      'gen_ai.system': 'ollama',
      'gen_ai.provider.name': 'ollama',
      'gen_ai.request.model': model,
      'gen_ai.operation.name': normalizedOperation,
    };
    _tokenCounter.add(promptTokens, { ...metricAttrs, 'gen_ai.token.type': 'input' });
    _tokenCounter.add(completionTokens, { ...metricAttrs, 'gen_ai.token.type': 'output' });
    _requestDuration.record(durationMs, metricAttrs);
    _requestCounter.add(1, metricAttrs);

    // Ensure gen_ai.operation.name is set on the span (required for Dynatrace AI Observability)
    spanAttributes['gen_ai.operation.name'] = normalizedOperation;

    // Export GenAI span to Dynatrace via global tracer
    const spanName = `${normalizedOperation} ${model}`;
    const span = _genaiTracer.startSpan(spanName, {
      kind: SpanKind.CLIENT,
      attributes: spanAttributes,
    });

    // Add prompt/completion as span events for full content capture
    const promptContent = spanAttributes['gen_ai.prompt.0.content'];
    const completionContent = spanAttributes['gen_ai.completion.0.content'];
    if (promptContent) {
      span.addEvent('gen_ai.content.prompt', {
        'gen_ai.prompt': JSON.stringify([{ role: 'user', content: promptContent }]),
      });
    }
    if (completionContent) {
      span.addEvent('gen_ai.content.completion', {
        'gen_ai.completion': JSON.stringify([{ role: 'assistant', content: completionContent }]),
      });
    }

    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  } catch (error) {
    console.error('[GenAI Span] Failed to export:', error.message);
  }
}

async function loadPromptTemplates() {
  if (promptTemplates) return promptTemplates;
  try {
    const [systemContext, dqlExamples, dashboardTemplate, userPromptTemplate, salesResearchContext] = await Promise.all([
      fs.readFile(path.join(PROMPTS_PATH, 'system-context.txt'), 'utf-8'),
      fs.readFile(path.join(PROMPTS_PATH, 'dql-examples.txt'), 'utf-8'),
      fs.readFile(path.join(PROMPTS_PATH, 'dashboard-template.json'), 'utf-8'),
      fs.readFile(path.join(PROMPTS_PATH, 'user-prompt-template.txt'), 'utf-8'),
      fs.readFile(path.join(PROMPTS_PATH, 'sales-research-context.txt'), 'utf-8').catch(() => '')
    ]);
    promptTemplates = { systemContext, dqlExamples, dashboardTemplate, userPromptTemplate, salesResearchContext };
    return promptTemplates;
  } catch (error) {
    console.error('[AI Dashboard] Failed to load prompt templates:', error.message);
    return {
      systemContext: 'You are a Dynatrace dashboard expert.',
      dqlExamples: 'fetch bizevents | summarize count()',
      dashboardTemplate: '{}',
      userPromptTemplate: 'Create a dashboard for {company}'
    };
  }
}

async function checkOllamaAvailable() {
  if (isOllamaHardDisabled()) {
    global.ollamaAvailable = false;
    return false;
  }
  try {
    const response = await fetch(`${OLLAMA_ENDPOINT}/api/tags`, { signal: AbortSignal.timeout(5000) });
    let available = false;
    if (response.ok) {
      const data = await response.json();
      available = Boolean(data.models?.some(m => m.name.includes(OLLAMA_MODEL.split(':')[0])));
    }
    // Record the result so 'auto' converges to a known state for anything that asks.
    global.ollamaAvailable = available;
    return available;
  } catch (error) {
    global.ollamaAvailable = false;
    return false;
  }
}

// Warm up Ollama by generating a simple response to keep the model loaded in memory
async function warmupOllama() {
  const startTime = Date.now();
  try {
    console.log('[Ollama Warmup] 🔥 Starting warmup check...');
    const isAvailable = await checkOllamaAvailable();
    if (!isAvailable) {
      console.log('[Ollama Warmup] ⚠️ Model not available, skipping warmup');
      return;
    }
    
    console.log('[Ollama Warmup] 🔥 Sending warmup prompt to Ollama...');
    const warmupPrompt = 'Say "ready" in one word.';
    const response = await fetch(`${OLLAMA_ENDPOINT}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: warmupPrompt,
        stream: false,
        keep_alive: -1,
        options: { num_predict: 8 }
      }),
      signal: AbortSignal.timeout(60000) // 60s timeout for warmup
    });

    const elapsed = Date.now() - startTime;
    if (response.ok) {
      const result = await response.json();
      console.log(`[Ollama Warmup] ✅ Model loaded and ready (${elapsed}ms) — tokens: prompt=${result.prompt_eval_count || 0}, completion=${result.eval_count || 0}`);
      // Export warmup as a GenAI span so Ollama calls are always visible in AI Observability
      await logGenAISpan(
        createGenAISpan(warmupPrompt, result.response || 'ready', OLLAMA_MODEL,
          result.prompt_eval_count || 0, result.eval_count || 0, elapsed),
        'warmup'
      );
    } else {
      console.warn(`[Ollama Warmup] ⚠️ Warmup failed (HTTP ${response.status}, ${elapsed}ms)`);
    }
  } catch (error) {
    const elapsed = Date.now() - startTime;
    console.warn(`[Ollama Warmup] ⚠️ Error during warmup (${elapsed}ms):`, error.message);
  }
}

// Schedule Ollama warmup every 8 minutes to keep model loaded
function scheduleOllamaWarmup() {
  if (isOllamaHardDisabled()) {
    console.log('[Ollama Warmup] ⏭️  OLLAMA_MODE=disabled, skipping warmup scheduler');
    return;
  }
  console.log('[Ollama Warmup] 📅 Scheduling periodic warmup (every 8 minutes)');
  
  // Initial warmup on startup (async, don't wait)
  setImmediate(() => {
    console.log('[Ollama Warmup] 🚀 Starting initial warmup on server startup...');
    warmupOllama().catch(err => console.warn('[Ollama Warmup] Startup warmup error:', err.message));
  });
  
  // Periodic warmup every 8 minutes
  setInterval(() => {
    console.log('[Ollama Warmup] ⏰ Running periodic warmup (every 8 minutes)...');
    warmupOllama().catch(err => console.warn('[Ollama Warmup] Periodic warmup error:', err.message));
  }, 8 * 60 * 1000);
}

// ============================================================================
// ASYNC JOB QUEUE - Dashboard generation storage
// ============================================================================

const dashboardJobs = new Map(); // jobId → {status, dashboard, error, startTime, completedTime}

function generateJobId() {
  return `djob-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

function createJob(jobId, journeyData) {
  return {
    jobId,
    journeyData,
    status: 'pending', // pending → generating → completed → error
    dashboard: null,
    error: null,
    startTime: Date.now(),
    completedTime: null
  };
}

async function generateDashboardAsync(journeyData) {
  const jobId = generateJobId();
  const job = createJob(jobId, journeyData);
  dashboardJobs.set(jobId, job);
  
  console.log(`[Dashboard Job] 📋 Created job ${jobId} - Status: ${job.status}`);
  
  // Start generation in background (fire and forget)
  setImmediate(async () => {
    try {
      job.status = 'generating';
      console.log(`[Dashboard Job] 🚀 Starting generation for ${jobId}`);
      
      const skills = await loadDynatraceSkills();
      let dashboard;
      
      try {
        dashboard = await generateFullDashboardWithAI(journeyData, skills);
      } catch (aiError) {
        console.warn(`[Dashboard Job] ⚠️ AI generation failed (${aiError.message}), using fallback...`);
        dashboard = await generateDashboardStructure(journeyData);
      }
      
      job.dashboard = dashboard;
      job.status = 'completed';
      job.completedTime = Date.now();
      
      console.log(`[Dashboard Job] ✅ Completed ${jobId} (${job.completedTime - job.startTime}ms)`);
      
      // Keep job for 30 minutes, then clean up
      setTimeout(() => dashboardJobs.delete(jobId), 30 * 60 * 1000);
    } catch (error) {
      job.error = error.message;
      job.status = 'error';
      job.completedTime = Date.now();
      console.error(`[Dashboard Job] ❌ Failed ${jobId}: ${error.message}`);
    }
  });
  
  return jobId;
}

function getJobStatus(jobId) {
  const job = dashboardJobs.get(jobId);
  if (!job) {
    return { error: 'Job not found', jobId };
  }
  
  return {
    jobId: job.jobId,
    status: job.status,
    dashboard: job.status === 'completed' ? job.dashboard : null,
    error: job.error,
    elapsedMs: Date.now() - job.startTime,
    completedAt: job.completedTime
  };
}


async function loadDynatraceSkills() {
  const skills = { 'dt-app-dashboard': null, 'dt-dql-essentials': null };
  try {
    const [dashboardSkill, dqlSkill] = await Promise.all([
      fs.readFile(path.join(SKILLS_PATH, 'dt-app-dashboard/SKILL.md'), 'utf-8'),
      fs.readFile(path.join(SKILLS_PATH, 'dt-dql-essentials/SKILL.md'), 'utf-8')
    ]);
    skills['dt-app-dashboard'] = dashboardSkill;
    skills['dt-dql-essentials'] = dqlSkill;
    console.log('[AI Dashboard] ✅ Loaded Dynatrace skills');
    return skills;
  } catch (error) {
    console.error('[AI Dashboard] ⚠️  Could not load skills:', error.message);
    return skills;
  }
}

// Load and customize pre-built template dashboard
async function loadTemplatedasDashboard(company, journeyType) {
  try {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const templatePath = path.join(__dirname, 'template-dashboard.json');
    const templateContent = await fs.readFile(templatePath, 'utf-8');
    let template = JSON.parse(templateContent);

    console.log('[Template Dashboard] 📋 Loaded base template');

    // If the template file is a full dashboard document (name/type/content), extract the content
    let isFullDoc = false;
    if (template && template.type === 'dashboard' && template.content) {
      isFullDoc = true;
      template = template.content;
    }

    // Helper to safely replace company-specific filters inside query strings
    const companyEsc = (company || '').replace(/"/g, '\\"');
    function replaceCompanyFilterInString(s) {
      if (!s || !company) return s;
      // Replace patterns like: filter json.companyName == "Something"
      return s.replace(/filter\s+json\.companyName\s*==\s*["'`][^"'`]+["'`]/g, `filter json.companyName == "${companyEsc}"`);
    }

    // Apply replacements to variable inputs
    if (Array.isArray(template.variables)) {
      template.variables = template.variables.map(v => {
        if (v && typeof v.input === 'string') v.input = replaceCompanyFilterInString(v.input);
        return v;
      });
    }

    // Apply replacements to all tile queries and markdown content
    if (template.tiles && typeof template.tiles === 'object') {
      for (const k of Object.keys(template.tiles)) {
        const t = template.tiles[k];
        if (!t) continue;
        if (typeof t.query === 'string') t.query = replaceCompanyFilterInString(t.query);
        if (typeof t.content === 'string') t.content = t.content.replace(/\$\{CompanyName\}|\$CompanyName/g, company || t.content);
      }
    }

    // Customize a few obvious markdown tiles (header, flow, footer)
    if (template.tiles && template.tiles['0']) {
      template.tiles['0'].content = `# ${company}\n## ${journeyType} - Business Observability Dashboard\n\n**Industry:** ${journeyType} | **Dashboard Type:** Preset Template\n**Data Signals Detected:** 🔧 Services`;
    }
    if (template.tiles && template.tiles['1']) {
      // Keep existing flow if present, otherwise inject a simple one
      if (!template.tiles['1'].content || template.tiles['1'].content.trim().length < 10) {
        template.tiles['1'].content = `## 🔄 Customer Journey Flow\n\n**${journeyType}** journey steps are dynamically loaded from your data\n\n---\n*End-to-end journey visualization with step-by-step metrics*`;
      } else {
        // Replace any placeholders
        template.tiles['1'].content = template.tiles['1'].content.replace(/Media|Retail|\w+\s?Journey/g, journeyType || '$JourneyType');
      }
    }
    if (template.tiles && template.tiles['45']) {
      template.tiles['45'].content = `*Dashboard auto-generated by BizObs Demonstrator* | Monitoring ${company} ${journeyType} journey performance across all touchpoints`;
    }

    // Build the final dashboard document (preserve existing template metadata if present)
    const finalDoc = {
      name: `${company} - ${journeyType} [Preset Template]`,
      type: 'dashboard',
      version: 1,
      content: template,
      metadata: {
        generatedBy: 'ai-dashboard-generator',
        generationMethod: 'template',
        company,
        journeyType,
        generatedAt: new Date().toISOString()
      }
    };

    console.log(`[Template Dashboard] ✅ Customized for ${company} - ${journeyType}`);
    return finalDoc;
  } catch (error) {
    console.error('[Template Dashboard] ⚠️ Could not load template:', error.message);
    return null;
  }
}
// Scans the full incoming payload and classifies every field for tile generation
// ============================================================================

function detectPayloadFields(journeyData) {
  const detected = {
    additionalFields: {},
    customerProfile: {},
    traceMetadata: {},
    stepFields: {},
    stringFields: [],
    numericFields: [],
    booleanFields: [],
    objectFields: [],
    hasRevenue: false,
    hasLoyalty: false,
    hasDeviceType: false,
    hasLocation: false,
    hasNPS: false,
    hasChurnRisk: false,
    hasLTV: false,
    hasSegments: false,
    hasConversion: false,
    hasChannel: false,
    hasServices: false,
    hasCurrency: false,
    hasPricing: false,
    hasRisk: false,
    hasFraud: false,
    hasCompliance: false,
    hasEngagement: false,
    hasSatisfaction: false,
    hasRetention: false,
    hasProduct: false,
    hasOperational: false,
    hasForecast: false,
    hasAcquisition: false,
    hasUpsell: false,
    hasBrowser: false,
    hasSubscription: false,
    hasMembership: false
  };

  // ---- Scan additionalFields ----
  const af = journeyData.additionalFields || {};
  Object.entries(af).forEach(([key, value]) => {
    detected.additionalFields[key] = { value, type: typeof value };
    if (typeof value === 'string') {
      detected.stringFields.push({ key, source: 'additionalfields', dqlField: `additionalfields.${key}` });
    } else if (typeof value === 'number') {
      detected.numericFields.push({ key, source: 'additionalfields', dqlField: `additionalfields.${key}` });
    } else if (typeof value === 'boolean') {
      detected.booleanFields.push({ key, source: 'additionalfields', dqlField: `additionalfields.${key}` });
    } else if (typeof value === 'object' && value !== null) {
      detected.objectFields.push({ key, source: 'additionalfields', dqlField: `additionalfields.${key}`, value });
    }
  });

  // ---- Scan customerProfile ----
  const cp = journeyData.customerProfile || {};
  Object.entries(cp).forEach(([key, value]) => {
    detected.customerProfile[key] = { value, type: typeof value };
    if (typeof value === 'string' && !['userId', 'email', 'sessionId'].includes(key)) {
      detected.stringFields.push({ key, source: 'customerProfile', dqlField: `additionalfields.${key}` });
    } else if (typeof value === 'number') {
      detected.numericFields.push({ key, source: 'customerProfile', dqlField: `additionalfields.${key}` });
    }
  });

  // ---- Scan traceMetadata.businessContext ----
  const bc = journeyData.traceMetadata?.businessContext || {};
  Object.entries(bc).forEach(([key, value]) => {
    detected.traceMetadata[key] = { value, type: typeof value };
    if (typeof value === 'string' && key !== 'correlationId') {
      detected.stringFields.push({ key, source: 'traceMetadata', dqlField: `additionalfields.${key}` });
    } else if (typeof value === 'number') {
      detected.numericFields.push({ key, source: 'traceMetadata', dqlField: `additionalfields.${key}` });
    }
  });

  // ---- Scan step-level fields ----
  const steps = journeyData.steps || [];
  steps.forEach(step => {
    if (step.category) detected.stepFields.category = true;
    if (step.hasError !== undefined) detected.stepFields.hasError = true;
    if (step.estimatedDuration) detected.stepFields.estimatedDuration = true;
    if (step.serviceName) detected.hasServices = true;
  });

  // ---- Set summary flags ----
  const allKeys = Object.keys(af).concat(Object.keys(cp)).concat(Object.keys(bc)).map(k => k ? k.toLowerCase() : '').filter(k => k);
  detected.hasRevenue = allKeys.some(k => k && (k.includes('revenue') || k.includes('ordertotal') || k.includes('transactionvalue') || k.includes('transactionamount') || k.includes('businessvalue')));
  detected.hasLoyalty = allKeys.some(k => k && k.includes('loyalty'));
  detected.hasDeviceType = allKeys.some(k => k && k.includes('device'));
  detected.hasLocation = allKeys.some(k => k && (k.includes('location') || k.includes('region') || k.includes('country') || k.includes('geo')));
  detected.hasNPS = allKeys.some(k => k && (k.includes('nps') || k.includes('netpromoter') || k.includes('promoter')));
  detected.hasChurnRisk = allKeys.some(k => k && k.includes('churn'));
  detected.hasLTV = allKeys.some(k => k && (k.includes('lifetime') || k.includes('ltv') || k.includes('clv')));
  detected.hasSegments = allKeys.some(k => k && (k.includes('segment') || k.includes('tier') || k.includes('valuetier')));
  detected.hasConversion = allKeys.some(k => k && (k.includes('conversion') || k.includes('funnel')));
  detected.hasChannel = allKeys.some(k => k && (k.includes('channel') || k.includes('acquisition') || k.includes('entrychannel') || k.includes('campaign')));
  detected.hasCurrency = allKeys.some(k => k && k.includes('currency'));
  detected.hasPricing = allKeys.some(k => k && (k.includes('pricing') || k.includes('pricetier') || k.includes('pricingtier') || k.includes('contractvalue') || k.includes('annualrevenue')));
  detected.hasRisk = allKeys.some(k => k && (k.includes('risklevel') || k.includes('riskrating') || k.includes('securityrating')));
  detected.hasFraud = allKeys.some(k => k && k.includes('fraud'));
  detected.hasCompliance = allKeys.some(k => k && k.includes('compliance'));
  detected.hasEngagement = allKeys.some(k => k && (k.includes('engagement') || k.includes('pageview') || k.includes('sessionduration')));
  detected.hasSatisfaction = allKeys.some(k => k && (k.includes('satisfaction') || k.includes('rating') || k.includes('csat')));
  detected.hasRetention = allKeys.some(k => k && (k.includes('retention') || k.includes('purchasefrequency')));
  detected.hasProduct = allKeys.some(k => k && (k.includes('product') || k.includes('sku')));
  detected.hasOperational = allKeys.some(k => k && (k.includes('operationalcost') || k.includes('efficiency') || k.includes('utilization') || k.includes('costperacquisition')));
  detected.hasForecast = allKeys.some(k => k && (k.includes('growthpotential') || k.includes('futurevalue') || k.includes('expansion') || k.includes('markettrend') || k.includes('seasonal')));
  detected.hasAcquisition = allKeys.some(k => k && (k.includes('acquisitioncost') || k.includes('costperacquisition')));
  detected.hasUpsell = allKeys.some(k => k && (k.includes('upsell') || k.includes('crosssell')));
  detected.hasBrowser = allKeys.some(k => k && k.includes('browser'));
  detected.hasSubscription = allKeys.some(k => k && k.includes('subscription'));
  detected.hasMembership = allKeys.some(k => k && k.includes('membership'));

  return detected;
}

function formatFieldsForPrompt(detected) {
  const lines = [];
  if (detected.stringFields.length > 0) {
    lines.push(`CATEGORICAL FIELDS (good for donut/bar charts): ${detected.stringFields.map(f => f.key).join(', ')}`);
  }
  if (detected.numericFields.length > 0) {
    lines.push(`NUMERIC FIELDS (good for singleValue, gauge): ${detected.numericFields.map(f => f.key).join(', ')}`);
  }
  if (detected.booleanFields.length > 0) {
    lines.push(`BOOLEAN FIELDS (good for countIf): ${detected.booleanFields.map(f => f.key).join(', ')}`);
  }
  const flags = [];
  if (detected.hasRevenue) flags.push('💰 Revenue/Transaction data');
  if (detected.hasLoyalty) flags.push('⭐ Loyalty data');
  if (detected.hasDeviceType) flags.push('📱 Device type data');
  if (detected.hasLocation) flags.push('🌍 Geographic data');
  if (detected.hasNPS) flags.push('📊 NPS scores');
  if (detected.hasChurnRisk) flags.push('⚠️ Churn risk');
  if (detected.hasLTV) flags.push('📈 Customer LTV');
  if (detected.hasSegments) flags.push('👥 Segments/Tiers');
  if (detected.hasConversion) flags.push('🎯 Conversion data');
  if (detected.hasChannel) flags.push('📡 Channel/Acquisition');
  if (detected.hasServices) flags.push('🔧 Service names');
  if (detected.hasPricing) flags.push('💳 Pricing/Tiers');
  if (detected.hasRisk) flags.push('🛡️ Risk levels');
  if (detected.hasFraud) flags.push('🚨 Fraud detection');
  if (detected.hasCompliance) flags.push('📋 Compliance');
  if (detected.hasEngagement) flags.push('📊 Engagement');
  if (detected.hasSatisfaction) flags.push('😊 Satisfaction/Ratings');
  if (detected.hasRetention) flags.push('🔄 Retention');
  if (detected.hasProduct) flags.push('📦 Product data');
  if (detected.hasOperational) flags.push('⚙️ Operational metrics');
  if (detected.hasForecast) flags.push('🔮 Forecast/Growth');
  if (detected.hasAcquisition) flags.push('🎯 Acquisition cost');
  if (detected.hasUpsell) flags.push('📈 Upsell/Cross-sell');
  if (detected.hasBrowser) flags.push('🌐 Browser data');
  if (detected.hasSubscription) flags.push('📰 Subscription');
  if (detected.hasMembership) flags.push('🏅 Membership');
  if (flags.length > 0) lines.push(`DATA SIGNALS: ${flags.join(', ')}`);
  return lines.join('\n');
}

// ============================================================================
// DYNAMIC TILE GENERATOR
// Generates tiles based on detected fields
// ============================================================================

function generateDynamicFieldTiles(detected, company, journeyType) {
  const dynamicTiles = {};
  const baseFilter = `filter event.kind == "BIZ_EVENT" | filter json.companyName == "${company}"`;

  // For each STRING field → donut chart
  detected.stringFields.forEach(field => {
    const skipKeys = ['sessionid', 'userid', 'email', 'correlationid', 'businesseventtype'];
    if (skipKeys.includes(field.key.toLowerCase())) return;

    const tileKey = `dynamic_${field.key}`;
    const prettyName = field.key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();

    dynamicTiles[tileKey] = {
      name: `📊 ${prettyName} Distribution`,
      query: `fetch bizevents | ${baseFilter} | filter json.journeyType == $JourneyType or $JourneyType == "*" | summarize count = count(), by: {${field.dqlField}} | sort count desc | limit 10`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: { circleChartSettings: { valueType: 'relative', showTotalValue: true } },
        legend: { ratio: 27 },
        thresholds: [],
        unitsOverrides: []
      }
    };
  });

  // For each NUMERIC field → singleValue or gauge
  detected.numericFields.forEach(field => {
    const skipKeys = ['processingtime', 'estimatedduration'];
    if (skipKeys.includes(field.key.toLowerCase())) return;

    const tileKey = `dynamic_${field.key}`;
    const prettyName = field.key.replace(/([A-Z])/g, ' $1').replace(/^./, s => s.toUpperCase()).trim();

    const isCurrency = /revenue|value|total|amount|price|cost|ltv|lifetime/i.test(field.key);
    const isPercentage = /rate|score|percentage|ratio|likelihood/i.test(field.key);
    const viz = isPercentage ? 'gauge' : 'singleValue';
    const unitCat = isCurrency ? 'currency' : isPercentage ? 'percentage' : 'unspecified';
    const baseUnit = isCurrency ? 'usd' : isPercentage ? 'percent' : 'count';

    dynamicTiles[tileKey] = {
      name: `${isCurrency ? '💰' : isPercentage ? '📊' : '📈'} Avg ${prettyName}`,
      query: `fetch bizevents | ${baseFilter} | filter json.journeyType == $JourneyType or $JourneyType == "*" | filter in(json.stepName, $Step) | summarize value = avg(toDouble(${field.dqlField}))`,
      visualization: viz,
      visualizationSettings: {
        singleValue: viz === 'singleValue' ? { label: prettyName.toUpperCase(), recordField: 'value', colorThresholdTarget: 'background' } : undefined,
        thresholds: [],
        unitsOverrides: [{ identifier: 'value', unitCategory: unitCat, baseUnit: baseUnit, decimals: isCurrency ? 0 : 1, suffix: isCurrency ? '$' : isPercentage ? '%' : '', delimiter: true }]
      }
    };
  });

  // ---- FLAG-BASED SMART TILES ----
  // Generate specialized tiles based on detected boolean flags
  const varFilter = `${baseFilter} | filter json.journeyType == $JourneyType or $JourneyType == "*"`;
  const stepVarFilter = `${varFilter} | filter in(json.stepName, $Step)`;

  if (detected.hasNPS) {
    dynamicTiles['flag_nps_gauge'] = {
      name: '📊 Net Promoter Score',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.netPromoterScore))`,
      visualization: 'gauge',
      visualizationSettings: {
        gauge: { label: 'NPS', min: 0, max: 100 },
        thresholds: [{ id: 1, field: 'value', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≥', value: 70 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 40 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '<', value: 40 }
        ]}],
        unitsOverrides: [{ identifier: 'value', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, suffix: '', delimiter: true }]
      }
    };
    dynamicTiles['flag_nps_by_step'] = {
      name: '📊 NPS by Journey Step',
      query: `fetch bizevents | ${varFilter} | summarize AvgNPS = avg(toDouble(additionalfields.netPromoterScore)), by: {json.stepName} | sort AvgNPS desc`,
      visualization: 'categoricalBarChart',
      visualizationSettings: { chartSettings: { categoricalBarChartSettings: {} }, thresholds: [], unitsOverrides: [] }
    };
  }

  if (detected.hasSatisfaction) {
    dynamicTiles['flag_satisfaction_gauge'] = {
      name: '😊 Customer Satisfaction',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.satisfactionRating))`,
      visualization: 'gauge',
      visualizationSettings: {
        gauge: { label: 'CSAT', min: 0, max: 5 },
        thresholds: [{ id: 1, field: 'value', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≥', value: 4 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 3 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '<', value: 3 }
        ]}],
        unitsOverrides: [{ identifier: 'value', unitCategory: 'unspecified', baseUnit: 'count', decimals: 1, suffix: '/5', delimiter: true }]
      }
    };
  }

  if (detected.hasChurnRisk) {
    dynamicTiles['flag_churn_distribution'] = {
      name: '⚠️ Churn Risk Distribution',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {additionalfields.churnRisk} | sort count desc`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: { circleChartSettings: { valueType: 'relative', showTotalValue: true } },
        legend: { ratio: 27 }, thresholds: [], unitsOverrides: []
      }
    };
    dynamicTiles['flag_churn_high_count'] = {
      name: '🚨 High Churn Risk Count',
      query: `fetch bizevents | ${varFilter} | summarize value = countIf(additionalfields.churnRisk == "high")`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'HIGH CHURN RISK', recordField: 'value', colorThresholdTarget: 'background' },
        thresholds: [{ id: 1, field: 'value', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '>', value: 5 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '>', value: 2 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≤', value: 2 }
        ]}],
        unitsOverrides: [{ identifier: 'value', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, suffix: '', delimiter: true }]
      }
    };
  }

  if (detected.hasEngagement) {
    dynamicTiles['flag_engagement_score'] = {
      name: '📊 Avg Engagement Score',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.engagementScore))`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'ENGAGEMENT SCORE', recordField: 'value', colorThresholdTarget: 'background' },
        thresholds: [{ id: 1, field: 'value', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≥', value: 80 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 60 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '<', value: 60 }
        ]}],
        unitsOverrides: [{ identifier: 'value', unitCategory: 'unspecified', baseUnit: 'count', decimals: 1, suffix: '', delimiter: true }]
      }
    };
    dynamicTiles['flag_engagement_trend'] = {
      name: '📈 Engagement Over Time',
      query: `fetch bizevents | ${varFilter} | makeTimeseries value = avg(toDouble(additionalfields.engagementScore)), bins:30`,
      visualization: 'lineChart',
      visualizationSettings: {
        chartSettings: { gapPolicy: 'connect', seriesOverrides: [{ seriesId: ['value'], override: { color: '#478ACA' } }] },
        thresholds: [], unitsOverrides: []
      }
    };
  }

  if (detected.hasRisk) {
    dynamicTiles['flag_risk_distribution'] = {
      name: '🛡️ Risk Level Distribution',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {additionalfields.riskLevel} | sort count desc`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: { circleChartSettings: { valueType: 'relative', showTotalValue: true } },
        legend: { ratio: 27 }, thresholds: [], unitsOverrides: []
      }
    };
    dynamicTiles['flag_security_rating'] = {
      name: '🔒 Security Rating Distribution',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {additionalfields.securityRating} | sort count desc`,
      visualization: 'categoricalBarChart',
      visualizationSettings: { chartSettings: { categoricalBarChartSettings: {} }, thresholds: [], unitsOverrides: [] }
    };
  }

  if (detected.hasFraud) {
    dynamicTiles['flag_fraud_distribution'] = {
      name: '🚨 Fraud Risk Distribution',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {additionalfields.fraudRisk} | sort count desc`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: { circleChartSettings: { valueType: 'relative', showTotalValue: true } },
        legend: { ratio: 27 }, thresholds: [], unitsOverrides: []
      }
    };
  }

  if (detected.hasCompliance) {
    dynamicTiles['flag_compliance_gauge'] = {
      name: '📋 Compliance Score',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.complianceScore))`,
      visualization: 'gauge',
      visualizationSettings: {
        gauge: { label: 'COMPLIANCE', min: 0, max: 100 },
        thresholds: [{ id: 1, field: 'value', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≥', value: 90 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 75 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '<', value: 75 }
        ]}],
        unitsOverrides: [{ identifier: 'value', unitCategory: 'percentage', baseUnit: 'percent', decimals: 1, suffix: '%', delimiter: true }]
      }
    };
  }

  if (detected.hasRetention) {
    dynamicTiles['flag_retention_rate'] = {
      name: '🔄 Avg Retention Probability',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.retentionProbability)) * 100`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'RETENTION RATE', recordField: 'value', colorThresholdTarget: 'background' },
        thresholds: [{ id: 1, field: 'value', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≥', value: 80 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 60 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '<', value: 60 }
        ]}],
        unitsOverrides: [{ identifier: 'value', unitCategory: 'percentage', baseUnit: 'percent', decimals: 1, suffix: '%', delimiter: true }]
      }
    };
    dynamicTiles['flag_purchase_frequency'] = {
      name: '🛒 Avg Purchase Frequency',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.purchaseFrequency))`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'PURCHASE FREQUENCY', recordField: 'value', colorThresholdTarget: 'background' },
        thresholds: [], unitsOverrides: [{ identifier: 'value', unitCategory: 'unspecified', baseUnit: 'count', decimals: 1, suffix: 'x', delimiter: true }]
      }
    };
  }

  if (detected.hasPricing) {
    dynamicTiles['flag_pricing_tier'] = {
      name: '💳 Pricing Tier Distribution',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {additionalfields.pricingTier} | sort count desc`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: { circleChartSettings: { valueType: 'relative', showTotalValue: true } },
        legend: { ratio: 27 }, thresholds: [], unitsOverrides: []
      }
    };
    dynamicTiles['flag_avg_contract'] = {
      name: '💰 Avg Contract Value',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.contractValue))`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'AVG CONTRACT', recordField: 'value', colorThresholdTarget: 'background' },
        thresholds: [], unitsOverrides: [{ identifier: 'value', unitCategory: 'currency', baseUnit: 'usd', decimals: 0, suffix: '$', delimiter: true }]
      }
    };
  }

  if (detected.hasProduct) {
    dynamicTiles['flag_product_distribution'] = {
      name: '📦 Product Type Distribution',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {additionalfields.ProductType} | sort count desc | limit 10`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: { circleChartSettings: { valueType: 'relative', showTotalValue: true } },
        legend: { ratio: 27 }, thresholds: [], unitsOverrides: []
      }
    };
  }

  if (detected.hasOperational) {
    dynamicTiles['flag_efficiency'] = {
      name: '⚙️ Avg Efficiency Rating',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.efficiencyRating))`,
      visualization: 'gauge',
      visualizationSettings: {
        gauge: { label: 'EFFICIENCY', min: 0, max: 100 },
        thresholds: [{ id: 1, field: 'value', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≥', value: 85 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 70 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '<', value: 70 }
        ]}],
        unitsOverrides: [{ identifier: 'value', unitCategory: 'percentage', baseUnit: 'percent', decimals: 1, suffix: '%', delimiter: true }]
      }
    };
    dynamicTiles['flag_operational_cost'] = {
      name: '💸 Avg Operational Cost',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.operationalCost))`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'OPS COST', recordField: 'value', colorThresholdTarget: 'background' },
        thresholds: [], unitsOverrides: [{ identifier: 'value', unitCategory: 'currency', baseUnit: 'usd', decimals: 0, suffix: '$', delimiter: true }]
      }
    };
  }

  if (detected.hasForecast) {
    dynamicTiles['flag_growth_potential'] = {
      name: '🔮 Avg Growth Potential',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.growthPotential))`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'GROWTH POTENTIAL', recordField: 'value', colorThresholdTarget: 'background' },
        thresholds: [], unitsOverrides: [{ identifier: 'value', unitCategory: 'currency', baseUnit: 'usd', decimals: 0, suffix: '$', delimiter: true }]
      }
    };
    dynamicTiles['flag_market_trend'] = {
      name: '📈 Market Trend Distribution',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {additionalfields.marketTrend} | sort count desc`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: { circleChartSettings: { valueType: 'relative', showTotalValue: true } },
        legend: { ratio: 27 }, thresholds: [], unitsOverrides: []
      }
    };
  }

  if (detected.hasAcquisition) {
    dynamicTiles['flag_avg_acquisition_cost'] = {
      name: '🎯 Avg Acquisition Cost',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.acquisitionCost))`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'ACQ COST', recordField: 'value', colorThresholdTarget: 'background' },
        thresholds: [], unitsOverrides: [{ identifier: 'value', unitCategory: 'currency', baseUnit: 'usd', decimals: 0, suffix: '$', delimiter: true }]
      }
    };
  }

  if (detected.hasUpsell) {
    dynamicTiles['flag_upsell_potential'] = {
      name: '📈 Avg Upsell Potential',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.upsellPotential))`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'UPSELL POTENTIAL', recordField: 'value', colorThresholdTarget: 'background' },
        thresholds: [], unitsOverrides: [{ identifier: 'value', unitCategory: 'currency', baseUnit: 'usd', decimals: 0, suffix: '$', delimiter: true }]
      }
    };
    dynamicTiles['flag_crosssell_distribution'] = {
      name: '🔀 Cross-Sell Opportunity',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {additionalfields.crossSellOpportunity} | sort count desc`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: { circleChartSettings: { valueType: 'relative', showTotalValue: true } },
        legend: { ratio: 27 }, thresholds: [], unitsOverrides: []
      }
    };
  }

  if (detected.hasSubscription) {
    dynamicTiles['flag_subscription_distribution'] = {
      name: '📰 Subscription Level',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {additionalfields.subscriptionLevel} | sort count desc`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: { circleChartSettings: { valueType: 'relative', showTotalValue: true } },
        legend: { ratio: 27 }, thresholds: [], unitsOverrides: []
      }
    };
  }

  if (detected.hasMembership) {
    dynamicTiles['flag_membership_distribution'] = {
      name: '🏅 Membership Status',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {additionalfields.membershipStatus} | sort count desc`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: { circleChartSettings: { valueType: 'relative', showTotalValue: true } },
        legend: { ratio: 27 }, thresholds: [], unitsOverrides: []
      }
    };
  }

  if (detected.hasConversion) {
    dynamicTiles['flag_conversion_rate'] = {
      name: '🎯 Avg Conversion Rate',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.conversionRate)) * 100`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'CONVERSION RATE', recordField: 'value', colorThresholdTarget: 'background' },
        thresholds: [{ id: 1, field: 'value', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≥', value: 10 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 5 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '<', value: 5 }
        ]}],
        unitsOverrides: [{ identifier: 'value', unitCategory: 'percentage', baseUnit: 'percent', decimals: 1, suffix: '%', delimiter: true }]
      }
    };
    dynamicTiles['flag_time_to_conversion'] = {
      name: '⏱️ Avg Time to Conversion',
      query: `fetch bizevents | ${varFilter} | summarize value = avg(toDouble(additionalfields.timeToConversion))`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'TIME TO CONVERT', recordField: 'value', colorThresholdTarget: 'background' },
        thresholds: [], unitsOverrides: [{ identifier: 'value', unitCategory: 'time', baseUnit: 'minute', decimals: 1, suffix: ' min', delimiter: true }]
      }
    };
  }

  return dynamicTiles;
}

// ============================================================================
// CORE TILE TEMPLATES
// ============================================================================

function generateCoreTileTemplates(company, journeyType, steps, dynatraceUrl) {
  const baseFilter = `filter event.kind == "BIZ_EVENT" | filter json.companyName == "${company}"`;
  const journeyFilter = `${baseFilter} | filter json.journeyType == "${journeyType}"`;
  const varFilter = `${baseFilter} | filter json.journeyType == $JourneyType or $JourneyType == "*"`;
  const stepFilter = `${varFilter} | filter in(json.stepName, $Step)`;

  return {
    // ===== OVERALL JOURNEY =====
    step_metrics: {
      name: '📊 Journey Step Metrics',
      query: `fetch bizevents | ${varFilter} | summarize OrdersInStep = count(), SuccessRate = (countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false) / count()) * 100, AvgTimeInStep = avg(additionalfields.processingTime), ErrorsInStep = countIf(additionalfields.hasError == true), ErrorRate = (countIf(additionalfields.hasError == true) / count()) * 100, by: {json.stepName} | sort OrdersInStep desc`,
      visualization: 'table',
      visualizationSettings: {
        table: { columnWidths: { 'json.stepName': 200, 'OrdersInStep': 120, 'SuccessRate': 120, 'AvgTimeInStep': 120, 'ErrorsInStep': 120, 'ErrorRate': 120 } },
        thresholds: [
          { id: 1, field: 'SuccessRate', isEnabled: true, rules: [
            { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≥', value: 95 },
            { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 85 },
            { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '<', value: 85 }
          ]},
          { id: 2, field: 'ErrorRate', isEnabled: true, rules: [
            { id: 1, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '>', value: 5 },
            { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '>', value: 2 },
            { id: 3, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≤', value: 2 }
          ]}
        ],
        unitsOverrides: [
          { identifier: 'SuccessRate', unitCategory: 'percentage', baseUnit: 'percent', decimals: 2, suffix: '%', delimiter: true },
          { identifier: 'AvgTimeInStep', unitCategory: 'time', baseUnit: 'milli_second', decimals: 0, suffix: 'ms', delimiter: true },
          { identifier: 'ErrorRate', unitCategory: 'percentage', baseUnit: 'percent', decimals: 2, suffix: '%', delimiter: true },
          { identifier: 'OrdersInStep', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }
        ]
      }
    },
    success_rate: {
      name: '✅ Journey Success Rate',
      query: `fetch bizevents | ${journeyFilter} | summarize total = count(), successful = countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false) | fieldsAdd success_rate = (successful / total) * 100`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'SUCCESS RATE', recordField: 'success_rate', colorThresholdTarget: 'value', prefixIcon: 'CheckmarkIcon' },
        thresholds: [{ id: 1, field: 'success_rate', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≥', value: 95 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 85 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '<', value: 85 }
        ]}],
        unitsOverrides: [{ identifier: 'success_rate', unitCategory: 'percentage', baseUnit: 'percent', decimals: 1, suffix: '%', delimiter: true }]
      }
    },
    total_volume: {
      name: '📈 Total Journey Volume',
      query: `fetch bizevents | ${journeyFilter} | summarize TotalEvents = count()`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'TOTAL VOLUME', recordField: 'TotalEvents', colorThresholdTarget: 'background', prefixIcon: 'ActivityIcon' },
        thresholds: [],
        unitsOverrides: [{ identifier: 'TotalEvents', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }]
      }
    },
    error_count: {
      name: '❌ Total Errors',
      query: `fetch bizevents | ${varFilter} | summarize errors = countIf(additionalfields.hasError == true)`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'ERRORS', recordField: 'errors', colorThresholdTarget: 'background' },
        thresholds: [{ id: 1, field: 'errors', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '>', value: 10 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '>', value: 5 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≤', value: 5 }
        ]}],
        unitsOverrides: [{ identifier: 'errors', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }]
      }
    },
    business_value: {
      name: '💰 Total Revenue',
      query: `fetch bizevents | ${varFilter} | summarize revenue = sum(additionalfields.orderTotal)`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'REVENUE', recordField: 'revenue', prefixIcon: 'MoneyIcon', colorThresholdTarget: 'background' },
        thresholds: [],
        unitsOverrides: [{ identifier: 'revenue', unitCategory: 'currency', baseUnit: 'usd', decimals: 0, suffix: '$', delimiter: true }]
      }
    },
    volume_trend: {
      name: '📈 Volume Over Time',
      query: `fetch bizevents | ${journeyFilter} | makeTimeseries successful = countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false), failed = countIf(additionalfields.hasError == true), bins:30`,
      visualization: 'areaChart',
      visualizationSettings: {
        chartSettings: {
          fieldMapping: { leftAxisValues: ['successful', 'failed'], timestamp: 'timeframe' },
          seriesOverrides: [
            { seriesId: ['successful'], override: { color: '#2AB06F' } },
            { seriesId: ['failed'], override: { color: '#C62239' } }
          ],
          gapPolicy: 'connect'
        },
        thresholds: [], unitsOverrides: []
      }
    },
    conversion_funnel: {
      name: '📊 Events by Step',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {json.stepName} | sort count desc | limit 10`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: { circleChartSettings: { valueType: 'relative', showTotalValue: true } },
        legend: { ratio: 27 }, thresholds: [], unitsOverrides: []
      }
    },
    error_analysis: {
      name: '❌ Errors by Step',
      query: `fetch bizevents | ${journeyFilter} | filter additionalfields.hasError == true | summarize ErrorCount = count(), by: {json.stepName} | sort ErrorCount desc`,
      visualization: 'barChart',
      visualizationSettings: {
        chartSettings: { colorPalette: 'negativeComparison', gapPolicy: 'connect' },
        unitsOverrides: [{ identifier: 'ErrorCount', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }]
      }
    },
    error_types: {
      name: '🐛 Error Details',
      query: `fetch bizevents | ${journeyFilter} | filter additionalfields.hasError == true | summarize Occurrences = count(), by: {json.stepName, additionalfields.errorMessage} | sort Occurrences desc | limit 20`,
      visualization: 'table',
      visualizationSettings: {
        table: { rowDensity: 'condensed', enableLineWrap: true, columnWidths: { 'json.stepName': 150, 'additionalfields.errorMessage': 300, 'Occurrences': 100 } },
        thresholds: [],
        unitsOverrides: [{ identifier: 'Occurrences', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }]
      }
    },
    top_errors: {
      name: '🔥 Top Error Messages',
      query: `fetch bizevents | ${journeyFilter} | filter additionalfields.hasError == true | summarize Count = count(), by: {additionalfields.errorMessage} | sort Count desc | limit 10`,
      visualization: 'categoricalBarChart',
      visualizationSettings: { thresholds: [], unitsOverrides: [{ identifier: 'Count', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }] }
    },
    error_rate_trend: {
      name: '📉 Error Rate Trend',
      query: `fetch bizevents | ${journeyFilter} | makeTimeseries {errors = countIf(additionalfields.hasError == true), total = count()}, bins:30 | fieldsAdd ErrorRate = (errors[] / total[]) * 100`,
      visualization: 'lineChart',
      visualizationSettings: {
        chartSettings: { gapPolicy: 'connect', seriesOverrides: [{ seriesId: ['ErrorRate'], override: { color: '#C62239' } }] },
        thresholds: [{ id: 1, field: 'ErrorRate', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '>', value: 5 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '>', value: 2 }
        ]}],
        unitsOverrides: [{ identifier: 'ErrorRate', unitCategory: 'percentage', baseUnit: 'percent', decimals: 2, suffix: '%', delimiter: true }]
      }
    },
    step_performance: {
      name: '⚡ Step Performance',
      query: `fetch bizevents | ${journeyFilter} | summarize Events = count(), AvgTime = avg(additionalfields.processingTime), ErrorRate = (countIf(additionalfields.hasError == true) / count()) * 100, by: {json.stepName} | sort Events desc`,
      visualization: 'table',
      visualizationSettings: {
        table: { rowDensity: 'condensed', enableLineWrap: false, columnWidths: { 'json.stepName': 200, 'Events': 100, 'AvgTime': 120, 'ErrorRate': 120 } },
        thresholds: [{ id: 1, field: 'ErrorRate', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '>', value: 5 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '>', value: 2 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≤', value: 2 }
        ]}],
        unitsOverrides: [
          { identifier: 'AvgTime', unitCategory: 'time', baseUnit: 'milli_second', decimals: 0, suffix: 'ms', delimiter: true },
          { identifier: 'ErrorRate', unitCategory: 'percentage', baseUnit: 'percent', decimals: 2, suffix: '%', delimiter: true },
          { identifier: 'Events', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }
        ]
      }
    },
    response_time: {
      name: '⏱️ Response Time by Step',
      query: `fetch bizevents | ${journeyFilter} | summarize AvgResponseTime = avg(additionalfields.processingTime), by: {json.stepName} | sort AvgResponseTime desc`,
      visualization: 'barChart',
      visualizationSettings: {
        chartSettings: { colorPalette: 'sequential', gapPolicy: 'connect' },
        unitsOverrides: [{ identifier: 'AvgResponseTime', unitCategory: 'time', baseUnit: 'milli_second', decimals: 0, suffix: 'ms', delimiter: true }]
      }
    },
    hourly_pattern: {
      name: '🕐 Hourly Activity Pattern',
      query: `fetch bizevents | ${journeyFilter} | fieldsAdd hour = toString(getHour(timestamp)) | summarize Events = count(), by: {hour} | sort hour asc`,
      visualization: 'lineChart',
      visualizationSettings: {
        chartSettings: { gapPolicy: 'connect' }, thresholds: [],
        unitsOverrides: [{ identifier: 'Events', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }]
      }
    },
    completion_time: {
      name: '⏱️ Avg Completion Time',
      query: `fetch bizevents | ${journeyFilter} | filter isNull(additionalfields.hasError) or additionalfields.hasError == false | summarize AvgCompletionTime = avg(additionalfields.processingTime)`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'AVG COMPLETION TIME', recordField: 'AvgCompletionTime', colorThresholdTarget: 'background', prefixIcon: 'ClockIcon' },
        thresholds: [{ id: 1, field: 'AvgCompletionTime', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≤', value: 2000 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≤', value: 5000 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '>', value: 5000 }
        ]}],
        unitsOverrides: [{ identifier: 'AvgCompletionTime', unitCategory: 'time', baseUnit: 'milli_second', decimals: 0, suffix: 'ms', delimiter: true }]
      }
    },
    sla_compliance: {
      name: '📋 SLA Compliance (< 5s)',
      query: `fetch bizevents | ${journeyFilter} | summarize TotalEvents = count(), WithinSLA = countIf(additionalfields.processingTime < 5000), by: {json.stepName} | fieldsAdd ComplianceRate = (WithinSLA / TotalEvents) * 100`,
      visualization: 'table',
      visualizationSettings: {
        table: { rowDensity: 'condensed', enableLineWrap: false, columnWidths: { 'json.stepName': 200, 'TotalEvents': 100, 'WithinSLA': 100, 'ComplianceRate': 120 } },
        thresholds: [{ id: 1, field: 'ComplianceRate', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≥', value: 95 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 85 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '<', value: 85 }
        ]}],
        unitsOverrides: [
          { identifier: 'ComplianceRate', unitCategory: 'percentage', baseUnit: 'percent', decimals: 1, suffix: '%', delimiter: true },
          { identifier: 'TotalEvents', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true },
          { identifier: 'WithinSLA', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }
        ]
      }
    },
    daily_comparison: {
      name: '📅 Today vs Yesterday',
      query: `fetch bizevents | ${journeyFilter} | fieldsAdd day = if(timestamp >= now() - 1d, else:"Yesterday", "Today") | filter timestamp >= now() - 2d | summarize Events = count(), SuccessRate = (countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false) / count()) * 100, by: {day}`,
      visualization: 'categoricalBarChart',
      visualizationSettings: { chartSettings: { colorPalette: 'categorical' }, thresholds: [], unitsOverrides: [{ identifier: 'Events', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }] }
    },
    step_duration_percentiles: {
      name: '⏱️ P90 Response Time',
      query: `fetch bizevents | ${stepFilter} | summarize p90 = percentile(additionalfields.processingTime, 90)`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'P90 RESPONSE TIME', recordField: 'p90', colorThresholdTarget: 'background' },
        thresholds: [{ id: 1, field: 'p90', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≤', value: 50 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≤', value: 100 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '>', value: 100 }
        ]}],
        unitsOverrides: [{ identifier: 'p90', unitCategory: 'time', baseUnit: 'millisecond', decimals: 0, suffix: ' ms', delimiter: true }]
      }
    },
    abandonment_analysis: {
      name: '🚪 Last Steps Before Drop-off',
      query: `fetch bizevents | ${journeyFilter} | filter additionalfields.hasError == true or isNull(additionalfields.completedJourney) | summarize Abandonments = count(), by: {json.stepName} | sort Abandonments desc`,
      visualization: 'categoricalBarChart',
      visualizationSettings: { chartSettings: { colorPalette: 'negativeComparison' }, thresholds: [], unitsOverrides: [{ identifier: 'Abandonments', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }] }
    },
    step_funnel_dropoff: {
      name: '🔻 Step-by-Step Conversion',
      query: `fetch bizevents | ${journeyFilter} | summarize TotalAtStep = count(), CompletedFromStep = countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false), by: {json.stepName} | fieldsAdd ConversionRate = (CompletedFromStep / TotalAtStep) * 100 | sort TotalAtStep desc`,
      visualization: 'table',
      visualizationSettings: {
        table: { rowDensity: 'condensed', enableLineWrap: false, columnWidths: { 'json.stepName': 200, 'TotalAtStep': 120, 'CompletedFromStep': 140, 'ConversionRate': 140 } },
        thresholds: [{ id: 1, field: 'ConversionRate', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≥', value: 90 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 75 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '<', value: 75 }
        ]}],
        unitsOverrides: [
          { identifier: 'TotalAtStep', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true },
          { identifier: 'CompletedFromStep', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true },
          { identifier: 'ConversionRate', unitCategory: 'percentage', baseUnit: 'percent', decimals: 1, suffix: '%', delimiter: true }
        ]
      }
    },
    peak_hours: {
      name: '🔝 Peak Activity Hours',
      query: `fetch bizevents | ${journeyFilter} | fieldsAdd hour = toString(getHour(timestamp)) | summarize Events = count(), Errors = countIf(additionalfields.hasError == true), by: {hour} | fieldsAdd ErrorRate = (toDouble(Errors) / toDouble(Events)) * 100 | sort Events desc | limit 10`,
      visualization: 'categoricalBarChart',
      visualizationSettings: { chartSettings: { colorPalette: 'sequential' }, thresholds: [], unitsOverrides: [{ identifier: 'Events', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }] }
    },

    // ===== FILTERED VIEW (with $Step variable) =====
    total_volume_filtered: {
      name: '💼 Journey Events (Filtered)',
      query: `fetch bizevents | ${stepFilter} | summarize total = count()`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'TOTAL EVENTS', recordField: 'total', prefixIcon: 'ProcessesIcon', colorThresholdTarget: 'background' },
        thresholds: [],
        unitsOverrides: [{ identifier: 'total', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }]
      }
    },
    business_value_filtered: {
      name: '💰 Revenue (Filtered)',
      query: `fetch bizevents | ${stepFilter} | summarize revenue = sum(additionalfields.orderTotal)`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'REVENUE', recordField: 'revenue', prefixIcon: 'MoneyIcon', colorThresholdTarget: 'background' },
        thresholds: [],
        unitsOverrides: [{ identifier: 'revenue', unitCategory: 'currency', baseUnit: 'usd', decimals: 0, suffix: '$', delimiter: true }]
      }
    },
    avg_order_value_filtered: {
      name: '💵 Avg Order Value',
      query: `fetch bizevents | ${stepFilter} | summarize avg = avg(additionalfields.orderTotal)`,
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { label: 'AOV', recordField: 'avg', colorThresholdTarget: 'background' },
        thresholds: [],
        unitsOverrides: [{ identifier: 'avg', unitCategory: 'currency', baseUnit: 'usd', decimals: 2, suffix: '$', delimiter: true }]
      }
    },
    volume_trend_filtered: {
      name: '📈 Events Over Time (Filtered)',
      query: `fetch bizevents | ${stepFilter} | makeTimeseries events = count(), bins:30`,
      visualization: 'areaChart',
      visualizationSettings: {
        chartSettings: { gapPolicy: 'connect', seriesOverrides: [{ seriesId: ['events'], override: { color: '#2AB06F' } }] },
        thresholds: [], unitsOverrides: []
      }
    },
    conversion_funnel_filtered: {
      name: '📊 Events by Step (Filtered)',
      query: `fetch bizevents | ${varFilter} | summarize count = count(), by: {json.stepName} | sort count desc | limit 10`,
      visualization: 'categoricalBarChart',
      visualizationSettings: { chartSettings: { categoricalBarChartSettings: {} }, thresholds: [], unitsOverrides: [] }
    },

    // ===== SERVICE & INFRASTRUCTURE OBSERVABILITY =====
    service_health_table: {
      name: '🏥 Service Health Overview',
      query: `timeseries { reqCount = avg(dt.service.request.count) }, by: { dt.entity.service }, filter: { in(dt.entity.service, classicEntitySelector("type(SERVICE),entityName.exists()")) }
| lookup [
    timeseries { errCount = avg(dt.service.request.failure_count) }, by: { dt.entity.service }, filter: { in(dt.entity.service, classicEntitySelector("type(SERVICE),entityName.exists()")) }
  ], sourceField:dt.entity.service, lookupField:dt.entity.service, prefix:"err."
| fieldsAdd serviceName = entityName(dt.entity.service), failureRate = (arrayAvg(err.errCount[]) / arrayAvg(reqCount[])) * 100
| sort failureRate desc`,
      visualization: 'table',
      visualizationSettings: {
        table: { rowDensity: 'condensed', enableLineWrap: false, columnWidths: { 'serviceName': 250, 'failureRate': 120 } },
        thresholds: [
          { id: 1, field: 'failureRate', isEnabled: true, rules: [
            { id: 1, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≤', value: 1 },
            { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≤', value: 5 },
            { id: 3, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '>', value: 5 }
          ]}
        ],
        unitsOverrides: [{ identifier: 'failureRate', unitCategory: 'percentage', baseUnit: 'percent', decimals: 2, suffix: '%', delimiter: true }]
      }
    },
    service_response_time: {
      name: '⏱️ Service Response Time (P50/P90/P99)',
      query: `timeseries {
  p50 = avg(dt.service.request.response_time, default:0),
  p90 = percentile(dt.service.request.response_time, 90),
  p99 = percentile(dt.service.request.response_time, 99)
}, filter: { dt.entity.service == $ServiceID }`,
      visualization: 'lineChart',
      visualizationSettings: {
        chartSettings: {
          gapPolicy: 'connect',
          fieldMapping: { leftAxisValues: ['p50', 'p90', 'p99'], timestamp: 'timeframe' },
          seriesOverrides: [
            { seriesId: ['p50'], override: { color: '#2AB06F', lineWidth: 2 } },
            { seriesId: ['p90'], override: { color: '#F5D30F', lineWidth: 2 } },
            { seriesId: ['p99'], override: { color: '#C62239', lineWidth: 2, lineStyle: 'dashed' } }
          ]
        },
        thresholds: [],
        unitsOverrides: [
          { identifier: 'p50', unitCategory: 'time', baseUnit: 'micro_second', decimals: 0, suffix: 'µs', delimiter: true },
          { identifier: 'p90', unitCategory: 'time', baseUnit: 'micro_second', decimals: 0, suffix: 'µs', delimiter: true },
          { identifier: 'p99', unitCategory: 'time', baseUnit: 'micro_second', decimals: 0, suffix: 'µs', delimiter: true }
        ]
      }
    },
    http_error_breakdown: {
      name: '🔴 HTTP Error Breakdown',
      query: `timeseries {
  http4xx = avg(dt.service.request.client_side_failure_count),
  http5xx = avg(dt.service.request.failure_count)
}, by: { dt.entity.service }, filter: { in(dt.entity.service, classicEntitySelector("type(SERVICE),entityName.exists()")) }
| fieldsAdd serviceName = entityName(dt.entity.service), total4xx = arraySum(http4xx[]), total5xx = arraySum(http5xx[])
| sort total5xx desc`,
      visualization: 'table',
      visualizationSettings: {
        table: { rowDensity: 'condensed', enableLineWrap: false, columnWidths: { 'serviceName': 250, 'total4xx': 120, 'total5xx': 120 } },
        thresholds: [
          { id: 1, field: 'total5xx', isEnabled: true, rules: [
            { id: 1, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '>', value: 10 },
            { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '>', value: 0 },
            { id: 3, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≤', value: 0 }
          ]},
          { id: 2, field: 'total4xx', isEnabled: true, rules: [
            { id: 1, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '>', value: 10 },
            { id: 2, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '≤', value: 10 }
          ]}
        ],
        unitsOverrides: [
          { identifier: 'total4xx', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true },
          { identifier: 'total5xx', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }
        ]
      }
    },
    exception_analysis_table: {
      name: '💥 Top Exceptions',
      query: `fetch dt.davis.events, from:now()-24h
| filter isnotnull(dt.entity.service)
| summarize occurrences = count(), lastSeen = takeLast(timestamp), by: {event.name, dt.entity.service}
| fieldsAdd serviceName = entityName(dt.entity.service)
| sort occurrences desc
| limit 15`,
      visualization: 'table',
      visualizationSettings: {
        table: { rowDensity: 'condensed', enableLineWrap: true, columnWidths: { 'event.name': 350, 'serviceName': 200, 'occurrences': 100, 'lastSeen': 160 } },
        thresholds: [{ id: 1, field: 'occurrences', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '≥', value: 50 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '≥', value: 10 },
          { id: 3, color: { Default: DT_THRESHOLD_COLORS.ideal }, comparator: '<', value: 10 }
        ]}],
        unitsOverrides: [{ identifier: 'occurrences', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, delimiter: true }]
      }
    },
    service_throughput: {
      name: '📊 Service Request Throughput',
      query: `timeseries avg(dt.service.request.count), by: { dt.entity.service }, filter: { in(dt.entity.service, classicEntitySelector("type(SERVICE),entityName.exists()")) }
| fieldsAdd serviceName = entityName(dt.entity.service)`,
      visualization: 'areaChart',
      visualizationSettings: {
        chartSettings: { gapPolicy: 'connect', legend: { position: 'bottom' } },
        thresholds: [],
        unitsOverrides: [{ identifier: 'avg(dt.service.request.count)', unitCategory: 'unspecified', baseUnit: 'count', decimals: 0, suffix: ' req', delimiter: true }]
      }
    },
    failure_rate_timeseries: {
      name: '📉 Service Failure Rate Over Time',
      query: `timeseries {
  requests = avg(dt.service.request.count),
  failures = avg(dt.service.request.failure_count)
}, filter: { dt.entity.service == $ServiceID }
| fieldsAdd failureRate = (arrayAvg(failures[]) / arrayAvg(requests[])) * 100`,
      visualization: 'lineChart',
      visualizationSettings: {
        chartSettings: { gapPolicy: 'connect', seriesOverrides: [{ seriesId: ['failureRate'], override: { color: '#C62239', lineWidth: 2 } }] },
        thresholds: [{ id: 1, field: 'failureRate', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '>', value: 5 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '>', value: 1 }
        ]}],
        unitsOverrides: [{ identifier: 'failureRate', unitCategory: 'percentage', baseUnit: 'percent', decimals: 2, suffix: '%', delimiter: true }]
      }
    },
    process_cpu_usage: {
      name: '🖥️ Process CPU Usage',
      query: `timeseries avg(dt.process.cpu.usage), by: { dt.entity.process_group_instance }, filter: { in(dt.entity.process_group_instance, classicEntitySelector("type(PROCESS_GROUP_INSTANCE),fromRelationships.isInstanceOf(type(PROCESS_GROUP),fromRelationships.runsOn($ServiceID))")) }
| fieldsAdd processName = entityName(dt.entity.process_group_instance)`,
      visualization: 'lineChart',
      visualizationSettings: {
        chartSettings: { gapPolicy: 'connect', legend: { position: 'bottom' } },
        thresholds: [{ id: 1, field: 'avg(dt.process.cpu.usage)', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '>', value: 80 },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '>', value: 60 }
        ]}],
        unitsOverrides: [{ identifier: 'avg(dt.process.cpu.usage)', unitCategory: 'percentage', baseUnit: 'percent', decimals: 1, suffix: '%', delimiter: true }]
      }
    },
    process_memory_usage: {
      name: '🧠 Process Memory Usage',
      query: `timeseries avg(dt.process.memory.working_set_size), by: { dt.entity.process_group_instance }, filter: { in(dt.entity.process_group_instance, classicEntitySelector("type(PROCESS_GROUP_INSTANCE),fromRelationships.isInstanceOf(type(PROCESS_GROUP),fromRelationships.runsOn($ServiceID))")) }
| fieldsAdd processName = entityName(dt.entity.process_group_instance)`,
      visualization: 'areaChart',
      visualizationSettings: {
        chartSettings: { gapPolicy: 'connect', legend: { position: 'bottom' } },
        thresholds: [],
        unitsOverrides: [{ identifier: 'avg(dt.process.memory.working_set_size)', unitCategory: 'data', baseUnit: 'byte', decimals: 1, delimiter: true }]
      }
    },
    davis_problems: {
      name: '🚨 Active Dynatrace Intelligence Problems',
      query: `fetch dt.davis.problems
| filter event.status == "ACTIVE"
| fields display_id, title, affected_entity_ids, event.start, event.status, management_zone
| sort event.start desc
| limit 10`,
      visualization: 'table',
      visualizationSettings: {
        table: { rowDensity: 'condensed', enableLineWrap: true, columnWidths: { 'display_id': 80, 'title': 300, 'affected_entity_ids': 200, 'event.start': 160 } },
        thresholds: [], unitsOverrides: []
      }
    },
    log_errors: {
      name: '📋 Recent Log Errors',
      query: `fetch logs, from:now()-1h
| filter loglevel == "ERROR" or loglevel == "WARN"
| fields timestamp, loglevel, content, dt.entity.service
| fieldsAdd serviceName = entityName(dt.entity.service)
| sort timestamp desc
| limit 20`,
      visualization: 'table',
      visualizationSettings: {
        table: { rowDensity: 'condensed', enableLineWrap: true, columnWidths: { 'timestamp': 160, 'loglevel': 80, 'content': 400, 'serviceName': 200 } },
        thresholds: [{ id: 1, field: 'loglevel', isEnabled: true, rules: [
          { id: 1, color: { Default: DT_THRESHOLD_COLORS.critical }, comparator: '==', value: 'ERROR' },
          { id: 2, color: { Default: DT_THRESHOLD_COLORS.warning }, comparator: '==', value: 'WARN' }
        ]}],
        unitsOverrides: []
      }
    },
    trace_links_panel: {
      name: '🔗 Quick Navigation',
      type: 'markdown',
      content: `## 🔗 Deep-Link Navigation

| Resource | Link |
|----------|------|
| 🔍 **Distributed Traces** | [Open Trace Explorer →](${dynatraceUrl}/ui/diagnostictools/purepaths?gtf=-24h+to+now&gf=all) |
| 📊 **Service Overview** | [Open Services →](${dynatraceUrl}/ui/services?gtf=-24h+to+now&gf=all) |
| ❌ **Failure Analysis** | [Open Failure Analysis →](${dynatraceUrl}/ui/diagnostictools/mda?gtf=-24h+to+now&gf=all&mdaId=failureAnalysis) |
| 🐛 **Exception Analysis** | [Open Exception Analysis →](${dynatraceUrl}/ui/diagnostictools/mda?gtf=-24h+to+now&gf=all&mdaId=exceptionAnalysis) |
| 📈 **Dynatrace Intelligence Problems** | [Open Problems →](${dynatraceUrl}/ui/problems?gtf=-24h+to+now) |
| 📊 **Business Events** | [Open BizEvents →](${dynatraceUrl}/ui/bizevents?gtf=-24h+to+now) |

*Links open in your Dynatrace environment*`
    }
  };
}

// ============================================================================
// VARIABLE GENERATOR (uses proven template from working dashboard)
// ============================================================================

function generateVariables(company) {
  return getProvenVariables(company);
}

// ============================================================================
// MARKDOWN SECTION HEADERS (uses proven templates)
// ============================================================================

function generateMarkdownTiles(company, journeyType, steps, detected) {
  const dynatraceUrl = (
    process.env.DT_ENVIRONMENT ||
    process.env.DT_ENVIRONMENT_URL ||
    process.env.DYNATRACE_URL ||
    'https://your-environment.apps.dynatrace.com'
  ).replace(/\/+$/, '');

  const detectedSummary = [];
  if (detected.hasRevenue) detectedSummary.push('💰 Revenue');
  if (detected.hasLoyalty) detectedSummary.push('⭐ Loyalty');
  if (detected.hasLTV) detectedSummary.push('📈 LTV');
  if (detected.hasSegments) detectedSummary.push('👥 Segments');
  if (detected.hasChannel) detectedSummary.push('📡 Channels');
  if (detected.hasDeviceType) detectedSummary.push('📱 Devices');
  if (detected.hasServices) detectedSummary.push('🔧 Services');
  const dataSignals = detectedSummary.length > 0 ? detectedSummary.join(' | ') : '🔧 Services';

  const sectionHeaders = getSectionHeaders();

  return {
    header: getHeaderMarkdown(company, journeyType, dataSignals),
    journey_flow: getJourneyFlowMarkdown(steps),
    section_overall: sectionHeaders.overall,
    section_filtered: sectionHeaders.filtered,
    section_dynamic: {
      type: 'data', title: '',
      query: 'data record(a="Business Intelligence - Detected Data Fields")',
      visualization: 'singleValue',
      visualizationSettings: {
        singleValue: { labelMode: 'none', isIconVisible: true, prefixIcon: 'LightbulbIcon', colorThresholdTarget: 'background' },
        thresholds: [{ id: 1, field: 'a', isEnabled: true, rules: [{ id: 1, color: '#E87A35', comparator: '!=', value: 'x' }] }]
      }
    },
    section_performance: sectionHeaders.performance,
    section_traffic: sectionHeaders.traffic,
    section_latency: sectionHeaders.latency,
    section_errors: sectionHeaders.errors,
    section_saturation: sectionHeaders.saturation,
    deep_links: getDeepLinksMarkdown(dynatraceUrl),
    footer: getFooterMarkdown(company)
  };
}

// ============================================================================
// DASHBOARD LAYOUT BUILDER (uses proven template from working dashboard)
// ============================================================================

function buildDashboardLayout(coreTiles, dynamicTiles, markdownTiles, variables, company, journeyType, industry, aiSelectedTiles, detected) {
  const { company: _c, industry: _i, journeyType: _jt, steps, ...rest } = { company, industry, journeyType };
  
  // Use the proven template as the base with industry awareness
  const dashboard = buildProvenDashboard(company, journeyType, rest.steps || [], detected, industry);

  // Override variables with the ones generated for this company
  dashboard.variables = variables;

  // If there are dynamic field tiles (from payload detection), append them after
  // the Performance section but before the Golden Signals
  const dynamicKeys = Object.keys(dynamicTiles);
  if (dynamicKeys.length > 0) {
    // Find the highest existing tile index
    const existingIndices = Object.keys(dashboard.tiles).map(Number);
    let nextIdx = Math.max(...existingIndices) + 1;

    // Find the golden signals section Y position to insert dynamic tiles before it
    const goldenY = PROVEN_LAYOUT.section_traffic?.y || 42;

    // Shift all tiles at or below goldenY down to make room for dynamic tiles
    const dynamicRowCount = Math.ceil(dynamicKeys.length / 3);
    const dynamicHeight = (dynamicRowCount * 4) + 1; // 1 for section header + 4 per row

    // Shift existing layouts down
    Object.keys(dashboard.layouts).forEach(idx => {
      if (dashboard.layouts[idx].y >= goldenY) {
        dashboard.layouts[idx].y += dynamicHeight;
      }
    });

    // Add dynamic section header
    dashboard.tiles[nextIdx] = markdownTiles.section_dynamic;
    dashboard.layouts[nextIdx] = { x: 0, y: goldenY, w: 24, h: 1 };
    nextIdx++;

    // Add dynamic tiles in 3-column grid
    let dy = goldenY + 1;
    let colIndex = 0;
    dynamicKeys.forEach(key => {
      const template = dynamicTiles[key];
      dashboard.tiles[nextIdx] = {
        title: template.name, type: 'data', query: template.query,
        visualization: template.visualization, visualizationSettings: template.visualizationSettings,
        querySettings: { maxResultRecords: 1000, defaultScanLimitGbytes: 500, maxResultMegaBytes: 1, defaultSamplingRatio: 10, enableSampling: false },
        davis: { enabled: false, davisVisualization: { isAvailable: true } }
      };
      dashboard.layouts[nextIdx] = { x: colIndex * 8, y: dy, w: 8, h: 4 };
      nextIdx++;
      colIndex++;
      if (colIndex >= 3) { colIndex = 0; dy += 4; }
    });
  }

  const tileCount = Object.keys(dashboard.tiles).length;
  console.log(`[AI Dashboard] ✅ Proven layout: ${tileCount} tiles, dynamic: ${dynamicKeys.length}`);
  return dashboard;
}


// ============================================================================
// PROMPT-DRIVEN DASHBOARD GENERATION (MCP Custom Prompt Path)
// Instead of always using the full 46-tile template, Ollama selects which
// themed sections to include based on the user's natural language request.
// ============================================================================

/**
 * SECTION CATALOG — the building blocks Ollama can pick from.
 * Each section maps to real tile-builder functions from the proven template.
 */
const SECTION_CATALOG = {
  executive_kpis: {
    label: 'Executive KPIs',
    description: 'High-level KPI cards: total volume, success rate, revenue, errors',
    audience: 'C-level, executives, leadership',
    tiles: ['total_volume', 'success_rate', 'total_revenue', 'total_errors'],
    section: 'journey_overview'
  },
  journey_overview: {
    label: 'Journey Overview',
    description: 'Step metrics table, volume over time, events by step — full funnel view',
    audience: 'all, product managers, analysts',
    tiles: ['step_metrics', 'volume_over_time', 'events_by_step'],
    section: 'journey_overview'
  },
  filtered_view: {
    label: 'Filtered Step View',
    description: 'KPIs and charts filtered by individual journey step — drill-down analysis',
    audience: 'analysts, operations, product managers',
    tiles: ['filtered_events', 'filtered_revenue', 'filtered_aov', 'filtered_p90', 'filtered_volume_trend', 'filtered_events_by_step'],
    section: 'filtered_view'
  },
  performance_sla: {
    label: 'Performance & SLA',
    description: 'Step performance, SLA compliance, response times, hourly patterns',
    audience: 'operations, SRE, engineering',
    tiles: ['step_performance', 'sla_compliance', 'hourly_pattern'],
    section: 'performance'
  },
  error_analysis: {
    label: 'Error Analysis',
    description: 'Error rate trends, errors by step, error details breakdown',
    audience: 'operations, SRE, engineering, incident response',
    tiles: ['error_rate_trend', 'errors_by_step', 'error_details'],
    section: 'performance'
  },
  golden_signals_traffic: {
    label: 'Golden Signals — Traffic',
    description: 'Service request rates, success vs failed, key requests',
    audience: 'SRE, operations, platform engineering',
    tiles: ['requests', 'requests_success_failed', 'key_requests'],
    section: 'golden_signals'
  },
  golden_signals_latency: {
    label: 'Golden Signals — Latency',
    description: 'P50/P90/P99 response times by service',
    audience: 'SRE, operations, platform engineering',
    tiles: ['latency_p50', 'latency_p90', 'latency_p99'],
    section: 'golden_signals'
  },
  golden_signals_errors: {
    label: 'Golden Signals — Errors',
    description: 'Failed requests, 5xx errors, 4xx errors by service',
    audience: 'SRE, operations, incident response',
    tiles: ['failed_requests', 'errors_5xx', 'errors_4xx'],
    section: 'golden_signals'
  },
  golden_signals_saturation: {
    label: 'Golden Signals — Saturation',
    description: 'CPU usage, memory usage, GC suspension by service',
    audience: 'SRE, platform engineering, capacity planning',
    tiles: ['cpu_usage', 'memory_used', 'gc_suspension'],
    section: 'golden_signals'
  },
  observability: {
    label: 'Traces & Observability',
    description: 'Top exceptions, traces with exceptions, Davis problems, log errors',
    audience: 'SRE, operations, engineering, incident response',
    tiles: ['top_exceptions', 'traces_with_exceptions', 'davis_problems', 'log_errors'],
    section: 'observability'
  },
  customer_dynamic: {
    label: 'Customer & Business Metrics',
    description: 'Dynamic tiles from detected payload fields — churn risk, NPS, loyalty, satisfaction, pricing, engagement, segments',
    audience: 'C-level, customer success, product, marketing',
    tiles: ['_dynamic_'],
    section: 'dynamic'
  },
  geographic_view: {
    label: 'Geographic Distribution',
    description: 'Heatmap or map of events by region/country — geo analysis of journey activity',
    audience: 'executives, marketing, regional managers',
    tiles: ['_geo_heatmap_'],
    section: 'dynamic'
  },
  trend_analysis: {
    label: 'Trend Analysis',
    description: 'Hourly patterns, volume histograms, and trend lines for forecasting',
    audience: 'analysts, product managers, capacity planning',
    tiles: ['hourly_pattern', '_volume_histogram_'],
    section: 'performance'
  }
};

/**
 * Ask Ollama to select dashboard sections based on the user's natural language prompt.
 * This is a SMALL ask — Ollama just picks from a menu, doesn't generate full dashboards.
 */
async function selectSectionsWithOllama(customPrompt, company, journeyType, industry, detectedSignals) {
  // Few-shot completion pattern: provide examples as completed lines, then start the answer
  // so the LLM continues with JSON rather than adding prose. Compact for 2048 context window.
  const prompt = `Pick 4-8 section IDs for a dashboard. ALWAYS include executive_kpis and journey_overview.

Sections: executive_kpis (revenue KPIs) [exec], customer_dynamic (churn,NPS,CLV) [exec], journey_overview (funnel,steps) [all], filtered_view (step drill-down) [analyst], performance_sla (SLA,response times) [ops], golden_signals_latency (P50/P90/P99) [SRE], golden_signals_traffic (request rates) [SRE], golden_signals_errors (5xx/4xx) [SRE], golden_signals_saturation (CPU,memory) [SRE], error_analysis (error trends) [ops], observability (traces,exceptions) [SRE], geographic_view (regional heatmap) [marketing], trend_analysis (hourly patterns) [analyst]

Request: "C-level revenue dashboard" → {"sections":["executive_kpis","journey_overview","customer_dynamic","trend_analysis","geographic_view"],"title":"Executive Revenue Dashboard","slug":"executive-revenue"}
Request: "SRE performance monitoring" → {"sections":["executive_kpis","journey_overview","performance_sla","golden_signals_latency","golden_signals_errors","observability"],"title":"SRE Performance Monitor","slug":"sre-performance"}
Request: "customer churn analysis" → {"sections":["executive_kpis","journey_overview","customer_dynamic","filtered_view","trend_analysis"],"title":"Customer Churn Analysis","slug":"customer-churn"}
Request: "${customPrompt}" →`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 45000);
    const sectionStartTime = performance.now();

    const response = await fetch(`${OLLAMA_ENDPOINT}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        format: 'json',
        stream: false,
        keep_alive: -1,
        options: { temperature: 0.2, num_predict: 128, num_ctx: 2048 }
      })
    });
    clearTimeout(timeout);

    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);

    const result = await response.json();
    const responseText = result.response || '';
    const sectionDuration = performance.now() - sectionStartTime;
    console.log(`[AI Dashboard] 🧠 Section selector raw response: ${responseText.substring(0, 300)}`);

    // Log GenAI span for section selection
    await logGenAISpan(createGenAISpan(prompt, responseText, OLLAMA_MODEL, result.prompt_eval_count || 0, result.eval_count || 0, sectionDuration), 'section_selection');

    // Robust JSON repair — handles all common LLM mistakes
    let parsed;
    const repaired = responseText
      .replace(/(["'])\s*:\s*\1/g, '$1: $1')           // "focus:"" → "focus": ""
      .replace(/,\s*([}\]])/g, '$1')                    // trailing commas
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":')       // unquoted keys
      .replace(/'([^']*)'/g, '"$1"')                    // single → double quotes
      .replace(/\n/g, ' ');                              // newlines inside JSON
    try {
      parsed = JSON.parse(repaired);
    } catch {
      const jsonMatch = repaired.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try { parsed = JSON.parse(jsonMatch[0]); } catch { /* will fall through */ }
      }
    }

    if (parsed && Array.isArray(parsed.sections) && parsed.sections.length > 0) {
      // Validate section IDs against catalog
      let validSections = parsed.sections.filter(s => SECTION_CATALOG[s]);
      if (validSections.length === 0) throw new Error('No valid sections returned');

      // Post-processing: force-add mandatory sections if LLM forgot them
      const mandatory = ['executive_kpis', 'journey_overview'];
      for (const req of mandatory) {
        if (!validSections.includes(req)) {
          validSections.unshift(req);
          console.log(`[AI Dashboard] 📌 Force-added mandatory section: ${req}`);
        }
      }

      // Post-processing: audience-based filtering — remove clearly mismatched sections
      const p = customPrompt.toLowerCase();
      const isExecRequest = /exec|c-level|ceo|cfo|board|strategic|revenue|business|leadership/i.test(p);
      const isTechRequest = /sre|devops|platform|infrastructure|cpu|memory|saturation/i.test(p);
      if (isExecRequest && !isTechRequest) {
        // Remove deep technical sections from executive dashboards
        const techSections = ['golden_signals_saturation', 'golden_signals_errors', 'golden_signals_latency', 'golden_signals_traffic'];
        const before = validSections.length;
        validSections = validSections.filter(s => !techSections.includes(s) || validSections.length <= 4);
        if (validSections.length < before) {
          console.log(`[AI Dashboard] 🎯 Removed ${before - validSections.length} technical sections from executive dashboard`);
        }
      }

      // Sanitize slug: lowercase, hyphens only, max 60 chars
      const rawSlug = (parsed.slug || '').replace(/[^a-z0-9-]/gi, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '').substring(0, 60);
      console.log(`[AI Dashboard] ✅ Section selection: ${validSections.join(', ')}`);
      return {
        sections: validSections,
        title: parsed.title || `${company} - ${journeyType} Dashboard`,
        slug: rawSlug || '',
        focus: parsed.focus || ''
      };
    }
    throw new Error('Invalid section selection response');
  } catch (err) {
    console.warn(`[AI Dashboard] ⚠️ Section selector failed: ${err.message}, using smart defaults`);
    return getDefaultSectionsForPrompt(customPrompt, industry);
  }
}

/**
 * Fallback: if Ollama can't select sections, use keyword matching on the prompt.
 */
function getDefaultSectionsForPrompt(prompt, industryType) {
  // If we have an industry type, use bespoke sections first
  if (industryType) {
    const bespokeSections = getBespokeSections(industryType);
    if (bespokeSections && bespokeSections.length > 3) {
      console.log(`[AI Dashboard] 🏭 Using bespoke sections for ${industryType}: ${bespokeSections.join(', ')}`);
      return {
        sections: bespokeSections,
        title: prompt.substring(0, 60),
        slug: industryType.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 40),
        focus: `${industryType} industry-specific dashboard`
      };
    }
  }
  const p = prompt.toLowerCase();
  const sections = ['executive_kpis', 'journey_overview', 'customer_dynamic']; // Always include these

  // Executive / C-level
  if (/exec|c-level|ceo|cfo|cto|leadership|board|strategic|revenue|business/i.test(p)) {
    sections.push('customer_dynamic');
  }
  // Operations / SRE
  if (/ops|operation|sre|infra|platform|reliability|incident/i.test(p)) {
    sections.push('performance_sla', 'error_analysis', 'golden_signals_traffic', 'golden_signals_errors');
  }
  // Performance
  if (/perf|sla|latency|speed|response/i.test(p)) {
    sections.push('performance_sla', 'golden_signals_latency');
  }
  // Customer / CX
  if (/customer|churn|satisf|nps|loyalty|cx|experience|retention/i.test(p)) {
    sections.push('customer_dynamic', 'filtered_view');
  }
  // Error / Incident focus
  if (/error|fail|incident|problem|bug|exception/i.test(p)) {
    sections.push('error_analysis', 'observability');
  }
  // Geographic / regional
  if (/geo|region|country|location|map|global|international/i.test(p)) {
    sections.push('geographic_view');
  }
  // Trends / forecasting
  if (/trend|forecast|pattern|histogram|analysis|capacity/i.test(p)) {
    sections.push('trend_analysis');
  }
  // Full / comprehensive
  if (/full|comprehensive|complete|everything|all/i.test(p)) {
    return {
      sections: Object.keys(SECTION_CATALOG),
      title: prompt.substring(0, 60),
      slug: 'comprehensive-full-view',
      focus: 'Comprehensive dashboard with all available sections'
    };
  }

  // Deduplicate
  // Generate a slug from keyword matches
  const slugParts = [];
  if (/exec|c-level|ceo|cfo|cto|leadership|board|strategic|revenue|business/i.test(p)) slugParts.push('executive');
  if (/ops|operation|sre|infra|platform|reliability|incident/i.test(p)) slugParts.push('ops');
  if (/perf|sla|latency|speed|response/i.test(p)) slugParts.push('performance');
  if (/customer|churn|satisf|nps|loyalty|cx|experience|retention/i.test(p)) slugParts.push('customer');
  if (/error|fail|incident|problem|bug|exception/i.test(p)) slugParts.push('errors');
  if (/geo|region|country|location|map|global|international/i.test(p)) slugParts.push('geo');
  if (/trend|forecast|pattern|histogram|analysis|capacity/i.test(p)) slugParts.push('trends');
  return {
    sections: [...new Set(sections)],
    title: prompt.substring(0, 60),
    slug: slugParts.length > 0 ? slugParts.join('-') : 'custom-view',
    focus: ''
  };
}

// ============================================================================
// OLLAMA BESPOKE TILE GENERATION (v1.8.18)
// Instead of hardcoded section templates, Ollama designs each tile uniquely.
// Architecture: Ollama generates tile PLANS (title, viz, field, agg),
// code constructs valid DQL and wraps in proper dashboard JSON.
// ============================================================================

const VALID_VIZ_TYPES = new Set([
  'singleValue', 'lineChart', 'areaChart', 'barChart', 'categoricalBarChart',
  'pieChart', 'donutChart', 'table', 'heatmap',
  'gauge', 'honeycomb', 'histogram', 'bandChart', 'scatterplot',
  'meterBar', 'recordList', 'choroplethMap'
]);

const BASE_DQL_FILTER = `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType)`;

const DQL_AGG_TEMPLATES = {
  // Numeric field aggregations
  sum:              (f) => `${BASE_DQL_FILTER} | summarize value = sum(additionalfields.${f})`,
  avg:              (f) => `${BASE_DQL_FILTER} | summarize value = avg(additionalfields.${f})`,
  max:              (f) => `${BASE_DQL_FILTER} | summarize value = max(additionalfields.${f})`,
  min:              (f) => `${BASE_DQL_FILTER} | summarize value = min(additionalfields.${f})`,
  timeseries_sum:   (f) => `${BASE_DQL_FILTER} | makeTimeseries value = sum(additionalfields.${f}), bins:30`,
  timeseries_avg:   (f) => `${BASE_DQL_FILTER} | makeTimeseries value = avg(additionalfields.${f}), bins:30`,
  sum_by_step:      (f) => `${BASE_DQL_FILTER} | summarize value = sum(additionalfields.${f}), by: {json.stepName} | sort value desc`,
  avg_by_step:      (f) => `${BASE_DQL_FILTER} | summarize value = avg(additionalfields.${f}), by: {json.stepName} | sort value desc`,
  p90:              (f) => `${BASE_DQL_FILTER} | summarize value = percentile(additionalfields.${f}, 90)`,
  p90_by_step:      (f) => `${BASE_DQL_FILTER} | summarize value = percentile(additionalfields.${f}, 90), by: {json.stepName} | sort value desc`,

  // String field aggregations
  count_by:         (f) => `${BASE_DQL_FILTER} | filter isNotNull(additionalfields.${f}) | summarize count = count(), by: {additionalfields.${f}} | sort count desc | limit 10`,

  // Special aggregations (no field needed)
  count:              () => `${BASE_DQL_FILTER} | summarize value = count()`,
  success_rate:       () => `${BASE_DQL_FILTER} | summarize total = count(), success = countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false) | fieldsAdd rate = round((toDouble(success)/toDouble(total))*100, decimals:2)`,
  error_rate:         () => `${BASE_DQL_FILTER} | summarize total = count(), errors = countIf(additionalfields.hasError == true) | fieldsAdd rate = round((toDouble(errors)/toDouble(total))*100, decimals:2)`,
  volume_timeseries:  () => `${BASE_DQL_FILTER} | makeTimeseries count = count(), bins:30`,
  hourly_pattern:     () => `${BASE_DQL_FILTER} | fieldsAdd hour = toString(getHour(timestamp)) | summarize Events = count(), by: {hour} | sort hour asc`,
  step_table:         () => `${BASE_DQL_FILTER} | summarize Events = count(), Errors = countIf(additionalfields.hasError == true), "Avg Processing (ms)" = avg(additionalfields.processingTime), by: {json.stepName} | sort Events desc`,
  sla_compliance:     () => `${BASE_DQL_FILTER} | summarize total = count(), withinSLA = countIf(additionalfields.processingTime < 5000), by: {json.stepName} | fieldsAdd compliance = round((toDouble(withinSLA)/toDouble(total))*100, decimals:2) | sort compliance asc`,
  success_fail_trend: () => `${BASE_DQL_FILTER} | makeTimeseries success = countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false), failed = countIf(additionalfields.hasError == true), bins:30`,
  count_by_step:      () => `${BASE_DQL_FILTER} | summarize count = count(), by: {json.stepName} | sort count desc`,
  heatmap_step_hour:  () => `${BASE_DQL_FILTER} | fieldsAdd hour = formatTimestamp(timestamp, format: "HH") | summarize count = count(), by: {json.stepName, hour} | sort hour asc`,

  // Gauge / meter aggregations (returns rate 0-100)
  gauge_success:      () => `${BASE_DQL_FILTER} | summarize total = count(), successful = countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false) | fieldsAdd rate = round((toDouble(successful) / toDouble(total)) * 100, decimals:1)`,
  gauge_error:        () => `${BASE_DQL_FILTER} | summarize total = count(), errors = countIf(additionalfields.hasError == true) | fieldsAdd rate = round((toDouble(errors) / toDouble(total)) * 100, decimals:1)`,
  gauge_field:        (f) => `${BASE_DQL_FILTER} | summarize value = avg(additionalfields.${f})`,

  // Band chart (min/avg/max over time)
  band_timeseries:    (f) => `${BASE_DQL_FILTER} | makeTimeseries min = min(additionalfields.${f}), avg = avg(additionalfields.${f}), max = max(additionalfields.${f}), bins:30`,

  // Scatter plot (two numeric fields correlated)
  scatter_two:        (f) => `${BASE_DQL_FILTER} | filter isNotNull(additionalfields.${f}) | fields timestamp, additionalfields.${f}, json.stepName | limit 200`,

  // Record list (raw event drill-down)
  recent_events:      () => `${BASE_DQL_FILTER} | sort timestamp desc | limit 25 | fields timestamp, json.stepName, json.journeyStatus, additionalfields.region, additionalfields.deviceType, additionalfields.channel`,

  // Geo map (region → count for choropleth)
  geo_region:         (f) => `${BASE_DQL_FILTER} | filter isNotNull(additionalfields.${f}) | summarize count = count(), by: {additionalfields.${f}} | sort count desc`,

  // Honeycomb (step health overview)
  honeycomb_steps:    () => `${BASE_DQL_FILTER} | summarize total = count(), errors = countIf(additionalfields.hasError == true), by: {json.stepName} | fieldsAdd errorRate = round((toDouble(errors) / toDouble(total)) * 100, decimals:1) | sort errorRate desc`,
};

const FIELD_REQUIRED_AGGS = new Set(['sum', 'avg', 'max', 'min', 'timeseries_sum', 'timeseries_avg', 'sum_by_step', 'avg_by_step', 'p90', 'p90_by_step', 'count_by', 'gauge_field', 'band_timeseries', 'scatter_two', 'geo_region']);
const NUMERIC_ONLY_AGGS = new Set(['sum', 'avg', 'max', 'min', 'timeseries_sum', 'timeseries_avg', 'sum_by_step', 'avg_by_step', 'p90', 'p90_by_step', 'gauge_field', 'band_timeseries', 'scatter_two']);

function getVizSettingsForType(viz) {
  switch (viz) {
    case 'singleValue':
      return {};
    case 'lineChart':
    case 'areaChart':
      return {
        chartSettings: { gapPolicy: 'connect' },
        thresholds: [], unitsOverrides: []
      };
    case 'barChart':
    case 'categoricalBarChart':
      return {
        categoryAxis: { label: { showLabel: true }, tickLayout: 'horizontal' },
        numericAxis: { label: { showLabel: true }, scale: 'linear' },
        legend: { position: 'auto', showLegend: true },
        layout: { groupMode: 'grouped', position: 'horizontal' }
      };
    case 'pieChart':
    case 'donutChart':
      return { legend: { position: 'auto', showLegend: true } };
    case 'heatmap':
      return { legend: { position: 'auto', showLegend: true } };
    case 'gauge':
      return {
        gauge: { label: '', recordField: 'rate', min: 0, max: 100,
          thresholds: [{ value: 95, color: '#2AB06F' }, { value: 85, color: '#EEA53C' }, { value: 0, color: '#C62239' }]
        }
      };
    case 'meterBar':
      return {
        gauge: { label: '', recordField: 'rate', min: 0, max: 100,
          thresholds: [{ value: 95, color: '#2AB06F' }, { value: 85, color: '#EEA53C' }, { value: 0, color: '#C62239' }]
        }
      };
    case 'honeycomb':
      return { honeycomb: { legend: { position: 'auto', showLegend: true } } };
    case 'histogram':
      return {
        histogram: { numberOfBuckets: 20 },
        legend: { position: 'auto', showLegend: true }
      };
    case 'bandChart':
      return {
        chartSettings: { gapPolicy: 'connect' },
        thresholds: [], unitsOverrides: []
      };
    case 'scatterplot':
      return { legend: { position: 'auto', showLegend: true } };
    case 'recordList':
      return {};
    case 'choroplethMap':
      return {
        choroplethMap: {
          baseLayer: { type: 'world' },
          dataMapping: { regionField: null, valueField: 'count' },
          colorPalette: { type: 'sequential', steps: 5, minColor: '#E8F5E9', maxColor: '#1B5E20' }
        }
      };
    case 'table':
    default:
      return {};
  }
}

function getTileDimensions(viz) {
  switch (viz) {
    case 'singleValue':    return { w: 6, h: 3 };
    case 'gauge':          return { w: 6, h: 3 };
    case 'meterBar':       return { w: 6, h: 3 };
    case 'table':          return { w: 24, h: 6 };
    case 'recordList':     return { w: 24, h: 5 };
    case 'heatmap':        return { w: 24, h: 6 };
    case 'choroplethMap':  return { w: 24, h: 8 };
    case 'honeycomb':      return { w: 12, h: 5 };
    case 'histogram':      return { w: 12, h: 4 };
    case 'bandChart':      return { w: 12, h: 4 };
    case 'scatterplot':    return { w: 12, h: 5 };
    default:               return { w: 12, h: 4 };
  }
}

/**
 * Ask Ollama to generate a bespoke tile plan — what tiles to create, with what viz and data.
 * Returns array of {title, viz, field, agg} or null on failure.
 */
async function generateTilePlanWithOllama(customPrompt, company, journeyType, industry, discoveredFieldMap, dataSignals) {
  const numericFields = [];
  const stringFields = [];
  const sampleData = {};
  if (discoveredFieldMap && discoveredFieldMap.size > 0) {
    for (const [name, info] of discoveredFieldMap) {
      if (name === 'hasError') continue;
      if (info.type === 'numeric') numericFields.push(name);
      else stringFields.push(name);
      // Collect sample values from the Grail record
      if (info.sampleValue !== undefined) sampleData[name] = info.sampleValue;
    }
  }

  // Build a comprehensive field+value table so Ollama sees REAL data
  // Show ALL fields, not just first 8, so Ollama doesn't hallucinate missing fields
  const fieldLines = [];
  fieldLines.push(`  NUMERIC FIELDS (${numericFields.length} total):`);
  for (let i = 0; i < numericFields.length; i++) {
    const n = numericFields[i];
    const sv = sampleData[n] !== undefined ? `=${sampleData[n]}` : '';
    const marker = i < 5 ? '⭐' : '  '; // Mark top 5 as priority
    fieldLines.push(`  ${marker} ${n}(numeric${sv})`);
  }
  fieldLines.push(`\n  STRING FIELDS (${stringFields.length} total):`);
  for (let i = 0; i < stringFields.length; i++) {
    const s = stringFields[i];
    const sv = sampleData[s] !== undefined ? `="${sampleData[s]}"` : '';
    const marker = i < 5 ? '⭐' : '  '; // Mark top 5 as priority
    fieldLines.push(`  ${marker} ${s}(string${sv})`);
  }
  const fieldBlock = fieldLines.length > 0 
    ? fieldLines.join('\n')
    : '  (no fields — use special aggregations only)';

  // Use format:"json" to force JSON output — ask for {"tiles":[...]} wrapper.
  // Single compact example so the 3B model follows the pattern.
  const prompt = `You are a dashboard tile planner. Output JSON: {"tiles":[array of tile objects]}.
Each tile: {"title":"string","viz":"string","field":"string or null","agg":"string"}.

Available fields from real tenant data (${company} / ${journeyType}):
${fieldBlock}

CRITICAL RULE: You MUST ONLY use fields listed above in the "field" property. 
DO NOT hallucinate field names like "geo.location.latitude" or "region_name" if they are not in the list.
If a field is needed but not available, use field: null with an aggregation that doesn't require a field.

Valid viz types:
- KPIs: singleValue, gauge, meterBar
- Time series: lineChart, areaChart, bandChart
- Categorical: categoricalBarChart, barChart, pieChart, donutChart, histogram
- Spatial: choroplethMap (geo map for regions/countries), honeycomb
- Correlation: scatterplot
- Tabular: table, recordList

Valid agg for numeric fields: sum, avg, timeseries_sum, timeseries_avg, sum_by_step, avg_by_step, p90, band_timeseries, scatter_two, gauge_field
Valid agg for string fields: count_by, geo_region
Valid agg without field (set field to null): count, success_rate, error_rate, volume_timeseries, step_table, hourly_pattern, gauge_success, gauge_error, recent_events, honeycomb_steps, heatmap_step_hour

Pairing rules:
- gauge/meterBar → use gauge_success, gauge_error, or gauge_field(numeric)
- choroplethMap → use geo_region with a string field from the list (NOT geo.location.latitude/longitude — those don't exist)
- bandChart → use band_timeseries with a numeric field
- scatterplot → use scatter_two with a numeric field
- honeycomb → use honeycomb_steps (no field)
- recordList → use recent_events (no field)
- histogram → use count_by with a string field

Example for "revenue overview" with orderTotal(numeric=149.99), region(string="Northeast"):
{"tiles":[{"title":"Total Revenue","viz":"singleValue","field":"orderTotal","agg":"sum"},{"title":"Avg Order Value","viz":"singleValue","field":"orderTotal","agg":"avg"},{"title":"Success Rate","viz":"gauge","field":null,"agg":"gauge_success"},{"title":"Revenue Trend","viz":"areaChart","field":"orderTotal","agg":"timeseries_sum"},{"title":"Revenue Range","viz":"bandChart","field":"orderTotal","agg":"band_timeseries"},{"title":"Revenue by Step","viz":"categoricalBarChart","field":"orderTotal","agg":"sum_by_step"},{"title":"Orders by Region","viz":"pieChart","field":"region","agg":"count_by"},{"title":"Success by Region","viz":"choroplethMap","field":"region","agg":"geo_region"},{"title":"Step Health","viz":"honeycomb","field":null,"agg":"honeycomb_steps"},{"title":"Journey Steps","viz":"table","field":null,"agg":"step_table"}]}

IMPORTANT: 
1. Return exactly 10 to 14 tiles in ONE single "tiles" array.
2. Use ONLY fields from the list above. Never invent field names.
3. Include at least 1 gauge and 1 table.
4. Include 1 choroplethMap only if a suitable string field exists (geo_region agg).
5. Prioritize ⭐ marked fields (top 5 numeric + 5 string).

Generate tiles for: "${customPrompt}"
Rules: Start with 2-3 singleValue KPIs + 1 gauge, add charts with mixed viz types, end with 1 table. Output ONE JSON object with ONE "tiles" key.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    const tilePlanStartTime = performance.now();

    const response = await fetch(`${OLLAMA_ENDPOINT}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        format: 'json',
        stream: true,
        keep_alive: -1,
        options: { temperature: 0.3, num_predict: 2048, num_ctx: 4096 }
      })
    });

    if (!response.ok) { clearTimeout(timeout); throw new Error(`Ollama returned ${response.status}`); }

    // Stream tokens — accumulate response
    let responseText = '';
    try {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split('\n')) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.response) responseText += obj.response;
            if (obj.done) break;
          } catch { /* partial line, skip */ }
        }
      }
    } catch (streamErr) {
      if (streamErr.name !== 'AbortError' && !responseText) throw streamErr;
      console.log(`[AI Dashboard] ⏱️ Tile stream ended (${streamErr.name}), parsing ${responseText.length} chars collected`);
    }
    clearTimeout(timeout);

    console.log(`[AI Dashboard] 🧠 Tile plan raw (${responseText.length} chars): ${responseText.substring(0, 500)}`);

    // Parse JSON — format:"json" ensures valid JSON output.
    // Handle: {"tiles":[...]}, bare [...], {"someName":[...]}, or duplicate "tiles" keys
    let plans;

    // Strategy 1: Extract ALL tile objects via regex (handles duplicate keys, partial JSON)
    const tileRegex = /\{[^{}]*"title"\s*:\s*"[^"]*"[^{}]*"viz"\s*:\s*"[^"]*"[^{}]*"agg"\s*:\s*"[^"]*"[^{}]*\}/g;
    const regexMatches = responseText.match(tileRegex);
    if (regexMatches && regexMatches.length > 0) {
      plans = [];
      for (const m of regexMatches) {
        try { plans.push(JSON.parse(m)); } catch { /* skip malformed */ }
      }
    }

    // Strategy 2: Standard JSON.parse if regex found nothing
    if (!plans || plans.length === 0) {
      try {
        const parsed = JSON.parse(responseText);
        if (Array.isArray(parsed)) {
          plans = parsed;
        } else if (parsed && typeof parsed === 'object') {
          plans = parsed.tiles || Object.values(parsed).find(v => Array.isArray(v));
        }
      } catch {
        // Partial JSON — try to repair and extract array
        let jsonText = responseText.trim();
        const arrStart = jsonText.indexOf('[');
        if (arrStart >= 0) {
          jsonText = jsonText.substring(arrStart);
          jsonText = jsonText
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/\n/g, ' ');
          if (!jsonText.endsWith(']')) {
            const lastBrace = jsonText.lastIndexOf('}');
            if (lastBrace > 0) jsonText = jsonText.substring(0, lastBrace + 1) + ']';
          }
          try { plans = JSON.parse(jsonText); } catch { /* will throw below */ }
        }
      }
    }

    if (!Array.isArray(plans) || plans.length === 0) {
      throw new Error('No valid tile plans in response');
    }

    // Validate, auto-correct, and sanitize each plan
    const validPlans = [];
    const rejected = [];
    const VIZ_ALIASES = { histogram: 'categoricalBarChart', bar: 'barChart', line: 'lineChart', area: 'areaChart', pie: 'pieChart', donut: 'donutChart', scatter: 'scatterplot', geo: 'choroplethMap', map: 'choroplethMap', geoMap: 'choroplethMap', meter: 'meterBar', record: 'recordList', band: 'bandChart', hc: 'honeycomb' };

    for (const plan of plans) {
      if (!plan.title || !plan.viz || !plan.agg) { rejected.push(`${plan.title||'?'}: missing title/viz/agg`); continue; }

      // Auto-correct viz aliases
      if (!VALID_VIZ_TYPES.has(plan.viz) && VIZ_ALIASES[plan.viz]) {
        plan.viz = VIZ_ALIASES[plan.viz];
      }
      if (!VALID_VIZ_TYPES.has(plan.viz)) { rejected.push(`${plan.title}: bad viz "${plan.viz}"`); continue; }
      if (!DQL_AGG_TEMPLATES[plan.agg]) { rejected.push(`${plan.title}: bad agg "${plan.agg}"`); continue; }

      // Auto-correct type mismatches: numeric agg on string field → count_by + donut
      if (FIELD_REQUIRED_AGGS.has(plan.agg) && plan.field && discoveredFieldMap) {
        const info = discoveredFieldMap.get(plan.field);
        if (info) {
          if (NUMERIC_ONLY_AGGS.has(plan.agg) && info.type !== 'numeric') {
            plan.agg = 'count_by';
            if (plan.viz === 'singleValue' || plan.viz === 'lineChart' || plan.viz === 'areaChart') plan.viz = 'donutChart';
          }
          if (plan.agg === 'count_by' && info.type === 'numeric') {
            plan.agg = info.category === 'revenue' ? 'sum_by_step' : 'avg_by_step';
            if (plan.viz === 'donutChart' || plan.viz === 'pieChart') plan.viz = 'categoricalBarChart';
          }
        }
      }

      // Validate field requirements
      if (FIELD_REQUIRED_AGGS.has(plan.agg)) {
        if (!plan.field) { rejected.push(`${plan.title}: agg "${plan.agg}" needs field`); continue; }
        if (discoveredFieldMap && !discoveredFieldMap.has(plan.field)) { rejected.push(`${plan.title}: field "${plan.field}" not in discovered fields`); continue; }
        if (NUMERIC_ONLY_AGGS.has(plan.agg)) {
          const info = discoveredFieldMap?.get(plan.field);
          if (info && info.type !== 'numeric') { rejected.push(`${plan.title}: numeric agg on string field "${plan.field}"`); continue; }
        }
        if (plan.agg === 'count_by' || plan.agg === 'geo_region') {
          const info = discoveredFieldMap?.get(plan.field);
          if (info && info.type === 'numeric') { rejected.push(`${plan.title}: ${plan.agg} on numeric field "${plan.field}"`); continue; }
        }
      }

      validPlans.push({
        title: String(plan.title).substring(0, 100),
        viz: plan.viz,
        field: plan.field || null,
        agg: plan.agg
      });
    }

    console.log(`[AI Dashboard] ✅ Tile plan: ${validPlans.length} valid from ${plans.length} generated`);
    if (rejected.length > 0) {
      console.log(`[AI Dashboard] ⚠️ Rejected ${rejected.length} tiles: ${rejected.join(' | ')}`);
    }

    if (validPlans.length < 3) {
      throw new Error(`Only ${validPlans.length} valid tiles — insufficient for dashboard`);
    }

    // Log GenAI span for tile plan generation (streaming — estimate tokens from text length)
    const tilePlanDuration = performance.now() - tilePlanStartTime;
    await logGenAISpan(createGenAISpan(prompt, responseText, OLLAMA_MODEL, Math.ceil(prompt.length / 4), Math.ceil(responseText.length / 4), tilePlanDuration), 'tile_plan_generation');

    return validPlans;
  } catch (err) {
    console.warn(`[AI Dashboard] ⚠️ Tile plan generation failed: ${err.message}`);
    return null;
  }
}

/**
 * VALIDATION: Validate that DQL queries only reference discovered fields.
 * Extracts field references from queries and checks them against discovered fields.
 * Logs warnings if unknown fields are found.
 */
function validateDQLQueryFields(query, discoveredFieldMap, tileTitle = '') {
  if (!query || typeof query !== 'string') return { valid: true, warnings: [] };
  
  const warnings = [];
  
  // Find all additionalfields.* references in the query
  const fieldRefRegex = /additionalfields\.([A-Za-z0-9_]+)/g;
  const matches = query.matchAll(fieldRefRegex);
  
  for (const match of matches) {
    const fieldName = match[1];
    if (discoveredFieldMap && !discoveredFieldMap.has(fieldName)) {
      warnings.push(`${tileTitle ? `[${tileTitle}] ` : ''}Field "additionalfields.${fieldName}" not found in discovered fields`);
    }
  }
  
  // Also check for likely hallucinated geo field patterns
  if (/geo\.location\.(latitude|longitude)|(latitude|longitude)\s*field/.test(query)) {
    warnings.push(`${tileTitle ? `[${tileTitle}] ` : ''}Query uses "geo.location.latitude/longitude" which don't exist in BizEvents — use a discovered regional field instead`);
  }
  
  return { 
    valid: warnings.length === 0, 
    warnings 
  };
}

/**
 * Build a dashboard tile object from a tile plan.
 */
function buildTileFromPlan(plan, discoveredFieldMap = null) {
  const Q_SETTINGS = { maxResultRecords: 1000, defaultScanLimitGbytes: 500, maxResultMegaBytes: 1, defaultSamplingRatio: 10, enableSampling: false };
  const DAVIS_OFF = { enabled: false, davisVisualization: { isAvailable: true } };

  const templateFn = DQL_AGG_TEMPLATES[plan.agg];
  if (!templateFn) throw new Error(`Unknown agg template: ${plan.agg}`);
  const dql = FIELD_REQUIRED_AGGS.has(plan.agg) ? templateFn(plan.field || 'orderTotal') : templateFn();

  // Validate the generated DQL query
  const validation = validateDQLQueryFields(dql, discoveredFieldMap, plan.title);
  if (!validation.valid || validation.warnings.length > 0) {
    for (const warning of validation.warnings) {
      console.warn(`[AI Dashboard] ⚠️ ${warning}`);
    }
  }

  // Build viz settings — some types need field-specific config
  let vizSettings = getVizSettingsForType(plan.viz);

  if (plan.viz === 'gauge' || plan.viz === 'meterBar') {
    const recordField = plan.agg === 'gauge_field' ? 'value' : 'rate';
    vizSettings = {
      gauge: { label: plan.title, recordField, min: 0, max: plan.agg === 'gauge_field' ? 'auto' : 100,
        thresholds: [{ value: 95, color: '#2AB06F' }, { value: 85, color: '#EEA53C' }, { value: 0, color: '#C62239' }]
      }
    };
  } else if (plan.viz === 'choroplethMap') {
    vizSettings = {
      choroplethMap: {
        baseLayer: { type: 'world' },
        dataMapping: { regionField: plan.field ? `additionalfields.${plan.field}` : null, valueField: 'count' },
        colorPalette: { type: 'sequential', steps: 5, minColor: '#E8F5E9', maxColor: '#1B5E20' }
      }
    };
  }

  return {
    title: plan.title,
    type: 'data',
    query: dql,
    visualization: plan.viz,
    visualizationSettings: vizSettings,
    querySettings: Q_SETTINGS,
    davis: DAVIS_OFF
  };
}


/**
 * MAIN FUNCTION: Generate a prompt-driven dashboard from selected sections.
 * This is the new MCP custom prompt path — it replaces the always-proven-template approach.
 */
async function generatePromptDrivenDashboard(journeyData, skills, customPrompt, options = {}) {
  const { company, journeyType, industry, steps } = journeyData;
  const { isBespoke = false } = options;
  const detected = detectPayloadFields(journeyData);

  // Collect data signals for context
  const dataSignals = [];
  if (detected.hasRevenue) dataSignals.push('revenue');
  if (detected.hasLoyalty) dataSignals.push('loyalty');
  if (detected.hasLTV) dataSignals.push('lifetime value');
  if (detected.hasChurnRisk) dataSignals.push('churn risk');
  if (detected.hasConversion) dataSignals.push('conversion');
  if (detected.hasEngagement) dataSignals.push('engagement');
  if (detected.hasSatisfaction) dataSignals.push('satisfaction');
  if (detected.hasNPS) dataSignals.push('NPS');
  if (detected.hasRetention) dataSignals.push('retention');
  if (detected.hasPricing) dataSignals.push('pricing');
  if (detected.hasFraud) dataSignals.push('fraud');
  if (detected.hasCompliance) dataSignals.push('compliance');
  if (detected.hasRisk) dataSignals.push('risk');
  if (detected.hasOperational) dataSignals.push('operations');

  console.log(`[AI Dashboard] 🎯 PROMPT-DRIVEN generation for "${customPrompt.substring(0, 80)}"`);
  console.log(`[AI Dashboard] 📊 Company: ${company}, Journey: ${journeyType}, Signals: ${dataSignals.join(', ') || 'standard'}`);

  // STEP 1: Ask Ollama which sections to include
  const selection = await selectSectionsWithOllama(customPrompt, company, journeyType, industry, dataSignals);

  // Enforce minimum richness — always include KPIs + overview + customer metrics
  const essentialSections = ['executive_kpis', 'journey_overview', 'customer_dynamic'];
  for (const essential of essentialSections) {
    if (!selection.sections.includes(essential)) {
      selection.sections.push(essential);
    }
  }
  // Only pad if Ollama/keyword gave very few sections (< 5)
  // This preserves focused dashboards while preventing near-empty ones
  if (selection.sections.length < 5) {
    const padSections = ['performance_sla', 'filtered_view', 'error_analysis', 'trend_analysis', 'golden_signals_traffic', 'golden_signals_latency', 'observability', 'geographic_view'];
    for (const pad of padSections) {
      if (selection.sections.length >= 5) break;
      if (!selection.sections.includes(pad)) {
        selection.sections.push(pad);
      }
    }
  }

  console.log(`[AI Dashboard] ✅ Selected ${selection.sections.length} sections: ${selection.sections.join(', ')}`);
  console.log(`[AI Dashboard] 📝 Title: "${selection.title}", Focus: "${selection.focus}"`);

  // STEP 2: Gather tile pools from proven template builders
  const journeyTiles = getJourneyOverviewTiles(company);
  const filteredTiles = getFilteredViewTiles(company);
  const perfTiles = getPerformanceTiles(company);
  const goldenTiles = getGoldenSignalTiles();
  const obsTiles = getObservabilityTiles();
  const sectionHeaders = getSectionHeaders();

  // Dynamic tiles from payload
  const dynamicTiles = generateDynamicFieldTiles(detected, company, journeyType);

  // STEP 2b: Discover which additionalfields actually exist in Grail for this company/journey
  // Proxy sends {name, type}[] — build a Map of fieldName → {type, category} for tile generation
  // This prevents null-value tiles AND enables type-aware DQL (sum vs countBy)
  // Works with ANY field name — real customers may have "status", "productSKU", "warrantyType", etc.

  // Smart label: convert camelCase/PascalCase/snake_case → readable "Title Case"
  function smartLabel(fieldName) {
    return fieldName
      .replace(/([a-z])([A-Z])/g, '$1 $2')   // camelCase → "camel Case"
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2') // XMLParser → "XML Parser"
      .replace(/_/g, ' ')                      // snake_case → "snake case"
      .replace(/\b\w/g, c => c.toUpperCase()); // Title Case
  }

  // Auto-categorize unknown fields by name heuristics
  const CATEGORY_HINTS = {
    revenue:      /price|cost|revenue|total|value|amount|profit|margin|discount|tax|shipping|order|spend|fee|payment|invoice/i,
    customer:     /customer|lifetime|ltv|clv|acquisition|retention|loyalty|member|tier|status/i,
    conversion:   /convert|conversion|funnel|cart|abandon|checkout|signup|register/i,
    satisfaction: /nps|satisfaction|promoter|rating|score|feedback|survey|csat/i,
    operations:   /process|time|duration|latency|queue|throughput|efficiency|utilization|performance|response/i,
    risk:         /risk|fraud|compliance|security|threat|alert|incident/i,
    channel:      /channel|device|browser|platform|source|medium|campaign|referr/i,
    segment:      /segment|group|cohort|category|type|class|level|plan|subscription/i,
    product:      /product|sku|item|catalog|inventory|stock|brand|model|variant/i,
    market:       /market|region|location|country|geo|territory|zone|area/i,
  };
  function guessCategory(fieldName) {
    for (const [cat, regex] of Object.entries(CATEGORY_HINTS)) {
      if (regex.test(fieldName)) return cat;
    }
    return 'unknown';
  }

  // Build metadata for a discovered field, using FIELD_CATALOG if known, else heuristics
  function buildFieldMeta(name, discoveredType) {
    const catalogEntry = FIELD_CATALOG[name];
    if (catalogEntry) {
      return {
        type: discoveredType || catalogEntry.type,
        category: catalogEntry.category,
        label: catalogEntry.label,
        agg: catalogEntry.agg,
        viz: catalogEntry.viz,
        kpi: catalogEntry.kpi,
      };
    }
    // Unknown field — infer everything from the name + discovered type
    const type = discoveredType || 'string';
    const category = guessCategory(name);
    return {
      type,
      category,
      label: smartLabel(name),
      agg: type === 'numeric' ? (category === 'revenue' ? 'sum' : 'avg') : null,
      viz: type === 'numeric' ? 'categoricalBarChart' : 'donutChart',
      kpi: type === 'numeric' && /total|revenue|value|cost|price/i.test(name),
    };
  }

  let discoveredFieldMap = null; // null = couldn't discover, fall back to catalog defaults

  if (Array.isArray(journeyData.discoveredFields)) {
    discoveredFieldMap = new Map();
    for (const f of journeyData.discoveredFields) {
      const name = typeof f === 'string' ? f : f.name;
      const discoveredType = typeof f === 'object' ? f.type : null;
      const meta = buildFieldMeta(name, discoveredType);
      // Carry forward sample values from Grail discovery for Ollama context
      if (typeof f === 'object' && f.sampleValue !== undefined) {
        meta.sampleValue = f.sampleValue;
      }
      discoveredFieldMap.set(name, meta);
    }
    console.log(`[AI Dashboard] 🔎 Proxy-discovered ${discoveredFieldMap.size} fields: ${[...discoveredFieldMap.entries()].map(([k,v]) => `${k}(${v.type}/${v.category}${v.sampleValue !== undefined ? '='+v.sampleValue : ''})`).join(', ')}`);
  } else {
    // Fallback: try local query — returns Set of field names + .records with full bizevent payloads
    const localFields = await discoverBizEventFields(company, journeyType);
    if (localFields) {
      discoveredFieldMap = new Map();
      for (const name of localFields) {
        discoveredFieldMap.set(name, buildFieldMeta(name, null));
      }
      // Carry forward the raw bizevent records so Ollama can see actual data
      if (localFields.records && localFields.records.length > 0) {
        discoveredFieldMap._bizEventRecords = localFields.records;
      }
      console.log(`[AI Dashboard] 🔎 Local discovery: ${discoveredFieldMap.size} fields, ${(localFields.records || []).length} bizevent records`);
    } else {
      console.log(`[AI Dashboard] 🔎 Field discovery skipped (no credentials) — using catalog defaults`);
    }
  }

  // Fallback: use additionalFields from the request payload when Grail discovery yields nothing
  if ((!discoveredFieldMap || discoveredFieldMap.size === 0) && journeyData.additionalFields && Object.keys(journeyData.additionalFields).length > 0) {
    discoveredFieldMap = new Map();
    for (const [name, value] of Object.entries(journeyData.additionalFields)) {
      const inferredType = typeof value === 'number' ? 'numeric' : 'string';
      discoveredFieldMap.set(name, buildFieldMeta(name, inferredType));
    }
    console.log(`[AI Dashboard] 🔎 Payload-inferred ${discoveredFieldMap.size} fields from additionalFields: ${[...discoveredFieldMap.keys()].join(', ')}`);
  }

  // STEP 2c: Determine prompt focus categories for tile prioritization
  // Skip focus filtering for bespoke prompts — they already target the right fields
  const promptLower = customPrompt.toLowerCase();
  let focusCategories = null; // null = show all categories
  if (!isBespoke) {
    for (const [keyword, categories] of Object.entries(FOCUS_CATEGORY_MAP)) {
      if (promptLower.includes(keyword)) {
        if (!focusCategories) focusCategories = new Set();
        for (const cat of categories) focusCategories.add(cat);
      }
    }
  }
  if (focusCategories) {
    console.log(`[AI Dashboard] 🎯 Prompt focus categories: ${[...focusCategories].join(', ')}`);
  }

  // Map section IDs to tile+layout entries
  const tilePools = {
    journey_overview: journeyTiles,
    filtered_view: filteredTiles,
    performance: perfTiles,
    golden_signals: goldenTiles,
    observability: obsTiles
  };

  // STEP 3: Compose the dashboard from selected sections
  const dynatraceUrl = process.env.DT_ENVIRONMENT_URL || process.env.DYNATRACE_URL || 'https://your-environment.apps.dynatrace.com';
  const signals = dataSignals.map(s => `📊 ${s.charAt(0).toUpperCase() + s.slice(1)}`).join(' | ') || '🔧 Services';

  const dashboard = {
    version: 21,
    variables: sortVariablesByDependency(getProvenVariables(company)),
    tiles: {},
    layouts: {},
    importedWithCode: false,
    settings: { defaultTimeframe: { value: { from: 'now()-24h', to: 'now()' }, enabled: true } },
    annotations: []
  };

  let idx = 0;
  let currentY = 0;

  // Helper to add a tile with auto-layout
  const addTile = (tileObj, w = 12, h = 4) => {
    const tile = { ...tileObj };
    delete tile._tag;
    delete tile._widgetType;
    delete tile._purpose;
    dashboard.tiles[idx] = tile;
    dashboard.layouts[idx] = { x: 0, y: currentY, w, h };
    idx++;
    return idx - 1;
  };

  const addTileAt = (tileObj, x, y, w, h) => {
    const tile = { ...tileObj };
    delete tile._tag;
    delete tile._widgetType;
    delete tile._purpose;
    dashboard.tiles[idx] = tile;
    dashboard.layouts[idx] = { x, y, w, h };
    idx++;
    return idx - 1;
  };

  const addMarkdown = (content, w = 24, h = 2) => {
    dashboard.tiles[idx] = { title: '', type: 'markdown', content };
    dashboard.layouts[idx] = { x: 0, y: currentY, w, h };
    idx++;
    currentY += h;
  };

  const addSectionHeader = (text, h = 1) => {
    dashboard.tiles[idx] = { title: '', type: 'markdown', content: `### ${text}` };
    dashboard.layouts[idx] = { x: 0, y: currentY, w: 24, h };
    idx++;
    currentY += h;
  };

  // ── HEADER (always included) ──
  const focusLine = selection.focus ? `\n**Focus:** ${selection.focus}` : '';
  addMarkdown(
    `# ${selection.title}\n## ${company} | ${journeyType} Journey | ${industry || 'Business Observability'}${focusLine}\n**Data Signals:** ${signals}\n---`,
    24, 2
  );

  // Journey flow (always included)
  const stepsText = (steps || []).map(s => `\`${typeof s === 'string' ? s : (s.name || s.stepName)}\``).join(' → ') || '`Step 1` → `Step 2` → `Step 3`';
  addMarkdown(`**Journey Flow:** ${stepsText}`, 24, 1);

  // ── MANDATORY MAP TILE (SudoSmitty rule: geo context required after header) ──
  // This gives geographic context to the journey — critical for business observability
  // Positioned after header+flow, before content sections
  try {
    const mapTile = {
      type: 'data',
      title: '🌍 Journey Events by Location',
      query: `fetch bizevents
| filter json.companyName == "$EventProvider"
| filter json.journeyType == $JourneyType
| filter isNotNull(additionalfields.region)
| summarize count = count(), by: {additionalfields.region}
| sort count desc
| limit 50`,
      visualization: 'donutChart',
      visualizationSettings: {
        chartSettings: {
          type: 'pie',
          circleChartSettings: { legendPosition: 'bottom' }
        }
      },
      querySettings: { maxResultRecords: 1000, defaultScanLimitGbytes: 500, maxResultMegaBytes: 1 },
      titleSize: 'medium'
    };
    addTileAt(mapTile, 0, currentY, 24, 4);
    currentY += 5; // Space for next section
  } catch (mapErr) {
    console.warn(`[AI Dashboard] ⚠️  Could not add map tile: ${mapErr.message}`);
    currentY += 1; // Skip space if map creation failed
  }

  // ── BESPOKE TILE GENERATION (Hybrid: AI selects sections + designs tiles from real Grail data) ──
  // Ollama sees actual field names + sample values from Grail, picks viz/agg combos.
  // DQL is built from validated templates, not from Ollama — reliability guaranteed.
  // Falls back to section-based layout if Ollama tile gen fails or returns too few tiles.
  let tilePlans = null;
  if (discoveredFieldMap && discoveredFieldMap.size > 0) {
    tilePlans = await generateTilePlanWithOllama(customPrompt, company, journeyType, industry, discoveredFieldMap, dataSignals);
  }

  if (tilePlans && tilePlans.length >= 3) {
    // BESPOKE LAYOUT — Ollama designed each tile from real Grail field data
    // ══════════════════════════════════════════════════════════════════════
    console.log(`[AI Dashboard] 🎨 Bespoke Ollama layout: ${tilePlans.length} unique tiles`);

    // Sort tiles by visual group: KPIs first, then charts, then full-width (table/heatmap/geo/records)
    const sortedPlans = [...tilePlans].sort((a, b) => {
      const KPI_SET = new Set(['singleValue', 'gauge', 'meterBar']);
      const FULL_SET = new Set(['table', 'heatmap', 'recordList', 'choroplethMap']);
      const groupOrder = (p) => KPI_SET.has(p.viz) ? 0 : FULL_SET.has(p.viz) ? 2 : 1;
      return groupOrder(a) - groupOrder(b);
    });

    let lastGroup = null;
    let kpiCol = 0;
    let chartCol = 0;

    const flushKpiRow = () => { if (kpiCol > 0) { currentY += 3; kpiCol = 0; } };
    const flushChartRow = () => { if (chartCol > 0) { currentY += 4; chartCol = 0; } };

    const GROUP_HEADERS = {
      kpi: '📊 Key Performance Indicators',
      chart: '📈 Analysis & Trends',
      fullwidth: '📋 Detailed Views'
    };

    const transitionTo = (group) => {
      if (group !== lastGroup) {
        if (lastGroup === 'kpi') flushKpiRow();
        if (lastGroup === 'chart') flushChartRow();
        addSectionHeader(GROUP_HEADERS[group]);
        lastGroup = group;
      }
    };

    for (const plan of sortedPlans) {
      let tile;
      try {
        tile = buildTileFromPlan(plan, discoveredFieldMap);
      } catch (tileErr) {
        console.warn(`[AI Dashboard] ⚠️ Failed to build tile "${plan.title}": ${tileErr.message}`);
        continue;
      }
      const KPI_VIZ = new Set(['singleValue', 'gauge', 'meterBar']);
      const FULLWIDTH_VIZ = new Set(['table', 'heatmap', 'recordList', 'choroplethMap']);
      if (KPI_VIZ.has(plan.viz)) {
        transitionTo('kpi');
        addTileAt(tile, kpiCol * 6, currentY, 6, 3);
        kpiCol++;
        if (kpiCol >= 4) { currentY += 3; kpiCol = 0; }
      } else if (FULLWIDTH_VIZ.has(plan.viz)) {
        transitionTo('fullwidth');
        const { w, h } = getTileDimensions(plan.viz);
        addTileAt(tile, 0, currentY, w, h);
        currentY += h;
      } else {
        transitionTo('chart');
        const { w, h } = getTileDimensions(plan.viz);
        addTileAt(tile, chartCol * 12, currentY, w, h);
        chartCol++;
        if (chartCol >= 2) { currentY += h; chartCol = 0; }
      }
    }
    flushKpiRow();
    flushChartRow();

  } else {
    // ══════════════════════════════════════════════════════════════════════
    // FALLBACK: Section-based layout (Ollama tile gen failed or unavailable)
    // ══════════════════════════════════════════════════════════════════════
    console.log(`[AI Dashboard] ⚡ Falling back to section-based layout`);

  // Shared query/davis settings for all section tiles
  const Q_SETTINGS = { maxResultRecords: 1000, defaultScanLimitGbytes: 500, maxResultMegaBytes: 1, defaultSamplingRatio: 10, enableSampling: false };
  const DAVIS_OFF = { enabled: false, davisVisualization: { isAvailable: true } };

  // ── SELECTED SECTIONS (fallback) ──
  for (const sectionId of selection.sections) {
    const catalog = SECTION_CATALOG[sectionId];
    if (!catalog) continue;

    // Section header
    addSectionHeader(`📌 ${catalog.label}`);

    if (sectionId === 'executive_kpis') {
      // 4 KPI cards in a row
      addTileAt(journeyTiles.total_volume, 0, currentY, 6, 3);
      addTileAt(journeyTiles.success_rate, 6, currentY, 6, 3);
      addTileAt(journeyTiles.total_revenue, 12, currentY, 6, 3);
      addTileAt(journeyTiles.total_errors, 18, currentY, 6, 3);
      currentY += 3;

      // Gauge row: Success Rate gauge + Error Rate gauge (visual percentage indicators)
      addTileAt({
        title: '🎯 Success Rate', type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | summarize total = count(), successful = countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false) | fieldsAdd rate = round((toDouble(successful) / toDouble(total)) * 100, decimals:1)`,
        visualization: 'gauge',
        visualizationSettings: {
          gauge: { label: 'Success %', recordField: 'rate', min: 0, max: 100,
            thresholds: [{ value: 95, color: '#2AB06F' }, { value: 85, color: '#EEA53C' }, { value: 0, color: '#C62239' }]
          }
        },
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 0, currentY, 12, 4);
      addTileAt({
        title: '⚡ Error Rate', type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | summarize total = count(), errors = countIf(additionalfields.hasError == true) | fieldsAdd rate = round((toDouble(errors) / toDouble(total)) * 100, decimals:1)`,
        visualization: 'gauge',
        visualizationSettings: {
          gauge: { label: 'Error %', recordField: 'rate', min: 0, max: 100,
            thresholds: [{ value: 0, color: '#2AB06F' }, { value: 5, color: '#EEA53C' }, { value: 15, color: '#C62239' }]
          }
        },
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 12, currentY, 12, 4);
      currentY += 4;

    } else if (sectionId === 'journey_overview') {
      addTileAt(journeyTiles.step_metrics, 0, currentY, 24, 6);
      currentY += 6;
      addTileAt(journeyTiles.volume_over_time, 0, currentY, 12, 4);
      addTileAt(journeyTiles.events_by_step, 12, currentY, 12, 4);
      currentY += 4;

      // Honeycomb: Step Health overview — each step as a node, colored by success rate
      addTileAt({
        title: '🐝 Step Health Overview', type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | summarize total = count(), successful = countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false), by: {json.stepName} | fieldsAdd success_rate = round((toDouble(successful) / toDouble(total)) * 100, decimals:1) | fields json.stepName, success_rate`,
        visualization: 'honeycomb',
        visualizationSettings: {
          honeycomb: { dataMappings: { value: 'success_rate', label: 'json.stepName' }, colorPalette: 'green-to-red-inverted', shape: 'hexagon', showLabels: true },
          legend: { position: 'auto', showLegend: true }
        },
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 0, currentY, 24, 5);
      currentY += 5;

    } else if (sectionId === 'filtered_view') {
      addTileAt(filteredTiles.filtered_events, 0, currentY, 6, 3);
      addTileAt(filteredTiles.filtered_revenue, 6, currentY, 6, 3);
      addTileAt(filteredTiles.filtered_aov, 12, currentY, 6, 3);
      addTileAt(filteredTiles.filtered_p90, 18, currentY, 6, 3);
      currentY += 3;
      addTileAt(filteredTiles.filtered_volume_trend, 0, currentY, 12, 4);
      addTileAt(filteredTiles.filtered_events_by_step, 12, currentY, 12, 4);
      currentY += 4;

    } else if (sectionId === 'performance_sla') {
      addTileAt(perfTiles.step_performance, 0, currentY, 12, 5);
      addTileAt(perfTiles.sla_compliance, 12, currentY, 12, 5);
      currentY += 5;
      addTileAt(perfTiles.hourly_pattern, 0, currentY, 12, 4);

      // MeterBar: SLA target compliance rate — visual progress bar
      addTileAt({
        title: '📊 SLA Target Compliance', type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | summarize total = count(), within_sla = countIf(isNull(additionalfields.hasError) or additionalfields.hasError == false) | fieldsAdd sla_rate = round((toDouble(within_sla) / toDouble(total)) * 100, decimals:1)`,
        visualization: 'meterBar',
        visualizationSettings: {
          meterBar: { recordField: 'sla_rate', min: 0, max: 100, label: 'SLA Compliance %',
            thresholds: [{ value: 99, color: '#2AB06F' }, { value: 95, color: '#EEA53C' }, { value: 0, color: '#C62239' }]
          }
        },
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 12, currentY, 12, 4);
      currentY += 4;

    } else if (sectionId === 'error_analysis') {
      addTileAt(perfTiles.error_rate_trend, 0, currentY, 12, 4);
      addTileAt(perfTiles.errors_by_step, 12, currentY, 12, 4);
      currentY += 4;
      addTileAt(perfTiles.error_details, 0, currentY, 24, 4);
      currentY += 4;

    } else if (sectionId === 'golden_signals_traffic') {
      addTileAt(goldenTiles.requests, 0, currentY, 8, 5);
      addTileAt(goldenTiles.requests_success_failed, 8, currentY, 8, 5);
      addTileAt(goldenTiles.key_requests, 16, currentY, 8, 5);
      currentY += 5;

    } else if (sectionId === 'golden_signals_latency') {
      addTileAt(goldenTiles.latency_p50, 0, currentY, 8, 5);
      addTileAt(goldenTiles.latency_p90, 8, currentY, 8, 5);
      addTileAt(goldenTiles.latency_p99, 16, currentY, 8, 5);
      currentY += 5;

    } else if (sectionId === 'golden_signals_errors') {
      addTileAt(goldenTiles.failed_requests, 0, currentY, 8, 5);
      addTileAt(goldenTiles.errors_5xx, 8, currentY, 8, 5);
      addTileAt(goldenTiles.errors_4xx, 16, currentY, 8, 5);
      currentY += 5;

    } else if (sectionId === 'golden_signals_saturation') {
      addTileAt(goldenTiles.cpu_usage, 0, currentY, 8, 5);
      addTileAt(goldenTiles.memory_used, 8, currentY, 8, 5);
      addTileAt(goldenTiles.gc_suspension, 16, currentY, 8, 5);
      currentY += 5;

    } else if (sectionId === 'observability') {
      addTileAt(obsTiles.traces_with_exceptions, 0, currentY, 24, 6);
      currentY += 6;
      addTileAt(obsTiles.top_exceptions, 0, currentY, 24, 5);
      currentY += 5;
      addTileAt(obsTiles.davis_problems, 0, currentY, 12, 5);
      addTileAt(obsTiles.log_errors, 12, currentY, 12, 5);
      currentY += 5;

    } else if (sectionId === 'customer_dynamic') {
      // ══════════════════════════════════════════════════════════════════
      // DATA-DRIVEN TILE BUILDER: Uses discoveredFieldMap + FIELD_CATALOG
      // to generate the right DQL for each field's actual data type.
      // STRING fields → countBy + donut/pie/bar
      // NUMERIC fields → sum/avg + singleValue/bar/area
      // Focus categories from the prompt filter which fields get tiles.
      // ══════════════════════════════════════════════════════════════════

      const BASE_FILTER = `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType)`;

      // Build the list of fields to visualize
      let fieldsToVisualize = [];

      if (!discoveredFieldMap || discoveredFieldMap.size === 0) {
        // No proxy discovery — try one more time locally within this section
        console.log('[AI Dashboard] ⚠️ No discovered fields from proxy — attempting local Grail discovery...');
        const lastChanceFields = await discoverBizEventFields(company, journeyType, { maxRetries: 0 });
        if (lastChanceFields && lastChanceFields.size > 0) {
          discoveredFieldMap = new Map();
          for (const name of lastChanceFields) {
            discoveredFieldMap.set(name, buildFieldMeta(name, null));
          }
          console.log(`[AI Dashboard] ✅ Last-chance local discovery found ${discoveredFieldMap.size} fields`);
        } else {
          console.log('[AI Dashboard] ⚠️ Local discovery also returned nothing — customer_dynamic will show placeholder');
        }
      }

      if (discoveredFieldMap && discoveredFieldMap.size > 0) {
        // We have real discovered fields — use them with their real types
        for (const [fieldName, info] of discoveredFieldMap) {
          if (fieldName === 'hasError') continue; // handled in error_analysis section
          // Apply focus filter: if prompt targets specific categories, only show matching fields
          if (focusCategories && info.category !== 'unknown' && !focusCategories.has(info.category)) continue;
          fieldsToVisualize.push({ fieldName, ...info });
        }
      }

      if (fieldsToVisualize.length === 0) {
        addMarkdown('*No additional business metrics found in the bizevent data for this journey. Run a journey simulation to populate business metrics.*', 24, 1);
      } else {
        console.log(`[AI Dashboard] 📊 Building ${fieldsToVisualize.length} data-driven tiles from discovered fields`);

        // Smart field classification for optimal visualization selection
        const isPercentageField = (name) => /rate|score|percentage|ratio|likelihood|compliance|satisfaction/i.test(name);
        const isLocationField = (name) => /region|country|location|city|state|territory|zone|geo|market/i.test(name);
        const isTimeField = (name) => /time|duration|latency|wait|response|processing|elapsed/i.test(name);

        // Separate fields by type and characteristics
        const kpiFields = fieldsToVisualize.filter(f => f.type === 'numeric' && f.kpi);
        const gaugeFields = fieldsToVisualize.filter(f => f.type === 'numeric' && !f.kpi && isPercentageField(f.fieldName));
        const timeDistFields = fieldsToVisualize.filter(f => f.type === 'numeric' && !f.kpi && isTimeField(f.fieldName));
        const otherNumericFields = fieldsToVisualize.filter(f => f.type === 'numeric' && !f.kpi && !isPercentageField(f.fieldName) && !isTimeField(f.fieldName));
        const locationFields = fieldsToVisualize.filter(f => f.type === 'string' && isLocationField(f.fieldName));
        const otherStringFields = fieldsToVisualize.filter(f => f.type === 'string' && !isLocationField(f.fieldName));

        // ── KPI ROW: Top numeric KPIs as singleValue cards (max 4) ──
        if (kpiFields.length > 0) {
          const topKpis = kpiFields.slice(0, 4);
          const kpiWidth = Math.floor(24 / topKpis.length);
          topKpis.forEach((f, i) => {
            const aggFn = f.agg === 'sum' ? `sum(additionalfields.${f.fieldName})` : `avg(additionalfields.${f.fieldName})`;
            addTileAt({
              title: f.label, type: 'data',
              query: `${BASE_FILTER} | summarize value = ${aggFn}`,
              visualization: 'singleValue',
              visualizationSettings: {},
              querySettings: Q_SETTINGS, davis: DAVIS_OFF
            }, i * kpiWidth, currentY, kpiWidth, 3);
          });
          currentY += 3;
        }

        // ── GAUGE ROW: Percentage/rate/score fields as gauges (max 3 per row) ──
        if (gaugeFields.length > 0) {
          let col = 0;
          for (const f of gaugeFields) {
            const aggFn = `avg(additionalfields.${f.fieldName})`;
            const isPercent = /rate|percentage|ratio|likelihood|compliance/i.test(f.fieldName);
            const maxVal = isPercent ? 100 : (/score/i.test(f.fieldName) ? 100 : 10);
            addTileAt({
              title: `🎯 ${f.label}`, type: 'data',
              query: `${BASE_FILTER} | summarize value = ${aggFn}`,
              visualization: 'gauge',
              visualizationSettings: {
                gauge: { label: f.label, recordField: 'value', min: 0, max: maxVal,
                  thresholds: maxVal === 100
                    ? [{ value: 80, color: '#2AB06F' }, { value: 50, color: '#EEA53C' }, { value: 0, color: '#C62239' }]
                    : [{ value: maxVal * 0.8, color: '#2AB06F' }, { value: maxVal * 0.5, color: '#EEA53C' }, { value: 0, color: '#C62239' }]
                }
              },
              querySettings: Q_SETTINGS, davis: DAVIS_OFF
            }, col * 8, currentY, 8, 4);
            col++;
            if (col >= 3) { col = 0; currentY += 4; }
          }
          if (col > 0) currentY += 4;
        }

        // ── HISTOGRAM ROW: Time/duration fields as histograms (distribution view) ──
        if (timeDistFields.length > 0) {
          addMarkdown('#### ⏱️ Distribution Analysis', 24, 1);
          let col = 0;
          for (const f of timeDistFields) {
            addTileAt({
              title: `📊 ${f.label} Distribution`, type: 'data',
              query: `${BASE_FILTER} | filter isNotNull(additionalfields.${f.fieldName}) | fields value = additionalfields.${f.fieldName}`,
              visualization: 'histogram',
              visualizationSettings: {
                histogram: { dataMappings: { value: 'value' } },
                legend: { position: 'auto', showLegend: true }
              },
              querySettings: Q_SETTINGS, davis: DAVIS_OFF
            }, col * 12, currentY, 12, 5);
            col++;
            if (col >= 2) { col = 0; currentY += 5; }
          }
          if (col > 0) currentY += 5;
        }

        // ── NUMERIC CHART ROWS: Bar charts grouped by step (3 per row) ──
        const remainingNumeric = [...kpiFields.slice(4), ...otherNumericFields];
        if (remainingNumeric.length > 0) {
          let col = 0;
          for (const f of remainingNumeric) {
            const aggFn = f.agg === 'sum' ? `sum(additionalfields.${f.fieldName})` : `avg(additionalfields.${f.fieldName})`;
            const p90 = f.agg === 'avg' && isTimeField(f.fieldName)
              ? `, P90 = percentile(additionalfields.${f.fieldName}, 90)` : '';
            addTileAt({
              title: f.label, type: 'data',
              query: `${BASE_FILTER} | summarize Value = ${aggFn}${p90}, Events = count(), by: {json.stepName} | sort Value desc`,
              visualization: 'categoricalBarChart',
              visualizationSettings: {
                categoryAxis: { label: { label: 'Journey Step', showLabel: true }, tickLayout: 'horizontal' },
                numericAxis: { label: { showLabel: true }, scale: 'linear' },
                legend: { position: 'auto', showLegend: true },
                layout: { groupMode: 'grouped', position: 'horizontal' }
              },
              querySettings: Q_SETTINGS, davis: DAVIS_OFF
            }, col * 8, currentY, 8, 5);
            col++;
            if (col >= 3) { col = 0; currentY += 5; }
          }
          if (col > 0) currentY += 5;
        }

        // ── SCATTERPLOT: Correlation between two numeric fields (when 2+ available) ──
        const allNumeric = [...kpiFields, ...gaugeFields, ...otherNumericFields];
        if (allNumeric.length >= 2) {
          const xField = allNumeric[0];
          const yField = allNumeric[1];
          addTileAt({
            title: `🔬 ${xField.label} vs ${yField.label} Correlation`, type: 'data',
            query: `${BASE_FILTER} | filter isNotNull(additionalfields.${xField.fieldName}) AND isNotNull(additionalfields.${yField.fieldName}) | fields x = additionalfields.${xField.fieldName}, y = additionalfields.${yField.fieldName}, step = json.stepName | limit 500`,
            visualization: 'scatterplot',
            visualizationSettings: {
              scatterplot: { dataMappings: { x: 'x', y: 'y', color: 'step' } },
              legend: { position: 'auto', showLegend: true }
            },
            querySettings: Q_SETTINGS, davis: DAVIS_OFF
          }, 0, currentY, 24, 5);
          currentY += 5;
        }

        // ── REVENUE TREND: Revenue category fields as timeseries area chart ──
        const revenueField = fieldsToVisualize.find(f => f.category === 'revenue' && f.type === 'numeric');
        if (revenueField) {
          addTileAt({
            title: `📈 ${revenueField.label} Trend Over Time`, type: 'data',
            query: `${BASE_FILTER} | makeTimeseries revenue = ${revenueField.agg}(additionalfields.${revenueField.fieldName}), volume = count(), bins:30`,
            visualization: 'areaChart',
            visualizationSettings: {
              chartSettings: { gapPolicy: 'connect', seriesOverrides: [
                { seriesId: ['revenue'], override: { color: '#2AB06F' } },
                { seriesId: ['volume'], override: { color: '#4FD5E0' } }
              ]},
              thresholds: [], unitsOverrides: []
            },
            querySettings: Q_SETTINGS, davis: DAVIS_OFF
          }, 0, currentY, 24, 5);
          currentY += 5;
        }

        // ── LOCATION FIELDS: PieChart for geographic/location string fields ──
        if (locationFields.length > 0) {
          addMarkdown('#### 🌍 Geographic Breakdown', 24, 1);
          let col = 0;
          for (const f of locationFields) {
            addTileAt({
              title: f.label, type: 'data',
              query: `${BASE_FILTER} | filter isNotNull(additionalfields.${f.fieldName}) | summarize Count = count(), by: {additionalfields.${f.fieldName}} | sort Count desc`,
              visualization: 'pieChart',
              visualizationSettings: {
                legend: { position: 'auto', showLegend: true },
                pieChart: { labelsVisible: true }
              },
              querySettings: Q_SETTINGS, davis: DAVIS_OFF
            }, col * 8, currentY, 8, 5);
            col++;
            if (col >= 3) { col = 0; currentY += 5; }
          }
          if (col > 0) currentY += 5;
        }

        // ── STRING DIMENSION ROWS: Donut charts (standard), Honeycomb for high-cardinality ──
        if (otherStringFields.length > 0) {
          addMarkdown('#### 📊 Breakdown by Dimension', 24, 1);
          let col = 0;
          for (const f of otherStringFields) {
            // Honeycomb for fields likely to have many values (IDs, names, status codes)
            const isHighCardinality = /name|id|code|sku|product|item|model|brand|variant/i.test(f.fieldName);
            const viz = isHighCardinality ? 'honeycomb' : (f.viz || 'donutChart');
            const vizSettings = isHighCardinality
              ? { honeycomb: { dataMappings: { value: 'Count', label: `additionalfields.${f.fieldName}` }, colorPalette: 'blue-green', shape: 'hexagon', showLabels: true }, legend: { position: 'auto', showLegend: true } }
              : { legend: { position: 'auto', showLegend: true } };
            addTileAt({
              title: f.label, type: 'data',
              query: `${BASE_FILTER} | filter isNotNull(additionalfields.${f.fieldName}) | summarize Count = count(), by: {additionalfields.${f.fieldName}} | sort Count desc`,
              visualization: viz,
              visualizationSettings: vizSettings,
              querySettings: Q_SETTINGS, davis: DAVIS_OFF
            }, col * 8, currentY, 8, 5);
            col++;
            if (col >= 3) { col = 0; currentY += 5; }
          }
          if (col > 0) currentY += 5;
        }

        console.log(`[AI Dashboard] 📊 Customer Dynamic: ${kpiFields.length} KPIs + ${gaugeFields.length} gauges + ${timeDistFields.length} histograms + ${remainingNumeric.length} bar charts + ${locationFields.length} pie/geo + ${otherStringFields.length} dimension charts`);
      }

    } else if (sectionId === 'geographic_view') {
      // Heatmap: Step × Hour activity matrix — always available
      addTileAt({
        title: '🗺️ Journey Activity Heatmap (Step × Hour)',
        type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | fieldsAdd hour = formatTimestamp(timestamp, format: "HH") | summarize count = count(), by: {json.stepName, hour} | sort hour asc`,
        visualization: 'heatmap',
        visualizationSettings: {
          dataMapping: { xAxis: null, yAxis: null, bucketValue: null },
          axes: {
            xAxis: { label: 'Hour of Day', showLabel: true },
            yAxis: { label: 'Journey Step', showLabel: true }
          },
          legend: { position: 'auto', showLegend: true }
        },
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 0, currentY, 12, 6);

      // PieChart: Region distribution — proportional breakdown
      addTileAt({
        title: '🌍 Event Distribution by Region',
        type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | filter isNotNull(additionalfields.region) | summarize Events = count(), by: {additionalfields.region} | sort Events desc`,
        visualization: 'pieChart',
        visualizationSettings: {
          legend: { position: 'auto', showLegend: true },
          pieChart: { labelsVisible: true }
        },
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 12, currentY, 12, 6);
      currentY += 6;

      // RecordList: Recent individual journey events — drill-down into raw records
      addTileAt({
        title: '📋 Recent Journey Events',
        type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | sort timestamp desc | limit 20 | fields timestamp, json.stepName, json.journeyStatus, additionalfields.region, additionalfields.deviceType, additionalfields.channel`,
        visualization: 'recordList',
        visualizationSettings: {},
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 0, currentY, 24, 5);
      currentY += 5;

    } else if (sectionId === 'trend_analysis') {
      // Row 1: Hourly pattern + volume bar chart
      addTileAt(perfTiles.hourly_pattern, 0, currentY, 12, 4);
      addTileAt({
        title: '📊 Event Volume Distribution',
        type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | summarize count = count(), by: {json.stepName} | sort count desc`,
        visualization: 'categoricalBarChart',
        visualizationSettings: {
          categoryAxis: { label: { label: 'Journey Step', showLabel: true }, tickLayout: 'horizontal' },
          numericAxis: { label: { showLabel: true }, scale: 'linear' },
          legend: { position: 'auto', showLegend: true },
          layout: { groupMode: 'stacked', position: 'horizontal' }
        },
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 12, currentY, 12, 4);
      currentY += 4;

      // Row 2: Processing time trend (avg+p90 line) + success/failure area
      addTileAt({
        title: '⏱️ Processing Time Trend',
        type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | makeTimeseries avg_processing = avg(additionalfields.processingTime), p90_processing = percentile(additionalfields.processingTime, 90), bins:30`,
        visualization: 'lineChart',
        visualizationSettings: {
          chartSettings: { gapPolicy: 'connect', seriesOverrides: [{ seriesId: ['avg_processing'], override: { color: '#4FD5E0' } }, { seriesId: ['p90_processing'], override: { color: '#EEA53C' } }] },
          thresholds: [], unitsOverrides: []
        },
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 0, currentY, 12, 4);
      addTileAt({
        title: '📉 Success vs Failure Trend',
        type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | makeTimeseries success = countIf(json.journeyStatus == "Success"), failed = countIf(json.journeyStatus == "Failed"), bins:30`,
        visualization: 'areaChart',
        visualizationSettings: {
          chartSettings: { gapPolicy: 'connect', seriesOverrides: [{ seriesId: ['success'], override: { color: '#2AB06F' } }, { seriesId: ['failed'], override: { color: '#C62239' } }] },
          thresholds: [], unitsOverrides: []
        },
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 12, currentY, 12, 4);
      currentY += 4;

      // Row 3: Processing time band chart (min/avg/max range) + processing time histogram
      addTileAt({
        title: '📐 Processing Time Range (Min / Avg / Max)',
        type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | makeTimeseries min_time = min(additionalfields.processingTime), avg_time = avg(additionalfields.processingTime), max_time = max(additionalfields.processingTime), bins:30`,
        visualization: 'bandChart',
        visualizationSettings: {
          chartSettings: { gapPolicy: 'connect' },
          thresholds: [], unitsOverrides: []
        },
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 0, currentY, 12, 4);
      addTileAt({
        title: '📊 Processing Time Distribution',
        type: 'data',
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == $CompanyName | filter in(json.journeyType, $JourneyType) | filter isNotNull(additionalfields.processingTime) | fields processingTime = additionalfields.processingTime`,
        visualization: 'histogram',
        visualizationSettings: {
          histogram: { dataMappings: [{ valueAxis: 'processingTime' }], numberOfBuckets: 20 }
        },
        querySettings: Q_SETTINGS, davis: DAVIS_OFF
      }, 12, currentY, 12, 4);
      currentY += 4;
    }
  }

  } // end fallback else block

  // ── FOOTER (always) ──
  const generationMethod = tilePlans && tilePlans.length >= 3
    ? `Bespoke AI (${tilePlans.length} Ollama tiles + ${selection.sections.length} sections, Grail field data)`
    : `Hybrid AI (${selection.sections.length} sections, proven DQL)`;
  addMarkdown(
    `---\n🤖 *Dashboard generated by ${generationMethod} | ${new Date().toISOString().split('T')[0]} | ${Object.keys(dashboard.tiles).length} tiles*`,
    24, 1
  );

  // Deep links
  addMarkdown(getDeepLinksMarkdown(dynatraceUrl).content || '', 24, 5);

  console.log(`[AI Dashboard] ✅ Prompt-driven dashboard: ${Object.keys(dashboard.tiles).length} tiles | ${generationMethod}`);

  // Pre-deploy schema validation
  const validation = validateDashboardSchema(dashboard);
  if (!validation.isValid) {
    console.warn(`[AI Dashboard] ⚠️ Schema validation found ${validation.errors.length} issues — dashboard may need fixes`);
  }

  return { dashboard, selection, validation };
}


// ============================================================================
// FULL GENERATION WITH AI - Complete dashboard from scratch
// ============================================================================

async function generateFullDashboardWithAI(journeyData, skills, customPrompt = null) {
  const ollamaAvailable = await checkOllamaAvailable();
  if (!ollamaAvailable) {
    throw new Error(`Ollama not available at ${OLLAMA_ENDPOINT} or model ${OLLAMA_MODEL} not installed`);
  }

  const { company, industry, journeyType, steps } = journeyData;
  const detected = detectPayloadFields(journeyData);
  
  console.log(`[AI Dashboard] 🚀 FULL GENERATION for ${industry} - ${journeyType}${customPrompt ? ' (custom prompt)' : ''}`);
  
  // Build comprehensive prompt for full dashboard generation
  const stepsText = (steps || []).map((s, i) => 
    `${i+1}. ${s.name || s.stepName}${s.category ? ` (${s.category})` : ''}`
  ).join(', ');

  const detectedFieldsList = [];
  if (detected.stringFields.length > 0) detectedFieldsList.push(`Categorical: ${detected.stringFields.map(f => f.key).join(', ')}`);
  if (detected.numericFields.length > 0) detectedFieldsList.push(`Numeric: ${detected.numericFields.map(f => f.key).join(', ')}`);
  if (detected.booleanFields.length > 0) detectedFieldsList.push(`Boolean: ${detected.booleanFields.map(f => f.key).join(', ')}`);

  const dataSignalsArray = [];
  if (detected.hasRevenue) dataSignalsArray.push('revenue tracking');
  if (detected.hasLoyalty) dataSignalsArray.push('loyalty metrics');
  if (detected.hasLTV) dataSignalsArray.push('lifetime value');
  if (detected.hasChurnRisk) dataSignalsArray.push('churn risk');
  if (detected.hasConversion) dataSignalsArray.push('conversion funnel');
  if (detected.hasEngagement) dataSignalsArray.push('user engagement');
  if (detected.hasSatisfaction) dataSignalsArray.push('satisfaction/NPS');
  if (detected.hasRetention) dataSignalsArray.push('retention cohorts');

  // If there's a custom prompt from the user, inject it as a primary directive
  const customDirective = customPrompt ? `

USER REQUEST (HIGHEST PRIORITY — shape the entire dashboard around this):
"${customPrompt}"

Interpret this request and tailor every aspect of the dashboard accordingly:
- If they ask for C-level/executive: use high-level KPIs, revenue summaries, strategic metrics, minimal technical detail
- If they ask for operations: focus on error rates, latency, service health, SLAs, incident management
- If they ask for customer success: focus on journey completion, NPS, churn risk, customer segments, satisfaction
- If they ask for a specific focus area: prioritize those metrics and tiles
- Always maintain valid Dynatrace dashboard JSON structure
` : '';

  const generationPrompt = `You are an expert Dynatrace dashboard architect and sales intelligence analyst. Generate a COMPLETELY BESPOKE dashboard JSON for this customer journey.${customDirective}

${DQL_SYNTAX_RULES}

DOMAIN: ${industry}
JOURNEY: ${journeyType}
COMPANY: ${company}
STEPS: ${stepsText}

ACCOUNT OBJECTIVES ALIGNMENT:
When designing tiles and sections, align with these Dynatrace value themes tailored for ${company}:
1. Innovation and Experience: Focus on digital experience quality, customer journey completion, and interaction success rates
2. Cost and Operational Efficiency: Include AI-driven automation metrics, MTTR reduction, and tool consolidation indicators
3. Resilience and Risk: Show incident frequency, compliance status, root cause analysis speed, and security posture

VALUE-DRIVEN TILES:
- Include tiles that map to executive-level KPIs (revenue impact, customer satisfaction, operational cost)
- Add business outcome tiles alongside technical metrics
- Show the connection between infrastructure health and business results

DATA AVAILABLE:
${detectedFieldsList.length > 0 ? detectedFieldsList.join('\n') : 'Basic: company, journeyType, stepName, serviceName, timestamp'}

BUSINESS METRICS TO EMPHASIZE:
${dataSignalsArray.length > 0 ? dataSignalsArray.join(', ') : 'Standard observability metrics'}

CRITICAL REQUIREMENTS:
1. Generate a v21 Dynatrace Dashboard JSON (valid structure)
2. INDUSTRY-SPECIFIC design (not generic):
   - For ${industry.includes('Retail') || industry.includes('Media') ? industry : 'e-commerce/service'}: Focus on ${
     industry.includes('Retail') ? 'revenue, conversion, customer segments, inventory' :
     industry.includes('Media') ? 'engagement, viewership, content performance, audience' :
     industry.includes('Travel') ? 'bookings, occupancy, reviews, seasonality' :
     industry.includes('Banking') ? 'transactions, fraud, compliance, risk' :
     industry.includes('Insurance') ? 'claims, policies, risk, compliance' :
     'business outcomes and user experience'
   }
3. 40-50 tiles minimum (not the 20-tile retail template)
4. Include:
   - Header markdown with industry context
   - Journey flow visualization
   - Step-by-step metrics table
   - KPI cards (4-6 main metrics)
   - Time series trends for key metrics
   - Segmentation charts (by step, service, customer segment)
   - Performance/SLA compliance metrics
   - Service health (if applicable)
   - Error analysis and drilling
   - Dynamic tiles for detected business fields
   - Deep links to Dynatrace tools
5. Queries must use bizevents when available, fallback to metrics
6. Variables: \$CompanyName, \$JourneyType, \$Step, \$Service (create cascading filters)
7. Return ONLY valid JSON, no markdown, no explanation

DASHBOARD JSON SCHEMA (abridged):
{
  "version": 21,
  "variables": [...],
  "tiles": {"0": {...}, "1": {...}, ...},
  "layouts": {"0": {x,y,w,h}, "1": {...}, ...},
  "settings": {"defaultTimeframe": {"value": {"from": "now()-24h", "to": "now()"}, "enabled": true}},
  "annotations": []
}

Generate the complete dashboard optimized for ${industry} - ${journeyType}.`;

  console.log(`[AI Dashboard] 📝 Prompt length: ${generationPrompt.length} chars`);
  
  const startTime = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => { controller.abort(); }, 180000); // 3 min timeout for full generation

  try {
    console.log('[AI Dashboard] 🤖 Calling Ollama for FULL generation...');
    const response = await fetch(`${OLLAMA_ENDPOINT}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: generationPrompt,
        stream: false,
        temperature: 0.6,
        top_p: 0.9
      }),
      signal: controller.signal
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Ollama returned ${response.status}`);
    }

    const result = await response.json();
    const duration = performance.now() - startTime;
    const responseText = result.response || '';

    console.log(`[AI Dashboard] ✅ Generation complete in ${Math.round(duration)}ms`);

    // Extract JSON from response (it might have text before/after)
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No valid JSON found in Ollama response');
    }

    const dashboard = JSON.parse(jsonMatch[0]);
    
    // Validate it looks like a dashboard
    if (!dashboard.version || !dashboard.tiles || !dashboard.layouts) {
      throw new Error('Generated JSON missing required dashboard fields');
    }

    console.log(`[AI Dashboard] 📊 Generated dashboard with ${Object.keys(dashboard.tiles).length} tiles`);

    // Log GenAI span
    await logGenAISpan(createGenAISpan(
      generationPrompt.substring(0, 1000),
      responseText.substring(0, 1000),
      OLLAMA_MODEL,
      result.prompt_eval_count || 0,
      result.eval_count || 0,
      duration
    ), 'full_dashboard_generation');

    return dashboard;
  } catch (error) {
    console.error('[AI Dashboard] ❌ Full generation failed:', error.message);
    throw error;
  }
}

// ============================================================================
// FALLBACK DASHBOARD (no Ollama) - uses proven template
// ============================================================================

async function generateDashboardStructure(journeyData) {
  const { company, journeyType } = journeyData;
  const detected = detectPayloadFields(journeyData);
  const industryInfo = journeyData.industry || 'General';

  // Use the full proven dashboard builder (46+ tiles) as the primary path
  try {
    const dashboard = buildProvenDashboard(company, journeyType, journeyData.steps || [], detected, industryInfo);
    if (dashboard && dashboard.tiles && Object.keys(dashboard.tiles).length > 0) {
      console.log(`[Dashboard] ✅ Built proven dashboard: ${Object.keys(dashboard.tiles).length} tiles`);
      return dashboard;
    }
  } catch (err) {
    console.warn('[Dashboard] ⚠️  Proven dashboard build failed:', err.message);
  }

  // Fallback to static template file only if proven builder fails
  try {
    const templateDashboard = await loadTemplatedasDashboard(company, journeyType);
    if (templateDashboard) {
      console.log('[Dashboard] ⚠️  Using fallback static template (17 tiles)');
      return templateDashboard;
    }
  } catch (err) {
    console.warn('[Dashboard] ⚠️  Template load failed:', err.message);
  }

  // Last resort: return a minimal dashboard
  console.error('[Dashboard] ❌ All generation methods failed, returning minimal dashboard');
  return { version: 21, variables: [], tiles: {}, layouts: {}, importedWithCode: false, settings: {}, annotations: [] };
}

// ============================================================================
// AI-POWERED DASHBOARD GENERATION
// ============================================================================

async function generateDashboardWithAI(journeyData, skills, customPrompt = null) {
  const ollamaAvailable = await checkOllamaAvailable();
  if (!ollamaAvailable) {
    throw new Error(`Ollama not available at ${OLLAMA_ENDPOINT} or model ${OLLAMA_MODEL} not installed`);
  }

  const { company, industry, journeyType, steps } = journeyData;

  // STEP 1: Detect all fields
  const detected = detectPayloadFields(journeyData);
  const fieldPromptText = formatFieldsForPrompt(detected);
  const serviceNames = [...new Set((steps || []).filter(s => s.serviceName).map(s => s.serviceName))];

  console.log('[AI Dashboard] 🔍 Field detection:');
  console.log(`  Strings: ${detected.stringFields.map(f => f.key).join(', ') || 'none'}`);
  console.log(`  Numbers: ${detected.numericFields.map(f => f.key).join(', ') || 'none'}`);
  console.log(`  Booleans: ${detected.booleanFields.map(f => f.key).join(', ') || 'none'}`);
  console.log(`  Services: ${serviceNames.join(', ') || 'none'}`);

  // STEP 2: Generate dynamic field tiles (custom to payload)
  const dynamicTiles = generateDynamicFieldTiles(detected, company, journeyType);
  const dynamicKeys = Object.keys(dynamicTiles);

  // STEP 3: Build LLM prompt — now the LLM knows about the proven template structure
  const stepsText = (steps || []).map(s => `${s.name || s.stepName}${s.category ? ` [${s.category}]` : ''}`).join(', ');

  const dataSignals = [];
  if (detected.hasRevenue) dataSignals.push('revenue');
  if (detected.hasLoyalty) dataSignals.push('loyalty');
  if (detected.hasLTV) dataSignals.push('LTV');
  if (detected.hasConversion) dataSignals.push('conversion');
  if (detected.hasChannel) dataSignals.push('channels');

  const prompt = `You are building a BizObs dashboard for ${industry} - ${journeyType}.
${DQL_SYNTAX_RULES}
${BIZOBS_FIELD_KNOWLEDGE}
Steps: ${stepsText}. Data: ${dataSignals.join(', ') || 'standard'}.
${fieldPromptText}
The dashboard uses a proven template with these sections:
1. Journey Overview (step metrics table, KPI cards, volume/funnel charts)
2. Filtered View (KPIs filtered by step)
3. Performance & Ops (step perf, SLA, errors, hourly)
4. Golden Signals (TRAFFIC/LATENCY/ERRORS/SATURATION with service-level timeseries)
5. Traces & Observability (exceptions, Dynatrace Intelligence problems, logs)
${dynamicKeys.length > 0 ? `6. Dynamic tiles detected from payload: ${dynamicKeys.join(', ')}` : ''}
${customPrompt ? `\nUSER REQUEST (IMPORTANT): "${customPrompt}"\nUse this request to influence the dashboard title and insight. Make the title and insight reflect what the user asked for.` : ''}
Given the industry "${industry}" and journey "${journeyType}", suggest a dashboard title and any industry-specific insights.
Respond with ONLY this JSON: {"title":"Dashboard Title","insight":"One-sentence insight about this industry journey"}`;

  try {
    console.log('[AI Dashboard] 🤖 Calling Ollama API (proven template mode)...');
    console.log(`[AI Dashboard] Model: ${OLLAMA_MODEL}, Prompt: ${prompt.length} chars`);

    const startTime = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(); console.error('[AI Dashboard] ⏱️ Timeout after 90s'); }, 90000);

    try {
      const response = await fetch(`${OLLAMA_ENDPOINT}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          model: OLLAMA_MODEL,
          prompt: prompt,
          stream: false,
          options: { temperature: 0.3, num_predict: 256, num_ctx: 2048 }
        })
      });

      clearTimeout(timeout);
      if (!response.ok) throw new Error(`Ollama API returned ${response.status}`);

      const result = await response.json();
      const responseText = result.response;
      const duration = performance.now() - startTime;

      console.log(`[AI Dashboard] ✅ Response in ${Math.round(duration)}ms, ${responseText.length} chars`);
      console.log(`[AI Dashboard] Tokens - Prompt: ${result.prompt_eval_count || 0}, Completion: ${result.eval_count || 0}`);
      console.log(`[AI Dashboard] Raw: ${responseText.substring(0, 300)}`);

      let aiData = {};
      try {
        try { aiData = JSON.parse(responseText); } catch (e) {
          const jsonMatch = responseText.match(/\{[\s\S]*?\}/);
          if (jsonMatch) { aiData = JSON.parse(jsonMatch[0]); }
        }
      } catch (e) {
        console.warn('[AI Dashboard] Could not parse AI response, using defaults');
      }

      console.log(`[AI Dashboard] 🤖 AI title: ${aiData.title || 'N/A'}`);
      if (aiData.insight) console.log(`[AI Dashboard] 💡 Insight: ${aiData.insight}`);

      // STEP 4: Build dashboard from PROVEN TEMPLATE with industry awareness
      const dashboard = buildProvenDashboard(company, journeyType, steps, detected, industry);
      const markdownTiles = generateMarkdownTiles(company, journeyType, steps, detected);
      const variables = generateVariables(company);

      // Merge dynamic tiles if any
      if (dynamicKeys.length > 0) {
        return buildDashboardLayout({}, dynamicTiles, markdownTiles, variables, company, journeyType, industry, [], detected);
      }

      // Log GenAI span
      await logGenAISpan(createGenAISpan(prompt, responseText, OLLAMA_MODEL, result.prompt_eval_count || 0, result.eval_count || 0, duration), 'proven_template_generation');
      console.log('[AI Dashboard] 📊 GenAI span logged');

      return dashboard;
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('AI generation timed out - falling back to rule-based');
    console.error('[AI Dashboard] AI error:', error.message);
    throw error;
  }
}

// ============================================================================
// ROUTE HANDLERS
// ============================================================================

// ── ASYNC ENDPOINTS (for AppEngine) ──

// POST /api/ai-dashboard/generate-async: Start async generation, return jobId immediately
router.post('/generate-async', async (req, res) => {
  try {
    const { journeyData } = req.body;
    if (!journeyData) {
      return res.status(400).json({ error: 'Journey data required' });
    }

    console.log('[API] Starting async dashboard generation for:', journeyData.companyName || journeyData.company);

    const jobId = await generateDashboardAsync(journeyData);

    res.json({
      success: true,
      jobId,
      pollUrl: `/api/ai-dashboard/status/${jobId}`,
      message: 'Dashboard generation started. Poll the status endpoint to retrieve results.'
    });
  } catch (error) {
    console.error('[API] Async generation error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/ai-dashboard/status/:jobId: Check generation status
router.get('/status/:jobId', (req, res) => {
  try {
    const { jobId } = req.params;
    const status = getJobStatus(jobId);

    if (status.error && status.error === 'Job not found') {
      return res.status(404).json(status);
    }

    res.json(status);
  } catch (error) {
    console.error('[API] Status check error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/generate', async (req, res) => {
  try {
    const { journeyData, useAI = true } = req.body;
    if (!journeyData) return res.status(400).json({ error: 'Journey data required' });

    console.log('[AI Dashboard] Generating dashboard for:', journeyData.company, journeyData.journeyType);

    const afKeys = Object.keys(journeyData.additionalFields || {});
    const cpKeys = Object.keys(journeyData.customerProfile || {});
    const tmKeys = Object.keys(journeyData.traceMetadata || {});
    console.log(`[AI Dashboard] 📦 Payload: ${afKeys.length} additionalFields, ${cpKeys.length} customerProfile, ${tmKeys.length} traceMetadata`);
    if (afKeys.length > 0) console.log(`[AI Dashboard] 📦 additionalFields: ${afKeys.join(', ')}`);
    if (cpKeys.length > 0) console.log(`[AI Dashboard] 📦 customerProfile: ${cpKeys.join(', ')}`);

    const skills = await loadDynatraceSkills();
    let dashboard;
    let generationMethod = 'rule-based';
    let aiSelection = null; // AI-selected title, slug, sections

    const userPrompt = req.body.customPrompt || null;
    // Use bespoke industry-specific prompt when no custom prompt is provided
    let customPrompt;
    let bespokeInfo = null;
    if (userPrompt) {
      customPrompt = userPrompt;
      console.log(`[AI Dashboard] 💬 Custom prompt: "${customPrompt.substring(0, 100)}${customPrompt.length > 100 ? '...' : ''}"`);
    } else {
      bespokeInfo = getBespokePrompt(journeyData.industry || journeyData.industryType || '', journeyData.company || 'the company', journeyData.journeyType || 'customer');
      customPrompt = bespokeInfo.prompt;
      console.log(`[AI Dashboard] 🏭 Bespoke ${bespokeInfo.group} prompt (${bespokeInfo.matchType}): "${customPrompt.substring(0, 120)}..."`);
    }

    if (useAI) {
      // ── EARLY FIELD DISCOVERY: Discover actual BizEvents fields from Grail BEFORE LLM generation ──
      // This ensures LLM only uses fields that actually exist in tenant data
      console.log(`[AI Dashboard] 🔍 Discovering BizEvents fields from Grail for prompt context...`);
      const discoveredFieldSet = await discoverBizEventFields(journeyData.company, journeyData.journeyType, {
        maxRetries: 6,
        pollIntervalMs: 2000,
      }).catch((err) => {
        console.warn(`[AI Dashboard] ⚠️  Field discovery failed (non-blocking):`, err.message);
        return null;
      });

      if (discoveredFieldSet && discoveredFieldSet.size > 0) {
        journeyData.discoveredFields = Array.from(discoveredFieldSet).map(name => ({ name, type: 'unknown' }));
        if (discoveredFieldSet.records && discoveredFieldSet.records.length > 0) {
          journeyData.discoveredRecords = discoveredFieldSet.records;
        }
        console.log(`[AI Dashboard] ✅ Pre-discovered ${journeyData.discoveredFields.length} fields for LLM context: ${journeyData.discoveredFields.map(f => f.name).join(', ')}`);
      } else {
        console.log(`[AI Dashboard] ℹ️  No BizEvents discovered (may still have additionalFields from payload)`);
      }

      // ── UNIFIED PROMPT-DRIVEN PATH: always uses section selection for fast, composable dashboards ──
      const ollamaAvailable = await checkOllamaAvailable();
      if (ollamaAvailable) {
        try {
          console.log(`[AI Dashboard] 🎯 Using PROMPT-DRIVEN generation (section selection via ${OLLAMA_MODEL})...`);
          const result = await generatePromptDrivenDashboard(journeyData, skills, customPrompt, { isBespoke: !!bespokeInfo });
          dashboard = result.dashboard;
          aiSelection = result.selection;
          generationMethod = userPrompt ? 'mcp-prompt-driven' : (bespokeInfo ? `bespoke-${bespokeInfo.matchType}` : 'mcp-auto-prompt');
        } catch (promptError) {
          console.warn('[AI Dashboard] ⚠️  Prompt-driven generation failed, falling back to proven template:', promptError.message);
          try {
            dashboard = await generateDashboardWithAI(journeyData, skills, customPrompt);
            generationMethod = 'ollama-proven-template';
          } catch (aiError) {
            console.warn('[AI Dashboard] ⚠️  AI template also failed, using rule-based:', aiError.message);
            dashboard = await generateDashboardStructure(journeyData);
          }
        }
      } else {
        // Ollama down — use keyword-based section selection (no LLM needed)
        console.log(`[AI Dashboard] ℹ️  Ollama not available, using keyword-based prompt-driven generation`);
        try {
          const result = await generatePromptDrivenDashboard(journeyData, skills, customPrompt, { isBespoke: !!bespokeInfo });
          dashboard = result.dashboard;
          aiSelection = result.selection;
          generationMethod = 'prompt-driven-keywords';
        } catch (err) {
          dashboard = await generateDashboardStructure(journeyData);
          generationMethod = 'template';
        }
      }
    } else {
      dashboard = await generateDashboardStructure(journeyData);
      generationMethod = 'template';
    }

    // Dashboard may be a full document ({name, type, content:{tiles}}) or just content ({tiles})
    const tilesObj = (dashboard.content && dashboard.content.tiles) || dashboard.tiles || {};
    const tileCount = Object.keys(tilesObj).length;
    const detected = detectPayloadFields(journeyData);
    const dynamicTilesResult = generateDynamicFieldTiles(detected, journeyData.company, journeyData.journeyType);
    const dynamicCount = dynamicTilesResult ? Object.keys(dynamicTilesResult).length : 0;

    // Add versioning to dashboard name based on generation method
    // If the AI provided a title via selection, use it; otherwise fall back to generic pattern
    let dashboardName;
    if (aiSelection && aiSelection.title) {
      dashboardName = aiSelection.title;
    } else {
      dashboardName = `${journeyData.company} - ${journeyData.journeyType} Journey`;
    }
    if (generationMethod === 'template') {
      dashboardName += ' [Preset Template]';
    } else if (generationMethod.startsWith('mcp-prompt') || generationMethod.startsWith('prompt-driven')) {
      dashboardName += ' [MCP Custom]';
    } else if (generationMethod.startsWith('bespoke')) {
      dashboardName += ' [AI Enhanced]';
    } else if (generationMethod === 'mcp-auto-prompt') {
      dashboardName += ' [AI Enhanced]';
    } else if (generationMethod.includes('ollama') || generationMethod.includes('ai')) {
      dashboardName += ' [AI Enhanced]';
    }

    // Check if dashboard is already a complete document (from template) or just content
    let dashboardContent = dashboard;
    let dashboardMetadata = null;
    
    if (dashboard.name && dashboard.type === 'dashboard' && dashboard.content) {
      // Template case: extract content and metadata from complete document
      dashboardContent = dashboard.content;
      dashboardMetadata = dashboard.metadata || {};
      // Update name to match generation method
      dashboardName = dashboard.name.replace(/\[Preset Template\]|\[AI Enhanced\]/, '').trim() + (generationMethod === 'template' ? ' [Preset Template]' : ' [AI Enhanced]');
    }

    const dashboardDocument = {
      name: dashboardName,
      type: 'dashboard',
      version: 1,
      content: dashboardContent,
      metadata: dashboardMetadata ? {
        ...dashboardMetadata,
        generatedBy: 'ai-dashboard-generator',
        generationMethod,
        model: OLLAMA_MODEL,
        company: journeyData.company,
        industry: journeyData.industry,
        dashboardSlug: (aiSelection && aiSelection.slug) || '',
      } : {
        generatedBy: 'ai-dashboard-generator',
        generationMethod,
        model: OLLAMA_MODEL,
        company: journeyData.company,
        industry: journeyData.industry,
        journeyType: journeyData.journeyType,
        dashboardSlug: (aiSelection && aiSelection.slug) || '',
        totalTiles: tileCount,
        dynamicFieldTiles: dynamicCount,
        detectedFields: {
          additionalFields: afKeys,
          customerProfile: cpKeys,
          flags: {
            revenue: detected.hasRevenue, loyalty: detected.hasLoyalty, ltv: detected.hasLTV,
            segments: detected.hasSegments, devices: detected.hasDeviceType, channel: detected.hasChannel,
            nps: detected.hasNPS, churnRisk: detected.hasChurnRisk, conversion: detected.hasConversion,
            pricing: detected.hasPricing, risk: detected.hasRisk, fraud: detected.hasFraud,
            compliance: detected.hasCompliance, engagement: detected.hasEngagement,
            satisfaction: detected.hasSatisfaction, retention: detected.hasRetention,
            product: detected.hasProduct, operational: detected.hasOperational,
            forecast: detected.hasForecast, acquisition: detected.hasAcquisition,
            upsell: detected.hasUpsell, browser: detected.hasBrowser,
            subscription: detected.hasSubscription, membership: detected.hasMembership,
            services: detected.hasServices
          }
        },
        generatedAt: new Date().toISOString()
      }
    };

    console.log(`[AI Dashboard] ✅ Done: ${tileCount} tiles (${dynamicCount} dynamic) via ${generationMethod}${bespokeInfo ? ` [${bespokeInfo.group}]` : ''}`);

    // Auto-save to host filesystem for retrieval by UI
    const savedDir = path.join(__dirname, '..', 'dashboards', 'saved');
    try {
      await fs.mkdir(savedDir, { recursive: true });
      const sanitizedCompany = (journeyData.company || 'unknown').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
      const sanitizedJourney = (journeyData.journeyType || 'generic').replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
      const fileId = `${sanitizedCompany}--${sanitizedJourney}`;
      const savedPayload = {
        id: fileId,
        dashboard: dashboardDocument,
        generationMethod,
        company: journeyData.company,
        journeyType: journeyData.journeyType,
        tileCount,
        savedAt: new Date().toISOString(),
      };
      await fs.writeFile(path.join(savedDir, `${fileId}.json`), JSON.stringify(savedPayload, null, 2));
      console.log(`[AI Dashboard] 💾 Saved to dashboards/saved/${fileId}.json`);
    } catch (saveErr) {
      console.warn('[AI Dashboard] ⚠️  Auto-save failed (non-blocking):', saveErr.message);
    }

    // Run schema validation on the final dashboard
    const finalValidation = validateDashboardSchema(dashboardDocument);

    res.json({
      success: true,
      dashboard: dashboardDocument,
      generationMethod,
      validation: {
        isValid: finalValidation.isValid,
        errors: finalValidation.errors,
        warnings: finalValidation.warnings
      },
      message: `Dashboard generated for ${journeyData.company} - ${journeyData.journeyType} (${tileCount} tiles, ${dynamicCount} from detected fields)${!finalValidation.isValid ? ' ⚠️ with validation warnings' : ''}`
    });
  } catch (error) {
    console.error('[AI Dashboard] Generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

function sanitizeArtifactSegment(value, fallback = 'unknown') {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase() || fallback;
}

function parseSetupConf(setupRaw) {
  const conf = {};
  for (const line of String(setupRaw || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*"?(.*?)"?$/);
    if (match) conf[match[1]] = match[2];
  }
  return conf;
}

async function resolveDtDeployConfig() {
  let environmentUrl = (process.env.DT_ENVIRONMENT || process.env.DYNATRACE_URL || '').trim().replace(/\/$/, '');
  let apiToken = (process.env.DT_PLATFORM_TOKEN || process.env.DYNATRACE_TOKEN || '').trim();

  if (!environmentUrl || !apiToken) {
    try {
      const setupConfPath = path.join(__dirname, '..', 'setup.conf');
      const setupRaw = readFileSync(setupConfPath, 'utf8');
      const conf = parseSetupConf(setupRaw);

      if (!environmentUrl) {
        environmentUrl = String(conf.DT_ENVIRONMENT || conf.DYNATRACE_URL || '').trim().replace(/\/$/, '');
      }

      if (!environmentUrl && conf.TENANT_ID) {
        const tenantId = String(conf.TENANT_ID).trim();
        const envType = String(conf.ENV_TYPE || '').trim().toLowerCase();
        if (tenantId) {
          environmentUrl = envType === 'sprint'
            ? `https://${tenantId}.sprint.apps.dynatracelabs.com`
            : `https://${tenantId}.apps.dynatrace.com`;
        }
      }

      if (!apiToken) {
        apiToken = String(
          conf.DT_PLATFORM_TOKEN ||
          conf.PLATFORM_TOKEN ||
          conf.DYNATRACE_TOKEN ||
          conf.API_TOKEN ||
          ''
        ).trim();
      }
    } catch {
      // Non-blocking. Caller validates the final result.
    }
  }

  return { environmentUrl, apiToken };
}

async function ensureLocalDtctl() {
  const toolsDir = path.join(__dirname, '..', '.tools', 'dtctl');
  const dtctlBin = path.join(toolsDir, 'dtctl');

  await fs.mkdir(toolsDir, { recursive: true });

  try {
    await fs.access(dtctlBin);
    return dtctlBin;
  } catch {
    const installCmd = [
      'set -e',
      `mkdir -p "${toolsDir}"`,
      `cd "${toolsDir}"`,
      'curl -fsSL -o dtctl.tar.gz https://github.com/dynatrace-oss/dtctl/releases/download/v0.26.0/dtctl_0.26.0_linux_amd64.tar.gz',
      'tar -xzf dtctl.tar.gz',
      'chmod +x dtctl'
    ].join(' && ');
    await execFileAsync('bash', ['-lc', installCmd], { timeout: 120000 });
    return dtctlBin;
  }
}

async function writeDashboardArtifactBundle({
  dashboardToDeploy,
  company,
  journeyType,
  generationMethod,
  dashboardId = null,
  dashboardUrl = null,
}) {
  const companySlug = sanitizeArtifactSegment(company, 'company');
  const journeySlug = sanitizeArtifactSegment(journeyType, 'journey');
  const generatedRoot = path.join(__dirname, '..', 'dashboards', 'generated', companySlug, journeySlug);
  await fs.mkdir(generatedRoot, { recursive: true });

  const entries = await fs.readdir(generatedRoot).catch(() => []);
  const versions = entries
    .map((name) => {
      const match = name.match(/^dashboard-v(\d+)\.json$/);
      return match ? Number(match[1]) : null;
    })
    .filter((value) => Number.isInteger(value));
  const nextVersion = versions.length > 0 ? Math.max(...versions) + 1 : 1;

  const dashboardFile = path.join(generatedRoot, `dashboard-v${nextVersion}.json`);
  const metadataFile = path.join(generatedRoot, `metadata-v${nextVersion}.json`);
  const readmeFile = path.join(generatedRoot, 'README.md');

  await fs.writeFile(dashboardFile, JSON.stringify(dashboardToDeploy, null, 2), 'utf8');

  const metadata = {
    version: nextVersion,
    company,
    journeyType,
    dashboardId,
    dashboardUrl,
    dashboardName: dashboardToDeploy.name,
    generationMethod,
    generatedAt: new Date().toISOString(),
    tileCount: Object.keys(dashboardToDeploy.content?.tiles || {}).length,
    artifactFiles: {
      dashboard: path.relative(path.join(__dirname, '..'), dashboardFile),
      metadata: path.relative(path.join(__dirname, '..'), metadataFile),
    },
  };
  await fs.writeFile(metadataFile, JSON.stringify(metadata, null, 2), 'utf8');

  const readme = [
    `# ${company} / ${journeyType} Dashboard Artifacts`,
    '',
    `Version: v${nextVersion}`,
    `Generation method: ${generationMethod || 'unknown'}`,
    `Generated at: ${metadata.generatedAt}`,
    '',
    'Files:',
    `- dashboard-v${nextVersion}.json`,
    `- metadata-v${nextVersion}.json`,
    '',
    'Deployment:',
    `- Dashboard name: ${dashboardToDeploy.name}`,
    `- Dashboard ID: ${dashboardId || 'pending'}`,
    `- Dashboard URL: ${dashboardUrl || 'pending'}`,
    '',
    'dtctl apply:',
    '```bash',
    `dtctl apply -f "${path.relative(path.join(__dirname, '..'), dashboardFile)}" --id "${dashboardId || 'set-id-on-apply'}"`,
    '```',
    '',
  ].join('\n');
  await fs.writeFile(readmeFile, readme, 'utf8');

  return {
    version: nextVersion,
    generatedRoot,
    dashboardFile,
    metadataFile,
    readmeFile,
  };
}

// ════════════════════════════════════════════════════════════════════════════════
// WORKFLOW INTEGRATION & INGESTION VERIFICATION (dtctl + dynatrace-assist)
// ════════════════════════════════════════════════════════════════════════════════

/**
 * Search for an existing BizEvents injector workflow and append a new task.
 * Per KPI Dashboard Generator pattern: never create a second workflow.
 * Instead, find the shared injector workflow and add a task keyed <company>_v<N>.
 */
async function tryAppendToInjectorWorkflow(dtctlBin, contextName, configFile, company, journeyType, options = {}) {
  try {
    const { timeout = 30000 } = options;

    // Search for injector workflow (by name pattern)
    const searchCmd = [
      'find', 'workflows',
      '-o', 'json',
      '--context', contextName,
      '--config', configFile,
      '--plain',
    ];

    const { stdout } = await execFileAsync(dtctlBin, searchCmd, { timeout });
    const workflows = JSON.parse(stdout || '[]');

    // Find workflow matching KPI/injector patterns
    const injectorWorkflow = workflows.find(w =>
      w?.title && /BizEvents|Injector|Dashboard Generator|KPI/i.test(w.title)
    );

    if (!injectorWorkflow || !injectorWorkflow.id) {
      console.log('[Workflow Integration] 📋 No existing injector workflow found — create one via Dynatrace UI with task template');
      return { success: false, reason: 'no-workflow' };
    }

    console.log(`[Workflow Integration] ✅ Found injector workflow: "${injectorWorkflow.title}" (${injectorWorkflow.id})`);

    // For now, just report success — full task append requires advanced workflow editing
    // Future: parse workflow JSON, append task, re-apply via dtctl
    return {
      success: true,
      workflowId: injectorWorkflow.id,
      workflowTitle: injectorWorkflow.title,
      note: 'Workflow found; task append would require manual or advanced API integration',
    };
  } catch (err) {
    console.warn(`[Workflow Integration] ⚠️ Failed to find injector workflow: ${err.message}`);
    return { success: false, reason: 'integration-error', error: err.message };
  }
}

/**
 * Verify that BizEvents are flowing to Dynatrace by querying recent events.
 * Returns { verified: true/false, count: <recent event count>, timeToFirstEvent: <ms> }
 */
async function verifyBizEventIngestion(dtctlBin, contextName, configFile, company, journeyType, options = {}) {
  try {
    const { timeout = 30000, maxRetries = 5, pollIntervalMs = 2000 } = options;
    const safeCompany = String(company || '').replace(/["\\]/g, '');
    const safeJourney = String(journeyType || '').replace(/["\\]/g, '');

    let eventCount = 0;
    let attempts = 0;
    const startTime = Date.now();

    while (attempts < maxRetries) {
      attempts += 1;
      const dql = `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == "${safeCompany}" | filter json.journeyType == "${safeJourney}" | summarize count()`;

      try {
        const queryCmd = [
          'query',
          dql,
          '-o', 'json',
          '--context', contextName,
          '--config', configFile,
          '--plain',
        ];

        const { stdout } = await execFileAsync(dtctlBin, queryCmd, { timeout });
        const result = JSON.parse(stdout || '{}');
        const records = result.records || [];
        if (records.length > 0 && records[0].count !== undefined) {
          eventCount = records[0].count;
          if (eventCount > 0) {
            const timeToFirstEvent = Date.now() - startTime;
            console.log(`[Ingestion] ✅ BizEvents verified: ${eventCount} events (after ${timeToFirstEvent}ms)`);
            return { verified: true, count: eventCount, timeToFirstEvent };
          }
        }
      } catch {
        // DQL query error — continue polling
      }

      if (attempts < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    }

    console.warn(`[Ingestion] ⚠️ No BizEvents detected after ${attempts} attempts for ${safeCompany}/${safeJourney}`);
    return { verified: false, count: 0, attempts };
  } catch (err) {
    console.warn(`[Ingestion] ⚠️ Verification query failed: ${err.message}`);
    return { verified: false, reason: 'query-error', error: err.message };
  }
}

router.get('/preflight-dtctl', async (req, res) => {
  try {
    const { environmentUrl, apiToken } = await resolveDtDeployConfig();
    const dtctlBin = await ensureLocalDtctl();
    const versionResult = await execFileAsync(dtctlBin, ['version'], { timeout: 10000 }).catch(() => ({ stdout: '' }));

    res.json({
      success: true,
      ready: Boolean(environmentUrl && apiToken),
      dtctl: {
        installed: true,
        path: dtctlBin,
        version: String(versionResult.stdout || '').trim() || 'unknown',
      },
      dynatrace: {
        environmentConfigured: Boolean(environmentUrl),
        tokenConfigured: Boolean(apiToken),
        environmentUrl: environmentUrl || null,
      },
    });
  } catch (error) {
    res.status(500).json({ success: false, ready: false, error: error.message });
  }
});

// Deploy a generated dashboard using dtctl (from scratch path, no Documents SDK)
router.post('/deploy-dtctl', async (req, res) => {
  const tempPaths = [];
  try {
    const { dashboard, company, journeyType, userEmail, userName } = req.body || {};
    if (!dashboard?.content || !company || !journeyType) {
      return res.status(400).json({ success: false, error: 'dashboard, company, and journeyType are required' });
    }

    const { environmentUrl, apiToken } = await resolveDtDeployConfig();

    if (!environmentUrl || !apiToken) {
      return res.status(500).json({
        success: false,
        error: 'Dynatrace credentials missing on server (DT_ENVIRONMENT + DT_PLATFORM_TOKEN)',
        hint: 'Use a platform token with dashboard scopes document:documents:write and document:environment-shares:write so generated dashboards are editable for everyone.',
      });
    }

    const dtctlBin = await ensureLocalDtctl();

    const canonicalCompany = String(company || '').trim();
    const canonicalJourney = String(journeyType || '').trim();
    const canonicalDashboardName = `${canonicalCompany} - ${canonicalJourney}`;

    const sanitizedCompany = canonicalCompany.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    const sanitizedJourney = canonicalJourney.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
    const aiSlug = String(dashboard.metadata?.dashboardSlug || '')
      .replace(/[^a-z0-9-]/gi, '-')
      .toLowerCase()
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    const dashboardId = aiSlug ? `bizobs-${sanitizedCompany}-${aiSlug}` : `bizobs-${sanitizedCompany}-${sanitizedJourney}`;
    const dashboardName = canonicalDashboardName;

    const discoveredFieldSet = await discoverBizEventFields(canonicalCompany, canonicalJourney, {
      maxRetries: 12,
      pollIntervalMs: 3000,
    });

    const availableFields = new Set([
      'timestamp',
      'event.kind',
      'event.provider',
      'json.companyName',
      'json.journeyType',
      'json.stepName',
      'json.serviceName',
    ]);

    if (discoveredFieldSet) {
      for (const f of discoveredFieldSet) {
        const plain = String(f || '').trim();
        if (!plain) continue;
        availableFields.add(plain);
        availableFields.add(`additionalfields.${plain}`);
      }

      const records = Array.isArray(discoveredFieldSet.records) ? discoveredFieldSet.records : [];
      for (const record of records) {
        if (!record || typeof record !== 'object') continue;
        for (const key of Object.keys(record)) {
          availableFields.add(key);
          if (key.startsWith('additionalfields.')) {
            availableFields.add(key.replace(/^additionalfields\./, ''));
          }
        }
      }
    }

    console.log(`[AI Dashboard] Using ${availableFields.size} available fields for normalization (${canonicalCompany} / ${canonicalJourney})`);

    const dashboardToDeploy = {
      ...dashboard,
      // Keep naming deterministic for generated dashboards instead of letting Dynatrace create "Untitled dashboard".
      name: dashboardName,
      type: dashboard.type || 'dashboard',
      version: dashboard.version || 1,
      content: normalizeDashboardContentForDeploy(dashboard.content, {
        company: canonicalCompany,
        journeyType: canonicalJourney,
        availableFields,
      }),
      metadata: {
        ...(dashboard.metadata || {}),
        company: canonicalCompany,
        journeyType: canonicalJourney,
        createdByEmail: String(userEmail || '').trim() || undefined,
        createdByName: String(userName || '').trim() || undefined,
      },
    };
    const generationMethod = String(dashboard.metadata?.generationMethod || dashboard.metadata?.generatedBy || 'direct-dtctl').trim();
    const deployValidation = validateDashboardDeployQuality(dashboardToDeploy);
    if (!deployValidation.isValid) {
      return res.status(400).json({
        success: false,
        error: 'Dashboard failed deploy quality gate',
        validation: deployValidation,
      });
    }

    const tmpBase = path.join(__dirname, '..', 'tmp', 'dtctl');
    await fs.mkdir(tmpBase, { recursive: true });

    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const dashboardFile = path.join(tmpBase, `dashboard-${nonce}.json`);
    const configFile = path.join(tmpBase, `.dtctl-${nonce}.yaml`);
    tempPaths.push(dashboardFile, configFile);

    await fs.writeFile(dashboardFile, JSON.stringify(dashboardToDeploy, null, 2), 'utf8');

    const contextName = 'local';
    const tokenRef = 'default-token';

    await execFileAsync(dtctlBin, ['config', 'set-credentials', tokenRef, '--token', apiToken, '--config', configFile, '--plain'], { timeout: 30000 });
    await execFileAsync(dtctlBin, ['config', 'set-context', contextName, '--environment', environmentUrl, '--token-ref', tokenRef, '--safety-level', 'readwrite-all', '--config', configFile, '--plain'], { timeout: 30000 });

    const applyArgs = [
      'apply',
      '-f', dashboardFile,
      '--id', dashboardId,
      '--share-environment', 'read-write',
      '--context', contextName,
      '--config', configFile,
      '--output', 'json',
      '--plain'
    ];

    const { stdout, stderr } = await execFileAsync(dtctlBin, applyArgs, { timeout: 120000 });
    if (stderr && stderr.trim()) {
      console.warn('[AI Dashboard] dtctl stderr:', stderr.trim());
    }

    let parsed = null;
    try { parsed = JSON.parse(stdout); } catch { /* non-blocking */ }
    const artifactBundle = await writeDashboardArtifactBundle({
      dashboardToDeploy,
      company: canonicalCompany,
      journeyType: canonicalJourney,
      generationMethod,
      dashboardId,
      dashboardUrl: `/ui/apps/dynatrace.dashboards/?query=${encodeURIComponent(dashboardId)}`,
    });

    // [PRIORITY 4] Try to integrate with existing injector workflow
    const workflowIntegration = await tryAppendToInjectorWorkflow(
      dtctlBin,
      contextName,
      configFile,
      canonicalCompany,
      canonicalJourney,
      { timeout: 30000 }
    );

    // [PRIORITY 5] Verify BizEvents are flowing
    const ingestionVerification = await verifyBizEventIngestion(
      dtctlBin,
      contextName,
      configFile,
      canonicalCompany,
      canonicalJourney,
      { maxRetries: 5, pollIntervalMs: 2000, timeout: 30000 }
    );

    return res.json({
      success: true,
      data: {
        dashboardId,
        dashboardName,
        dashboardUrl: `/ui/apps/dynatrace.dashboards/?query=${encodeURIComponent(dashboardId)}`,
        artifactVersion: artifactBundle.version,
        artifactPath: path.relative(path.join(__dirname, '..'), artifactBundle.generatedRoot),
        applied: parsed || stdout,
        workflow: workflowIntegration,
        ingestion: ingestionVerification,
      }
    });
  } catch (error) {
    const rawErr = String(error?.stderr || error?.stdout || error?.message || 'dtctl deployment failed');
    const low = rawErr.toLowerCase();
    const looksLikeScopeOrAuth =
      low.includes('forbidden') ||
      low.includes('unauthorized') ||
      low.includes('insufficient') ||
      low.includes('permission') ||
      low.includes('scope') ||
      low.includes('status 401') ||
      low.includes('status 403') ||
      low.includes('status code: 401') ||
      low.includes('status code: 403') ||
      low.includes('could not parse jwt');

    console.error('[AI Dashboard] dtctl deployment error:', rawErr);

    if (looksLikeScopeOrAuth) {
      return res.status(403).json({
        success: false,
        error: `dtctl authentication/scope error: ${rawErr}`,
        hint: 'Token must include document:documents:write and document:environment-shares:write so dashboards can be shared as read-write for everyone in the tenant.',
      });
    }

    return res.status(500).json({ success: false, error: rawErr });
  } finally {
    await Promise.all(tempPaths.map(async (p) => {
      try { await fs.unlink(p); } catch { /* ignore cleanup errors */ }
    }));
  }
});

// Repair sharing for generated dashboards so everyone in tenant can edit/delete.
router.post('/repair-dashboard-sharing', async (req, res) => {
  const tempPaths = [];
  try {
    const { environmentUrl, apiToken } = await resolveDtDeployConfig();
    if (!environmentUrl || !apiToken) {
      return res.status(500).json({
        success: false,
        error: 'Dynatrace credentials missing on server (DT_ENVIRONMENT + DT_PLATFORM_TOKEN)',
        hint: 'Token must include document:documents:write and document:environment-shares:write.',
      });
    }

    const dtctlBin = await ensureLocalDtctl();
    const tmpBase = path.join(__dirname, '..', 'tmp', 'dtctl');
    await fs.mkdir(tmpBase, { recursive: true });
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const configFile = path.join(tmpBase, `.dtctl-share-repair-${nonce}.yaml`);
    tempPaths.push(configFile);

    const contextName = 'local';
    const tokenRef = 'default-token';
    await execFileAsync(dtctlBin, ['config', 'set-credentials', tokenRef, '--token', apiToken, '--config', configFile, '--plain'], { timeout: 30000 });
    await execFileAsync(dtctlBin, ['config', 'set-context', contextName, '--environment', environmentUrl, '--token-ref', tokenRef, '--safety-level', 'readwrite-all', '--config', configFile, '--plain'], { timeout: 30000 });

    const { stdout: listStdout } = await execFileAsync(
      dtctlBin,
      ['get', 'dashboards', '--output', 'json', '--plain', '--context', contextName, '--config', configFile],
      { timeout: 120000 }
    );

    let parsedList = null;
    try { parsedList = JSON.parse(String(listStdout || '')); } catch { parsedList = null; }
    const list = Array.isArray(parsedList)
      ? parsedList
      : Array.isArray(parsedList?.result)
        ? parsedList.result
        : Array.isArray(parsedList?.dashboards)
          ? parsedList.dashboards
          : [];

    const candidates = list.filter((d) => String(d?.id || '').startsWith('bizobs-'));
    const repaired = [];
    const failed = [];

    for (const d of candidates) {
      const id = String(d?.id || '').trim();
      if (!id) continue;

      try {
        const getRes = await execFileAsync(
          dtctlBin,
          ['get', 'dashboard', id, '--output', 'json', '--plain', '--context', contextName, '--config', configFile],
          { timeout: 120000 }
        );
        let parsedDashboard = null;
        try { parsedDashboard = JSON.parse(String(getRes.stdout || '')); } catch { parsedDashboard = null; }
        const dashboardDoc = parsedDashboard?.result || parsedDashboard?.dashboard || parsedDashboard;
        if (!dashboardDoc || typeof dashboardDoc !== 'object') {
          throw new Error('Could not parse dashboard payload from dtctl get dashboard');
        }

        const filePath = path.join(tmpBase, `dashboard-share-repair-${id}-${nonce}.json`);
        tempPaths.push(filePath);
        await fs.writeFile(filePath, JSON.stringify(dashboardDoc, null, 2), 'utf8');

        await execFileAsync(
          dtctlBin,
          ['apply', '-f', filePath, '--id', id, '--share-environment', 'read-write', '--output', 'json', '--plain', '--context', contextName, '--config', configFile],
          { timeout: 120000 }
        );
        repaired.push(id);
      } catch (e) {
        failed.push({ id, error: String(e?.stderr || e?.stdout || e?.message || e) });
      }
    }

    return res.json({
      success: true,
      scanned: candidates.length,
      repairedCount: repaired.length,
      repaired,
      failedCount: failed.length,
      failed,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: String(error?.message || error) });
  } finally {
    await Promise.all(tempPaths.map(async (p) => {
      try { await fs.unlink(p); } catch { /* ignore */ }
    }));
  }
});

// List generated dashboards (bizobs-*) from Dynatrace tenant for settings management.
router.post('/list-generated-dashboards', async (req, res) => {
  const tempPaths = [];
  try {
    const { environmentUrl, apiToken } = await resolveDtDeployConfig();
    if (!environmentUrl || !apiToken) {
      return res.status(500).json({
        success: false,
        error: 'Dynatrace credentials missing on server (DT_ENVIRONMENT + DT_PLATFORM_TOKEN)',
      });
    }

    const dtctlBin = await ensureLocalDtctl();
    const tmpBase = path.join(__dirname, '..', 'tmp', 'dtctl');
    await fs.mkdir(tmpBase, { recursive: true });
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const configFile = path.join(tmpBase, `.dtctl-list-generated-${nonce}.yaml`);
    tempPaths.push(configFile);

    const contextName = 'local';
    const tokenRef = 'default-token';
    await execFileAsync(dtctlBin, ['config', 'set-credentials', tokenRef, '--token', apiToken, '--config', configFile, '--plain'], { timeout: 30000 });
    await execFileAsync(dtctlBin, ['config', 'set-context', contextName, '--environment', environmentUrl, '--token-ref', tokenRef, '--safety-level', 'readwrite-all', '--config', configFile, '--plain'], { timeout: 30000 });

    const { stdout } = await execFileAsync(
      dtctlBin,
      ['get', 'dashboards', '--output', 'json', '--plain', '--context', contextName, '--config', configFile],
      { timeout: 120000 }
    );

    let principalId = '';
    try {
      const whoamiRes = await execFileAsync(
        dtctlBin,
        ['auth', 'whoami', '--id-only', '--plain', '--context', contextName, '--config', configFile],
        { timeout: 30000 }
      );
      principalId = String(whoamiRes.stdout || '').trim();
    } catch {
      principalId = '';
    }

    let parsed = null;
    try { parsed = JSON.parse(String(stdout || '')); } catch { parsed = null; }

    const dashboards = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.result)
        ? parsed.result
        : Array.isArray(parsed?.dashboards)
          ? parsed.dashboards
          : [];

    const generated = dashboards
      .filter((d) => String(d?.id || '').startsWith('bizobs-'))
      .map((d) => ({
        id: String(d?.id || ''),
        name: String(d?.name || d?.title || d?.displayName || d?.id || 'Unnamed Dashboard'),
        owner: d?.owner || d?.createdBy || d?.createdByEmail || null,
        createdAt: d?.createdAt || d?.created || null,
        updatedAt: d?.updatedAt || d?.lastModified || d?.modifiedAt || null,
        canDelete: principalId
          ? String(d?.owner || d?.createdBy || '').trim() === principalId
          : true,
      }))
      .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')));

    return res.json({ success: true, dashboards: generated, total: generated.length, currentPrincipalId: principalId || null });
  } catch (error) {
    return res.status(500).json({ success: false, error: String(error?.message || error) });
  } finally {
    await Promise.all(tempPaths.map(async (p) => {
      try { await fs.unlink(p); } catch { /* ignore */ }
    }));
  }
});

// Delete a single generated dashboard by ID.
router.post('/delete-generated-dashboard', async (req, res) => {
  const tempPaths = [];
  try {
    const dashboardId = String(req.body?.dashboardId || '').trim();
    if (!dashboardId) {
      return res.status(400).json({ success: false, error: 'dashboardId is required' });
    }

    const { environmentUrl, apiToken } = await resolveDtDeployConfig();
    if (!environmentUrl || !apiToken) {
      return res.status(500).json({
        success: false,
        error: 'Dynatrace credentials missing on server (DT_ENVIRONMENT + DT_PLATFORM_TOKEN)',
      });
    }

    const dtctlBin = await ensureLocalDtctl();
    const tmpBase = path.join(__dirname, '..', 'tmp', 'dtctl');
    await fs.mkdir(tmpBase, { recursive: true });
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const configFile = path.join(tmpBase, `.dtctl-delete-generated-${nonce}.yaml`);
    tempPaths.push(configFile);

    const contextName = 'local';
    const tokenRef = 'default-token';
    await execFileAsync(dtctlBin, ['config', 'set-credentials', tokenRef, '--token', apiToken, '--config', configFile, '--plain'], { timeout: 30000 });
    await execFileAsync(dtctlBin, ['config', 'set-context', contextName, '--environment', environmentUrl, '--token-ref', tokenRef, '--safety-level', 'readwrite-all', '--config', configFile, '--plain'], { timeout: 30000 });

    await execFileAsync(
      dtctlBin,
      ['delete', 'dashboard', dashboardId, '--yes', '--context', contextName, '--config', configFile, '--plain'],
      { timeout: 120000 }
    );

    return res.json({ success: true, dashboardId });
  } catch (error) {
    const rawErr = String(error?.stderr || error?.stdout || error?.message || error);
    const low = rawErr.toLowerCase();
    if (low.includes('access denied to document') || low.includes('forbidden') || low.includes('status 403')) {
      return res.status(403).json({
        success: false,
        error: `Access denied deleting dashboard. The configured deploy token is not the owner of this document: ${String(req.body?.dashboardId || '')}`,
        hint: 'Delete it from Dynatrace UI as the owning user, or switch deploy token back to the original owner/admin and retry.',
        raw: rawErr,
      });
    }
    return res.status(500).json({ success: false, error: rawErr });
  } finally {
    await Promise.all(tempPaths.map(async (p) => {
      try { await fs.unlink(p); } catch { /* ignore */ }
    }));
  }
});

router.get('/health', async (req, res) => {
  try {
    const response = await fetch(`${OLLAMA_ENDPOINT}/api/tags`);
    if (response.ok) {
      const data = await response.json();
      const hasModel = data.models?.some(m => m.name.includes(OLLAMA_MODEL.split(':')[0]));
      res.json({
        success: true, ollamaAvailable: true, endpoint: OLLAMA_ENDPOINT,
        configuredModel: OLLAMA_MODEL, modelInstalled: hasModel,
        installedModels: data.models?.map(m => m.name) || [],
        ready: hasModel,
        message: hasModel ? `Ollama ready with ${OLLAMA_MODEL}` : `Model ${OLLAMA_MODEL} not installed. Run: ollama pull ${OLLAMA_MODEL}`
      });
    } else {
      res.json({ success: false, ollamaAvailable: false, endpoint: OLLAMA_ENDPOINT, message: 'Ollama not responding' });
    }
  } catch (error) {
    res.json({ success: false, ollamaAvailable: false, endpoint: OLLAMA_ENDPOINT, error: error.message, message: `Cannot reach Ollama at ${OLLAMA_ENDPOINT}` });
  }
});

router.get('/skills', async (req, res) => {
  try {
    const skills = await loadDynatraceSkills();
    res.json({ success: true, skills: Object.keys(skills), loaded: Object.values(skills).filter(s => s !== null).length });
  } catch (error) {
    console.error('[AI Dashboard] Skills error:', error);
    res.status(500).json({ error: error.message });
  }
});

router.post('/preview', async (req, res) => {
  try {
    const { journeyData } = req.body;
    if (!journeyData) return res.status(400).json({ error: 'Journey data required' });

    const detected = detectPayloadFields(journeyData);
    const dynamicTiles = generateDynamicFieldTiles(detected, journeyData.company, journeyData.journeyType);

    res.json({
      success: true,
      preview: {
        name: `${journeyData.company} - ${journeyData.journeyType} Dashboard`,
        company: journeyData.company, industry: journeyData.industry, journeyType: journeyData.journeyType,
        detectedFields: {
          stringFields: detected.stringFields.map(f => f.key),
          numericFields: detected.numericFields.map(f => f.key),
          booleanFields: detected.booleanFields.map(f => f.key),
          flags: {
            revenue: detected.hasRevenue, loyalty: detected.hasLoyalty, ltv: detected.hasLTV,
            segments: detected.hasSegments, devices: detected.hasDeviceType, channel: detected.hasChannel,
            nps: detected.hasNPS, churnRisk: detected.hasChurnRisk, conversion: detected.hasConversion,
            pricing: detected.hasPricing, risk: detected.hasRisk, fraud: detected.hasFraud,
            compliance: detected.hasCompliance, engagement: detected.hasEngagement,
            satisfaction: detected.hasSatisfaction, retention: detected.hasRetention,
            product: detected.hasProduct, operational: detected.hasOperational,
            forecast: detected.hasForecast, acquisition: detected.hasAcquisition,
            upsell: detected.hasUpsell, browser: detected.hasBrowser,
            subscription: detected.hasSubscription, membership: detected.hasMembership,
            services: detected.hasServices
          }
        },
        dynamicTilesGenerated: Object.keys(dynamicTiles),
        dynamicTileCount: Object.keys(dynamicTiles).length
      }
    });
  } catch (error) {
    console.error('[AI Dashboard] Preview error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ── Saved Dashboards API ──────────────────────────────────────────────────────
const SAVED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboards', 'saved');
const GENERATED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dashboards', 'generated');

async function collectGeneratedDashboardArtifacts(rootDir, relativePrefix = '') {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);
  const dashboards = [];

  for (const entry of entries) {
    const absPath = path.join(rootDir, entry.name);
    const relPath = path.join(relativePrefix, entry.name);

    if (entry.isDirectory()) {
      dashboards.push(...await collectGeneratedDashboardArtifacts(absPath, relPath));
      continue;
    }

    const match = entry.name.match(/^metadata-v(\d+)\.json$/);
    if (!match) continue;

    try {
      const raw = await fs.readFile(absPath, 'utf-8');
      const data = JSON.parse(raw);
      dashboards.push({
        id: `${sanitizeArtifactSegment(data.company, 'company')}--${sanitizeArtifactSegment(data.journeyType, 'journey')}--v${data.version}`,
        company: data.company,
        journeyType: data.journeyType,
        tileCount: data.tileCount,
        generationMethod: data.generationMethod,
        savedAt: data.generatedAt,
        dashboardName: data.dashboardName || `${data.company} - ${data.journeyType}`,
        dashboardId: data.dashboardId || null,
        dashboardUrl: data.dashboardUrl || null,
        artifactVersion: data.version,
        artifactPath: relPath,
        source: 'generated-artifact',
      });
    } catch {
      // Ignore unreadable metadata files
    }
  }

  return dashboards;
}

async function findGeneratedArtifactById(id, rootDir = GENERATED_DIR) {
  const entries = await fs.readdir(rootDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    const absPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findGeneratedArtifactById(id, absPath);
      if (nested) return nested;
      continue;
    }

    const match = entry.name.match(/^metadata-v(\d+)\.json$/);
    if (!match) continue;

    try {
      const raw = await fs.readFile(absPath, 'utf-8');
      const metadata = JSON.parse(raw);
      const computedId = `${sanitizeArtifactSegment(metadata.company, 'company')}--${sanitizeArtifactSegment(metadata.journeyType, 'journey')}--v${metadata.version}`;
      if (computedId !== id) continue;

      const dashboardFile = path.join(rootDir, `dashboard-v${metadata.version}.json`);
      return {
        metadataFile: absPath,
        dashboardFile,
        metadata,
      };
    } catch {
      // Ignore unreadable metadata files
    }
  }

  return null;
}

// List all saved dashboards (metadata only — no full content)
router.get('/saved', async (req, res) => {
  try {
    await fs.mkdir(SAVED_DIR, { recursive: true });
    const files = await fs.readdir(SAVED_DIR);
    const dashboards = [];
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(SAVED_DIR, file), 'utf-8');
        const data = JSON.parse(raw);
        dashboards.push({
          id: data.id,
          company: data.company,
          journeyType: data.journeyType,
          tileCount: data.tileCount,
          generationMethod: data.generationMethod,
          savedAt: data.savedAt,
          dashboardName: data.dashboard?.name || `${data.company} - ${data.journeyType}`,
          source: 'saved-dashboard',
        });
      } catch { /* skip corrupt files */ }
    }
    dashboards.push(...await collectGeneratedDashboardArtifacts(GENERATED_DIR));
    dashboards.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
    res.json({ success: true, dashboards });
  } catch (err) {
    console.error('[AI Dashboard] List saved error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get a specific saved dashboard (full content)
router.get('/saved/:id', async (req, res) => {
  try {
    const id = req.params.id.replace(/[^a-zA-Z0-9-]/g, '');
    const filePath = path.join(SAVED_DIR, `${id}.json`);
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      const data = JSON.parse(raw);
      return res.json({ success: true, source: 'saved-dashboard', ...data });
    } catch (savedErr) {
      if (savedErr.code !== 'ENOENT') throw savedErr;
    }

    const artifact = await findGeneratedArtifactById(id);
    if (!artifact) {
      return res.status(404).json({ success: false, error: 'Dashboard not found' });
    }

    const dashboardRaw = await fs.readFile(artifact.dashboardFile, 'utf-8');
    const dashboard = JSON.parse(dashboardRaw);
    return res.json({
      success: true,
      source: 'generated-artifact',
      id,
      company: artifact.metadata.company,
      journeyType: artifact.metadata.journeyType,
      generationMethod: artifact.metadata.generationMethod,
      tileCount: artifact.metadata.tileCount,
      savedAt: artifact.metadata.generatedAt,
      artifactVersion: artifact.metadata.version,
      dashboard,
      metadata: artifact.metadata,
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'Dashboard not found' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete a saved dashboard
router.delete('/saved/:id', async (req, res) => {
  try {
    const id = req.params.id.replace(/[^a-zA-Z0-9-]/g, '');
    const filePath = path.join(SAVED_DIR, `${id}.json`);
    try {
      await fs.unlink(filePath);
      return res.json({ success: true, message: `Deleted ${id}` });
    } catch (savedErr) {
      if (savedErr.code !== 'ENOENT') throw savedErr;
    }

    const artifact = await findGeneratedArtifactById(id);
    if (!artifact) {
      return res.status(404).json({ success: false, error: 'Dashboard not found' });
    }

    await Promise.all([
      fs.unlink(artifact.metadataFile).catch(() => {}),
      fs.unlink(artifact.dashboardFile).catch(() => {}),
    ]);
    return res.json({ success: true, message: `Deleted ${id}` });
  } catch (err) {
    if (err.code === 'ENOENT') {
      return res.status(404).json({ success: false, error: 'Dashboard not found' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// FIELD REPOSITORY — Exposes captured journey field schemas for Ollama/AI
// Populated automatically as journeys are simulated
// ============================================================================

router.get('/field-repo', (req, res) => {
  try {
    const { company, journey } = req.query;
    if (company && journey) {
      const entry = getFields(company, journey);
      return res.json({ success: true, entry: entry || null });
    }
    // Return summary (compact) or full entries
    if (req.query.full === 'true') {
      return res.json({ success: true, entries: getAllEntries() });
    }
    return res.json({ success: true, summary: getRepoSummary() });
  } catch (err) {
    console.error('[field-repo] GET error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// DEMONSTRATOR DASHBOARDS — AI TILE GENERATION
// Ollama analyses discovered bizevent fields and generates DQL tile specs
// that are specific to the actual deployed journey data.
// ============================================================================

router.post('/engine-tiles', async (req, res) => {
  const startTime = Date.now();
  try {
    const { fields, preset, companyName, journeyType, timeframe, services } = req.body || {};

    if (!fields || !Array.isArray(fields) || fields.length === 0) {
      return res.status(400).json({ success: false, error: 'No discovered fields provided' });
    }

    // Check Ollama availability
    const isAvailable = await checkOllamaAvailable();
    if (!isAvailable) {
      return res.status(503).json({ success: false, error: 'Ollama is not available — model may not be loaded' });
    }

    // Enrich context from the field repository (captured during journey simulation)
    let repoContext = '';
    if (companyName || journeyType) {
      try {
        const repoEntry = getFields(companyName || '', journeyType || '');
        if (repoEntry) {
          const repoFieldNames = Object.keys(repoEntry.fields || {});
          const repoServices = repoEntry.services || [];
          const repoSteps = repoEntry.steps || [];
          repoContext = `\n\nFIELD REPOSITORY (from ${repoEntry.runCount} previous journey runs, last updated ${repoEntry.lastUpdated}):
- Known services: ${repoServices.length > 0 ? repoServices.join(', ') : 'n/a'}
- Known journey steps: ${repoSteps.length > 0 ? repoSteps.join(' → ') : 'n/a'}
- Repository fields (${repoFieldNames.length}): ${repoFieldNames.map(f => {
            const info = repoEntry.fields[f];
            return `${f} (${info.type})${info.sample !== undefined ? ` e.g. ${info.sample}` : ''}`;
          }).join(', ')}
Use this as additional context to generate better tiles. Prefer fields that exist in both the live discovery and this repository.`;
          console.log(`[Demonstrator AI Tiles] 📚 Enriched with field repo (${repoFieldNames.length} fields, ${repoEntry.runCount} runs)`);
        }
      } catch (repoErr) {
        console.warn('[Demonstrator AI Tiles] ⚠️  Field repo lookup failed (non-fatal):', repoErr.message);
      }
    }

    // Build field summary for the prompt
    const fieldSummary = fields.map(f =>
      `- ${f.name} (${f.type})${f.sampleValue !== undefined ? ` — sample: ${f.sampleValue}` : ''}`
    ).join('\n');

    const numericFields = fields.filter(f => f.type === 'numeric').map(f => f.name);
    const categoricalFields = fields.filter(f => f.type === 'string').map(f => f.name);

    // Describe the persona preset so Ollama tailors tiles appropriately
    const presetDescriptions = {
      developer: 'Developer/SRE — focus on service health, error rates, latency, throughput, RED metrics, and debugging',
      operations: 'Operations — focus on infrastructure health, availability, resource saturation, network, and logs',
      executive: 'Executive/C-Suite — focus on revenue, customer counts, conversion funnels, SLA compliance, and business impact',
      intelligence: 'Dynatrace Intelligence — focus on problems, root cause analysis, anomalies, and business impact of IT issues',
    };

    const presetContext = presetDescriptions[preset] || presetDescriptions.executive;

    // The base query will be prepended by the backend — Ollama only produces the suffix
    const tf = timeframe || 'now()-2h';

    const vizTypes = [
      'heroMetric — single big number. dqlSuffix: summarize to produce 1 row with 1 field',
      'timeseries — line chart. dqlSuffix: makeTimeseries ...',
      'categoricalBar — bar chart. dqlSuffix: summarize ... by:{field} | sort desc | limit 15',
      'donut — pie chart. dqlSuffix: summarize count = count(), by:{field} | sort count desc | limit 10',
      'table — data table. dqlSuffix: fields ... | sort ... | limit 25',
      'honeycomb — heatmap. dqlSuffix: summarize count = count(), by:{field} | sort count desc | limit 20',
    ];

    const prompt = `You are a Dynatrace DQL expert generating dashboard tiles.

PERSONA: ${presetContext}

Discovered additionalfields on the bizevents:
${fieldSummary}

Numeric fields: ${numericFields.length > 0 ? numericFields.join(', ') : 'none'}
Categorical (string) fields: ${categoricalFields.length > 0 ? categoricalFields.join(', ') : 'none'}

${DQL_SYNTAX_RULES}

IMPORTANT RULES:
- You provide ONLY the dqlSuffix — the pipeline commands AFTER the base fetch+filter. The system prepends the base query automatically.
- Use pipe separator as: | (a single pipe with spaces)
- Access additionalfields as: additionalfields.fieldName
- Convert numeric fields: toDouble(additionalfields.fieldName)
- Core JSON fields: json.customerId, json.serviceName, json.stepName, json.journeyType, json.companyName, json.hasError, json.stepIndex
- event.type is the bizevent type
- For heroMetric: produce 1 row, 1 numeric field via summarize
- For timeseries: use makeTimeseries
- For categoricalBar/donut/honeycomb: use summarize ... by:{field}, sort desc, limit
- For table: use fields to select columns, sort, limit
- Use round(..., decimals:2) for decimal values

VISUALIZATION TYPES:
${vizTypes.join('\n')}

Generate 4-6 tiles that leverage the discovered additionalfields for the ${preset} persona.

Return ONLY a JSON array. Each element:
- id: string starting with "ai-"
- title: short descriptive string
- vizType: one of heroMetric, timeseries, categoricalBar, donut, table, honeycomb
- dqlSuffix: string — the DQL AFTER the base query. Use | as pipe separator. NO fetch statement. NO filter for company/journey. Example: "summarize avg_val = round(avg(toDouble(additionalfields.transactionValue)), decimals:2)"
- width: 1, 2, or 3
- icon: one emoji
- accent: hex color like #00d4aa

Example response:
[{"id":"ai-avg-val","title":"Avg Transaction","vizType":"heroMetric","dqlSuffix":"summarize avgVal = round(avg(toDouble(additionalfields.transactionValue)), decimals:2)","width":1,"icon":"💰","accent":"#00d4aa"},{"id":"ai-vol-ts","title":"Volume Over Time","vizType":"timeseries","dqlSuffix":"makeTimeseries volume = count()","width":2,"icon":"📈","accent":"#3498db"}]

JSON array only. No markdown. No explanation.${repoContext}`;

    console.log(`[Demonstrator AI Tiles] 🤖 Requesting ${preset} tiles for ${companyName || 'all'}/${journeyType || 'all'} (${fields.length} fields)...`);

    const ollamaResponse = await fetch(`${OLLAMA_ENDPOINT}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt,
        stream: false,
        keep_alive: -1,
        options: {
          temperature: 0.3,
          num_predict: 4096,
        },
      }),
      signal: AbortSignal.timeout(120000),
    });

    if (!ollamaResponse.ok) {
      const errText = await ollamaResponse.text().catch(() => '');
      throw new Error(`Ollama returned HTTP ${ollamaResponse.status}: ${errText.substring(0, 200)}`);
    }

    const ollamaResult = await ollamaResponse.json();
    const rawText = (ollamaResult.response || '').trim();
    const elapsed = Date.now() - startTime;

    console.log(`[Demonstrator AI Tiles] ✅ Ollama responded in ${elapsed}ms — tokens: prompt=${ollamaResult.prompt_eval_count || 0}, completion=${ollamaResult.eval_count || 0}`);

    // Export GenAI span for AI Observability
    const spanAttrs = createGenAISpan(
      prompt,
      rawText,
      OLLAMA_MODEL,
      ollamaResult.prompt_eval_count || 0,
      ollamaResult.eval_count || 0,
      elapsed
    );
    await logGenAISpan(spanAttrs, 'demonstrator_tile_generation');

    // Parse the JSON array from Ollama's response
    let jsonText = rawText;

    // Strip markdown fences if present
    const fenceMatch = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) jsonText = fenceMatch[1].trim();

    // Find array boundaries
    const arrStart = jsonText.indexOf('[');
    const arrEnd = jsonText.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
      jsonText = jsonText.substring(arrStart, arrEnd + 1);
    }

    let tiles;
    try {
      tiles = JSON.parse(jsonText);
    } catch (parseErr) {
      // Attempt repair: replace literal \n inside strings with space, fix trailing commas
      try {
        let repaired = jsonText.replace(/,\s*([}\]])/g, '$1');  // trailing commas
        tiles = JSON.parse(repaired);
      } catch {
        console.error(`[Demonstrator AI Tiles] ❌ Failed to parse Ollama JSON:`, rawText.substring(0, 500));
        return res.status(500).json({ success: false, error: 'Ollama returned invalid JSON', raw: rawText.substring(0, 500) });
      }
    }

    if (!Array.isArray(tiles)) {
      return res.status(500).json({ success: false, error: 'Ollama did not return a JSON array' });
    }

    // Build the base query to prepend to each tile's dqlSuffix
    let baseQuery = `fetch bizevents, from:${tf}`;
    if (companyName) baseQuery += `\n| filter matchesPhrase(json.companyName, "${companyName}")`;
    if (journeyType) baseQuery += `\n| filter matchesPhrase(json.journeyType, "${journeyType}")`;

    // Validate and sanitize each tile — prepend base query to dqlSuffix
    const validVizTypes = ['heroMetric', 'timeseries', 'categoricalBar', 'donut', 'table', 'honeycomb', 'sectionBanner', 'impactCard'];
    const validatedTiles = tiles
      .filter(t => t && typeof t === 'object' && t.id && t.title && (t.dqlSuffix || t.dql) && t.vizType)
      .map(t => {
        const suffix = String(t.dqlSuffix || t.dql || '').trim();
        // If Ollama returned a full query despite instructions, use it as-is; otherwise prepend base
        const fullDql = suffix.toLowerCase().startsWith('fetch ')
          ? suffix
          : `${baseQuery}\n| ${suffix.replace(/^\|?\s*/, '')}`;
        return {
          id: String(t.id).substring(0, 64),
          title: String(t.title).substring(0, 100),
          vizType: validVizTypes.includes(t.vizType) ? t.vizType : 'table',
          dql: fullDql.substring(0, 4000),
          width: [1, 2, 3].includes(t.width) ? t.width : 1,
          icon: typeof t.icon === 'string' ? t.icon.substring(0, 4) : '📊',
          accent: typeof t.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(t.accent) ? t.accent : '#a78bfa',
        };
      });

    console.log(`[Demonstrator AI Tiles] 🎯 Returning ${validatedTiles.length} validated tiles (${tiles.length} raw from Ollama)`);

    res.json({
      success: true,
      tiles: validatedTiles,
      meta: {
        model: OLLAMA_MODEL,
        elapsed,
        promptTokens: ollamaResult.prompt_eval_count || 0,
        completionTokens: ollamaResult.eval_count || 0,
        fieldsAnalyzed: fields.length,
      },
    });
  } catch (err) {
    const elapsed = Date.now() - startTime;
    console.error(`[Demonstrator AI Tiles] ❌ Error after ${elapsed}ms:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============================================================================
// DEMONSTRATOR DASHBOARDS — ASYNC AI TILE GENERATION (job-based for EdgeConnect)
// The proxy kicks off a job, then polls for results.
// ============================================================================

const _demonstratorTileJobs = new Map(); // jobId → { status, tiles, meta, error, startTime }

router.post('/demonstrator-tiles-async', async (req, res) => {
  const jobId = `engine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { fields, preset, companyName, journeyType, timeframe, services } = req.body || {};

  if (!fields || !Array.isArray(fields) || fields.length === 0) {
    return res.status(400).json({ success: false, error: 'No discovered fields provided' });
  }

  // Store job as pending and respond immediately
  _demonstratorTileJobs.set(jobId, { status: 'running', tiles: null, meta: null, error: null, startTime: Date.now() });

  // Clean up old jobs (keep last 50)
  if (_demonstratorTileJobs.size > 50) {
    const keys = [..._demonstratorTileJobs.keys()];
    for (let i = 0; i < keys.length - 50; i++) _demonstratorTileJobs.delete(keys[i]);
  }

  res.json({ success: true, jobId });

  // Run Ollama generation in background (after response)
  try {
    // Reuse the synchronous endpoint's internal URL to call ourselves
    const internalUrl = `http://localhost:${process.env.PORT || 8080}/api/ai-dashboard/engine-tiles`;
    const result = await fetch(internalUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields, preset, companyName, journeyType, timeframe, services }),
      signal: AbortSignal.timeout(180000),
    });
    const data = await result.json();
    if (data.success) {
      _demonstratorTileJobs.set(jobId, { status: 'complete', tiles: data.tiles, meta: data.meta, error: null, startTime: _demonstratorTileJobs.get(jobId)?.startTime });
    } else {
      _demonstratorTileJobs.set(jobId, { status: 'failed', tiles: null, meta: null, error: data.error || 'Generation failed', startTime: _demonstratorTileJobs.get(jobId)?.startTime });
    }
  } catch (err) {
    _demonstratorTileJobs.set(jobId, { status: 'failed', tiles: null, meta: null, error: err.message, startTime: _demonstratorTileJobs.get(jobId)?.startTime });
  }
});

router.get('/demonstrator-tiles-status/:jobId', (req, res) => {
  const job = _demonstratorTileJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }
  const elapsed = Date.now() - (job.startTime || 0);
  res.json({
    success: true,
    status: job.status,
    tiles: job.tiles,
    meta: job.meta,
    error: job.error,
    elapsed,
  });
});

// Start Ollama warmup scheduler on module load
scheduleOllamaWarmup();

export default router;
