# Business Observability Demonstrator — v2.23.1

### Transform Customer Journeys Into Real-Time Business Intelligence

> Model any customer journey. See the revenue impact when things break. Watch AI fix it in seconds — all inside Dynatrace.

---

The observability market is undergoing a seismic shift. Cloud adoption, architectural complexity, and AI-driven automation are rewriting how organisations deliver and operate digital experiences. Every vendor promises "AI-led causality," yet only a few deliver anything meaningful — and none match the depth, precision, and proven outcomes of Dynatrace.

For customers, seeing this difference early in the conversation is transformative. When we link technical signals directly to business value — revenue, conversion, customer satisfaction, operational efficiency — we unlock a level of clarity that resonates from engineering teams to the executive suite.

At the peak of that capability sit **Dynatrace Business Dashboards**, which turn observability into real-time business intelligence. But creating a tailored, high-impact example for a customer usually requires time, context, and domain knowledge.

**That's why we created the Business Observability Demonstrator.**

---

## What Is the Business Observability Demonstrator?

The Business Observability Demonstrator is a rapid value experience that takes any critical customer journey or business process — whether a checkout flow, a claims lifecycle, a manufacturing line, or a patient-care pathway — and brings it to life inside Dynatrace as a **live, simulated business dashboard**.

Using a blend of customer-facing research (public web content, annual reports, strategy decks), internal insights, and AI-assisted discovery, the Demonstrator identifies an organisation's top business priorities, KPIs, and strategic programs. This gives us a clear understanding of what matters most at the executive level.

From there, we select a representative journey and transform it into a compelling, customer-specific business observability view, showing:

- How the journey works end to end
- Which KPIs define success
- How technical performance and business outcomes connect
- Where value is created — or lost — in real time

The result is a powerful, context-rich dashboard that mirrors the customer's world and demonstrates how Dynatrace turns observability into meaningful, measurable business impact.

All we need to do is choose a journey (or describe one in plain language). The Demonstrator spins up real services, generates realistic traffic, and connects every failure to a revenue number. When something breaks, you don't see *"Service X is down"* — you see *"Patient triage is failing, 340 journeys blocked, $127K at risk."*

Then an AI agent diagnoses and fixes it — automatically, in seconds.

110+ ready-made templates across 55+ industry verticals — or describe any customer's journey in plain language and let AI generate a bespoke configuration instantly.

**Pre-built industries:** Healthcare, Banking, Retail, Insurance, Telecom, Manufacturing, Automotive, Travel, Education, Energy, Government, Airlines, Logistics, Pharmaceuticals, Gaming, Media, Cybersecurity, Fashion, Food & Beverage, Real Estate, and many more.

**AI-generated journeys:** Don't see your customer's industry? Just describe their business process — the AI builds the full journey configuration, company profile, services, and KPIs tailored to their exact operations.

---

## Why It Matters

- **Shows value early.** Customers immediately see how Dynatrace aligns to their strategy — not just their infrastructure.
- **Bridges business and engineering.** The dashboard surfaces shared metrics that resonate across roles.
- **Tailored, not generic.** Every Demonstrator example is customised to real customer priorities.
- **Fast and low effort.** With our AI-driven search scripts and proven playbooks, creating these dashboards requires minimal inputs while delivering maximum impact.
- **Sets the stage for strategic partnership.** Customers see Dynatrace not as a tooling choice, but as a platform for operational excellence and business transformation.

| Challenge | What the Demonstrator Does |
|---|---|
| **Proving Dynatrace value beyond IT** | Generates live journeys with real revenue numbers — executives see dollars at risk, not dashboards of metrics they don't understand |
| **Engaging business stakeholders** | Models *their* actual customer journey, not a generic demo — a bank sees their loan origination flow, a hospital sees their patient intake |
| **Creating proof points fast** | Spins up a full working environment in 30 minutes — real services, real business events, real AI detection and remediation |
| **Scaling demos across teams** | 110+ ready-made templates plus AI-generated custom journeys — any SE or partner delivers the same polished story without building from scratch |
| **Bridging the gap between POC and production** | Shows customers exactly what Dynatrace looks like with their data shape, accelerating onboarding and time to value |

---

## Key Capabilities

### AI Agent Hub

Four AI agents powered by Ollama (llama3.2) work together to create a fully autonomous chaos-and-remediation loop:

| Agent | Role |
|-------|------|
| **Nemesis** (Chaos) | Injects realistic failures into services — elevated error rates, latency, cache misses — using per-service feature flags |
| **Fix-It** (Remediation) | Queries Dynatrace for active problems, diagnoses root cause via LLM function-calling, and auto-remediates by resetting feature flags |
| **Librarian** (Memory) | Records every chaos injection, revert, diagnosis, and fix into a persistent vector + history store. Provides context for future incidents and powers the Librarian Dashboard |
| **Dashboard** (BI) | Generates and deploys DQL-powered Dynatrace Business Dashboards from natural language descriptions |

### Librarian Dashboard

An AI-powered operational memory panel accessible from the **Demonstrator Dashboards** page. Click the 📚 **Librarian** button to open a modal overlay that shows:

