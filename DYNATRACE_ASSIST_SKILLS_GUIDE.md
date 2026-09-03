# Using dynatrace-assist Skills for Dashboard & Workflow Generation

## Overview

This guide explains how to use **dynatrace-assist skills** (specifically the `dynatrace-kpi-dashboard-generator` and `dtctl` skills) to enhance dashboard generation beyond the current auto-repair and verification capabilities.

## Available Skills

### 1. dynatrace-kpi-dashboard-generator Skill

**Source:** [https://github.com/SudoSmitty/dynatrace-kpi-dashboard-generator](https://github.com/SudoSmitty/dynatrace-kpi-dashboard-generator)  
**Installed at:** `./dynatrace-kpi-dashboard-generator/`

**Capabilities:**
- AI-powered KPI discovery for specific industries
- Dashboard JSON generation following Gen 3 spec
- BizEvents injector JavaScript generation
- Section dividers with brand-appropriate colors
- Map tile placement per pattern

**How to Invoke (via Claude/Copilot):**
```
"Generate a KPI dashboard for [company name], [industry vertical], 
with these business processes: [list]"
```

**Example Prompt:**
```
Generate a KPI dashboard for Smithy's Toys (retail/e-commerce) including:
- Transactions & Revenue KPIs
- Inventory Management
- Customer Experience (NPS, satisfaction)
- Supply Chain Performance

Then create a 30-minute BizEvents injector that streams realistic events 
for these metrics and deploy via dtctl.
```

**Outputs:**
- `dashboards/<company>/<company>-dashboard-v1.json` — Gen 3 dashboard
- `dashboards/<company>/<company>-injector.js` — 30-min event injector
- `dashboards/<company>/README.md` — Deployment guide
- `dashboards/<company>/LEARNINGS.md` — Pattern documentation
- `dashboards/<company>/SALES-PITCH.md` — Sales enablement

### 2. dtctl Skill

**Source:** [https://github.com/dynatrace-oss/dtctl](https://github.com/dynatrace-oss/dtctl)  
**Installed at:** `./dtctl-repo/`

**Capabilities:**
- Dashboard apply/delete operations
- Workflow management (get, edit, execute)
- DQL query execution
- Configuration & context management
- Version history & artifact comparison

**Key Commands Used in This Project:**
```bash
# Set up authentication
dtctl config set-credentials <token-ref> --token <token>
dtctl config set-context <context> --environment <url> --token-ref <token>

# Deploy dashboard
dtctl apply -f dashboard.json --id <id> --share-environment read

# Find workflows
dtctl get workflows --output json

# Execute workflow
dtctl exec workflow <workflow-id>

# Query Grail
dtctl query <dql-statement> --output json
```

### 3. dynatrace-for-ai Skills (Supporting)

**Source:** [https://github.com/Dynatrace/dynatrace-for-ai](https://github.com/Dynatrace/dynatrace-for-ai) (official public Dynatrace skills, Apache-2.0)  
**Install:** `npx skills add dynatrace/dynatrace-for-ai`

**Available Skills:**
- `dt-dql-essentials` — DQL syntax validation & optimization
- `dt-app-dashboards` — Dashboard pattern recommendations
- `dt-app-notebooks` — Analysis notebook generation
- `dt-obs-*` — Observability domain skills (services, hosts, apps)

---

## Implementation Patterns

### Pattern 1: AI-Assisted Industry Vertical KPI Discovery

**Scenario:** User wants to generate a dashboard for a new company/industry

**Current Flow:**
1. User specifies company + journey
2. LLM generates dashboard based on business description
3. Field discovery finds available BizEvents fields
4. Auto-repair + dividers applied to generated dashboard

**Enhanced Flow (using dynatrace-assist):**
```js
// Prompt the dynatrace-kpi-dashboard-generator skill
const assistRequest = {
  prompt: `For a ${industry} company called "${company}", 
           with business processes [${processes}], 
           generate 15-20 KPIs using the KPI Dashboard Generator pattern.
           Include:
           - Revenue/Financial KPIs
           - Operations KPIs
           - Customer Experience KPIs
           Return the dashboard JSON using Gen 3 spec.`,
  skill: 'dynatrace-kpi-dashboard-generator',
  context: {
    company,
    industry,
    processes,
  }
};

const dashboardResponse = await callDynatraceAssist(assistRequest);
// dashboardResponse includes:
// - dashboard JSON with proper structure
// - section dividers pre-injected
// - map tile pre-positioned
// - color palette matched to industry
```

**Implementation Location:** New route: `/api/ai-dashboard/generate-with-kpi-pattern`

---

### Pattern 2: Workflow Task Generation & Injection

**Scenario:** After deploying a dashboard, automatically append an injector task

**Current State:**
- `tryAppendToInjectorWorkflow()` finds existing workflows
- Manual task creation required

**Enhanced Implementation (future):**
```js
// Use dtctl + dynatrace-assist to auto-generate task
const injectorTask = await generateInjectorTaskWithDtctl({
  company,
  journeyType,
  eventsPerMinute: 100,
  batchSize: 50,
  geoRegions: ['US-West', 'EU-Central'],
  template: 'reference/example-injector.js'
});

// Parse existing workflow
const workflowJson = await getWorkflowWithDtctl(workflowId);

// Append task (ensure uniqueness by company_vN key)
const existingTaskKeys = workflowJson.tasks.map(t => t.name);
const newTaskKey = `${sanitized(company)}_v${getNextVersion(existingTaskKeys)}`;

workflowJson.tasks.push({
  name: newTaskKey,
  action: {
    type: 'javascript',
    content: injectorTask.javascript,
    inputs: injectorTask.inputs
  },
  predecessors: [] // Parallel execution
});

// Redeploy workflow
await execFile(dtctlBin, ['apply', '-f', updatedWorkflow.json, '--id', workflowId]);
```

**Implementation Location:** Enhance `/api/ai-dashboard/deploy-dtctl`

---

### Pattern 3: Field Validation Against Dynatrace Schema

**Scenario:** Before LLM generates queries, validate that discovered fields exist

**Current State:**
- Field discovery via DQL polling
- LLM can still hallucinate fields

**Enhanced Implementation (future):**
```js
// Use dt-dql-essentials skill to validate field names
const validatedFields = await validateFieldsWithDQL({
  fields: discoveredFieldSet,
  technique: 'grail-schema',
  company,
  sample: 10, // Check 10 sample events
});

// Only pass validated fields to LLM
const safeFieldCatalog = filterFieldCatalog(FIELD_CATALOG, validatedFields);

// LLM prompt with guaranteed availability
const prompt = `Available fields: \n${JSON.stringify(safeFieldCatalog, null, 2)}
               \nYou MUST ONLY reference fields from this list. Do not invent fields.`;
```

**Implementation Location:** Enhance `discoverBizEventFields()`

---

### Pattern 4: DQL Query Optimization

**Scenario:** Generated DQL queries are inefficient or semantically incorrect

**Current State:**
- Basic normalization (field qualifying, variable replacement)
- Query validation warns of issues

**Enhanced Implementation (future):**
```js
// Use dt-dql-essentials skill for optimization
const optimizationResult = await optimizeDQLWithDtctl({
  query: generatedQuery,
  technique: 'performance', // or 'semantic-correctness'
});

if (optimizationResult.improved) {
  tile.query = optimizationResult.optimizedQuery;
  console.log(`[DQL Optimize] ⚡ Query improved: ${optimizationResult.reason}`);
}

if (optimizationResult.warnings.length > 0) {
  for (const warn of optimizationResult.warnings) {
    console.warn(`[DQL Validate] ⚠️ ${warn.message} (line ${warn.line})`);
  }
}
```

**Implementation Location:** Enhance `normalizeDashboardContentForDeploy()`

---

### Pattern 5: Sales Enablement Document Auto-Generation

**Scenario:** After dashboard success, generate supporting docs for sales teams

**Current State:**
- README, LEARNINGS, SALES-PITCH generated manually for reference repo

**Enhanced Implementation (future):**
```js
// Use dynatrace-kpi-dashboard-generator skill to auto-generate sales content
const salesPitch = await generateSalesContent({
  company,
  journeyType,
  industry,
  dashboard: deployedDashboard,
  businessOutcomes: ['30% faster order processing', '15% inventory reduction'],
  skill: 'dynatrace-kpi-dashboard-generator',
});

// Save alongside dashboard
await writeFile(
  `dashboards/${company}/${journey}/SALES-PITCH.md`,
  salesPitch
);

// Include in deployment artifact bundle
```

**Location:** [writeDashboardArtifactBundle()](routes/ai-dashboard.js#L5045)

---

## Prompt Templates for dynatrace-assist

### Template 1: KPI Dashboard Generation

```markdown
# Generate KPI Dashboard for [Company]

Industry: [Retail / Fintech / Healthcare / Manufacturing]
Business Processes: [e.g., Order Fulfillment, Claims Processing, Asset Management]

Using the dynatrace-kpi-dashboard-generator pattern, please:

1. Design 15-20 business KPIs covering:
   - Revenue/Financial metrics
   - Operational efficiency
   - Customer satisfaction
   - Process reliability

2. Generate a Gen 3 dashboard JSON with:
   - Split header (logo + title markdown tiles)
   - Map tile at y:2-9 (full width)
   - Section dividers with industry-appropriate colors
   - Data tiles using DQL queries for BizEvents

3. Create a 30-minute BizEvents injector (JavaScript) that:
   - Generates 3000-5000 realistic events per run
   - Includes all KPI-relevant custom fields
   - Uses geographic distribution and clustering

Return: dashboard JSON, injector.js, README.md with deployment instructions
```

### Template 2: Workflow Integration

```markdown
# Generate Workflow Task for BizEvents Injection

Company: [Company Name]
Journey: [Journey Name]
Events per Minute: [50-200]
Batch Size: [20-100]
Geographic Regions: [List regions]

Using dtctl workflow capabilities:

1. Generate JavaScript task that:
   - Connects to Dynatrace HTTP events API
   - Sends batched BizEvents with company/journey labels
   - Includes realistic delays and clustering

2. Create workflow JSON task wrapper with:
   - Name: {company}_v{N}
   - Type: javascript
   - No predecessors (parallel execution)
   - Dynamic inputs for company, journey, count

3. Provide dtctl command to:
   - Get existing workflow
   - Append this task
   - Re-apply workflow

Return: Complete workflow JSON, injector JS, dtctl commands
```

### Template 3: Field Validation & Optimization

```markdown
# Validate and Optimize Dashboard Queries

Company: [Company]
Journey: [Journey]
Discovered Fields: [CSV list]

Using dt-dql-essentials skill:

1. Validate that all discovered fields exist in Grail schema
2. For each dashboard query:
   - Check syntax compliance
   - Identify performance anti-patterns
   - Suggest optimizations
3. Return:
   - Field validation report
   - Query optimization recommendations
   - Updated dashboard with optimized queries

Output: Validated dashboard JSON, optimization report, warnings
```

---

## Integration Checklist

### Short Term (Weeks)
- [x] Deploy barChart auto-repair + map positioning + dividers
- [x] Integrate workflow discovery
- [x] Add ingestion verification
- [ ] Create `/generate-with-kpi-pattern` endpoint using skill

### Medium Term (Months)
- [ ] Auto-generate injector tasks using dtctl
- [ ] Implement DQL query optimization
- [ ] Field validation before LLM generation
- [ ] Sales content auto-generation

### Long Term (Quarters)
- [ ] Full workflow JSON parsing & task append automation
- [ ] Multi-company injector pooling
- [ ] Industry-specific KPI templates as Skills
- [ ] Real-time dashboard generation based on live events

---

## Example: Complete AI-Assisted Dashboard Flow

```bash
# 1. User initiates dashboard generation via UI with KPI pattern option
POST /api/ai-dashboard/generate-with-kpi-pattern
{
  "company": "TechCorp",
  "industry": "SaaS",
  "businessProcesses": ["Onboarding", "API Usage", "Churn Management"],
  "useKPIPattern": true,
  "useAIAssist": true
}

# 2. Server calls dynatrace-kpi-dashboard-generator via Claude
# 3. Claude generates:
#    - KPI list (15-20, validated for SaaS)
#    - Dashboard JSON with proper structure
#    - Injector JavaScript
#    - Sales pitch

# 4. Server deploys dashboard via dtctl
# 5. Server finds injector workflow and reports ID
# 6. Server verifies BizEvents flowing
# 7. Server returns complete response

{
  "dashboard": {
    "id": "bizobs-techcorp-onboarding",
    "name": "TechCorp - Onboarding",
    "url": "/ui/apps/dynatrace.dashboards/dashboard/bizobs-techcorp-onboarding"
  },
  "kpiPattern": {
    "sectionsGenerated": ["Revenue", "Engagement", "Performance", "Quality"],
    "maptilePositioned": true,
    "colorPaletteIndustry": "SaaS"
  },
  "workflow": {
    "found": true,
    "id": "workflow-123",
    "taskAppended": "techcorp_v1"
  },
  "injector": {
    "status": "ready",
    "eventsPerRun": 4200,
    "scheduleMinutes": 30
  },
  "ingestion": {
    "verified": true,
    "eventCount": 2847,
    "timeToFirstEvent": 4120
  },
  "artifacts": {
    "dashboardJson": "dashboards/techcorp/onboarding/dashboard-v1.json",
    "injectorJs": "dashboards/techcorp/onboarding/injector.js",
    "readme": "dashboards/techcorp/onboarding/README.md",
    "salesPitch": "dashboards/techcorp/onboarding/SALES-PITCH.md"
  }
}
```

---

## Resources

### Official Docs
- [Dynatrace KPI Dashboard Generator](https://github.com/SudoSmitty/dynatrace-kpi-dashboard-generator/blob/main/skills/dynatrace-kpi-dashboard-generator/SKILL.md)
- [dtctl Overview](https://github.com/dynatrace-oss/dtctl/blob/main/docs/site/_docs/overview.md)
- [Dynatrace Dashboard Gen 3](https://www.dynatrace.com/support/help/platform/dashboards/dashboards)

### Internal Docs
- [DTCTL_KPI_DASHBOARD_INTEGRATION.md](DTCTL_KPI_DASHBOARD_INTEGRATION.md) — Complete integration guide
- [KPI_INTEGRATION_QUICK_REFERENCE.md](KPI_INTEGRATION_QUICK_REFERENCE.md) — Quick reference
- [DASHBOARD_GENERATION_FIXES.md](DASHBOARD_GENERATION_FIXES.md) — Field discovery & validation
- [GITHUB_JOURNEY_DASHBOARD_CHANGES.md](GITHUB_JOURNEY_DASHBOARD_CHANGES.md) — Deferred generation flow

---

**Status:** Integration foundation complete | **Last Updated:** 2026-05-12