- **AI Summary** — Ollama analyses your full incident history and produces an SRE-style narrative
- **Stats Cards** — colour-coded counts by event type (chaos injected, reverted, fixes, failures)
- **AI Insights** — severity-tagged observations (critical / warning / info)
- **Detected Patterns** — recurring incident patterns with recommendations
- **Event Timeline** — scrollable, reverse-chronological log of all operational events

Falls back to raw-data analysis when Ollama is cold or unavailable.

### Demonstrator Dashboards

A DQL-powered dashboard page with pre-built dashboard presets (Security, Digital Intelligence, Infrastructure, and more). Each tile runs a live DQL query against your Dynatrace environment. 31 saved dashboard configurations are included.

### Solutions Gallery

A showcase of 55+ industry verticals across 11 categories, each with:
- Dynatrace capability mapping
- Pre-built demo journeys (click to load and run)
- Industry-specific KPIs, BizEvent schemas, and field definitions

### Partner Event Materials

Ready-made partner demo assets included in the repo:
- **Talk track** — 8-section partner event demo guide (`PARTNER-EVENT-TALK-TRACK-AND-DEMO.md`)
- **PowerPoint** — 16-slide, 16:9 widescreen presentation (`Business-Outcome-Engine-Partner-Event.pptx`)
- **PPT generator** — Python script to regenerate the deck (`generate-partner-ppt.py`)

---

## Pre-Sales

**The most compelling business observability demo in the market.** Model a prospect's real customer journey, show live revenue impact when things break, and demonstrate AI-powered self-healing — all in a single meeting. It turns a technical monitoring pitch into a business value conversation. The fact that it mirrors *their* journey, not a generic example, is what closes deals.

## Post-Sales

**Accelerate time to value after the contract is signed.** Use the Demonstrator to model the customer's actual journeys during onboarding, show them exactly what Dynatrace will look like with their data, and prove the platform catches and resolves issues before customers notice. It's a fast track from "we just bought Dynatrace" to "here's the ROI."

## Demoability & Internal Training

**Give every SE and partner the same powerful story.** No more building bespoke demos from scratch. Anyone can pick a template, launch a full environment in 30 minutes, and deliver a polished business observability walkthrough — with partner-ready slide decks and talk tracks included. It's also ideal for internal enablement — new team members can see the full Dynatrace platform story (services, business events, AI detection, remediation, dashboards) running end-to-end on day one.

---

## How Do I Get Started?

The Demonstrator runs as an app inside your Dynatrace tenant. Setup takes about 30 minutes.

**You'll need:**
- A Dynatrace SaaS tenant (Sprint or Live)
- A server to run the Demonstrator (cloud VM or GitHub Codespace)

**Then:**
1. Clone the repo and run `./setup.sh` — it walks you through 6 guided prompts
2. Open the app in Dynatrace — a guided Get Started checklist walks you through the rest
3. Pick a journey and start your demo

For full setup instructions, see the [Technical Guide](TECHNICAL-GUIDE.md).

---

## Industry Coverage

110+ pre-built templates across 55+ industry verticals in 11 categories — plus AI-generated journeys for any customer not covered below:

| Category | Verticals |
|----------|-----------|
| **Financial Services** | Banking, Insurance, Financial Services, Payments |
| **Healthcare & Life Sciences** | Healthcare, Pharmaceuticals, Veterinary |
| **Technology** | Cybersecurity, Data Centre, Gaming, Robotics, Semiconductor, Social Media |
| **Retail & Consumer** | Retail, Fashion, Beauty, Food & Beverage, Marketplace |
| **Energy & Utilities** | Energy, EV, Water, Waste, Mining |
| **Transport & Logistics** | Airlines, Logistics, Shipping, Rail, Ride-Hailing, Delivery |
| **Manufacturing & Industrial** | Manufacturing, Industrial, Chemical, Construction |
| **Media & Entertainment** | Media, Music, Publishing, Sports, Lottery |
| **Professional Services** | Consulting, Legal, HR, Advertising, Nonprofit |
| **Government & Public** | Government, Defence, Smart City, ESG |
| **Real Estate & Hospitality** | Real Estate, Hospitality, Space, Agriculture, Fitness |
| **AI-Generated** | Describe any customer journey in plain language — the AI builds a complete configuration with company profile, services, journey steps, and industry-specific KPIs |

Each vertical includes 2 pre-built demo journeys tailored to that industry's business processes.

---

## FAQ

**Is this real data?**
Yes. These are real services generating real business events, traces, and metrics inside Dynatrace — the same data shape your production systems would produce.

**Can I tailor it to a specific customer?**
Absolutely. Describe any customer's journey in plain language and the AI builds the full configuration. The demo mirrors *their* business, not a generic example.

**Does it require Dynatrace?**
Yes. It's built natively on Dynatrace SaaS (Grail, DPS, and Dynatrace Intelligence).

**How long does setup take?**
About 30 minutes the first time. After that, launching a new demo is one click.

**Can I use it for customer demos?**
That's exactly what it's built for.

**What about partners on Dynatrace Managed (no Grail)?**
The partner event materials are designed to show the value of business observability concepts, even for audiences primarily on Managed. The live demo itself requires a SaaS tenant with Grail.

---

*[Technical Guide](TECHNICAL-GUIDE.md) · [GitHub Repository](https://github.com/israel-salgado/Business-Observability-Demonstrator)*
