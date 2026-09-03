import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Page } from '@dynatrace/strato-components-preview/layouts';
import { Flex } from '@dynatrace/strato-components/layouts';
import { Heading, Paragraph, Strong } from '@dynatrace/strato-components/typography';
import { Button } from '@dynatrace/strato-components/buttons';
import { TextInput } from '@dynatrace/strato-components-preview/forms';
import { TitleBar } from '@dynatrace/strato-components-preview/layouts';
import Colors from '@dynatrace/strato-design-tokens/colors';
import { loadAppSettings, saveAppSettings, getLastAppSettingsSaveError, type AppSettings } from '../services/app-settings';
import { edgeConnectClient } from '@dynatrace-sdk/client-app-engine-edge-connect';

import { functions } from '@dynatrace-sdk/app-utils';
import { getCurrentUserDetails, getEnvironmentUrl } from '@dynatrace-sdk/app-environment';

import { generateCsuitePrompt, generateJourneyPrompt, PROMPT_DESCRIPTIONS } from '../constants/promptTemplates';
import { INITIAL_TEMPLATES, InitialTemplate } from '../constants/initialTemplates';
import { DEMONSTRATOR_LOGO } from '../constants/demonstratorLogo';
import { VCARB_CAR } from '../constants/vcarbCar';
import { InfoButton } from '../components/InfoButton';
import { trackUiUsage } from '../services/usage-audit';
import appConfig from '../../../app.config.json';

const APP_VERSION = appConfig.app.version;

// Dynamic tenant URL — works in any environment
const TENANT_URL = (() => {
  try { return getEnvironmentUrl().replace(/\/$/, ''); } catch { return 'https://YOUR_TENANT_ID.apps.dynatracelabs.com'; }
})();
const AI_PROMPTS_URL = `${TENANT_URL}/ui/apps/dynatrace.genai.observability/prompts?perspective=Prompts+Stream&sort=start_time%3Adescending`;
const TENANT_HOST = TENANT_URL.replace(/^https?:\/\//, '');
const TENANT_ID = TENANT_HOST.split('.')[0];
const SSO_ENDPOINT = TENANT_HOST.includes('sprint') || TENANT_HOST.includes('dynatracelabs')
  ? 'https://sso.dynatracelabs.com/sso/oauth2/token'
  : 'https://sso.dynatrace.com/sso/oauth2/token';

const getAuditUser = () => {
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
};

/** Build a URL to the Dynatrace Services Explorer filtered by [Environment] tags */
const getServicesUiUrl = (companyName: string, journeyType?: string) => {
  // Match the DT_TAGS encoding: replace non-alphanumeric chars with underscore, then lowercase
  const companyTag = companyName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
  let filter = `tags = "[Environment]company:${companyTag}"`;
  if (journeyType) {
    const journeyTag = journeyType.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    filter += `  AND tags = "[Environment]journey-type:${journeyTag}" `;
  }
  return `${TENANT_URL}/ui/apps/dynatrace.services/explorer?perspective=performance&sort=entity%3Aascending#filtering=${encodeURIComponent(filter)}`;
};

const getDemonstratorDashboardsPath = (companyName: string, journeyType: string) => {
  const searchParams = new URLSearchParams();
  if (companyName) searchParams.set('company', companyName);
  if (journeyType) searchParams.set('journey', journeyType);
  const query = searchParams.toString();
  return query ? `/demonstrator-dashboards?${query}` : '/demonstrator-dashboards';
};

interface ApiSettingsFull {
  apiHost: string;
  apiPort: string;
  apiProtocol: string;
  enableAutoGeneration: boolean;
}

const DEFAULT_SETTINGS: ApiSettingsFull = {
  apiHost: 'bizobs-demonstrator',
  apiPort: '8080',
  apiProtocol: 'http',
  enableAutoGeneration: false,
};

interface RunningService {
  service: string;
  running: boolean;
  pid: number;
  port?: number;
  companyName?: string;
  domain?: string;
  industryType?: string;
  journeyType?: string;
  journeyDetail?: string;
  stepName?: string;
  baseServiceName?: string;
  createdByUserEmail?: string;
  createdByUserName?: string;
  serviceVersion?: number;
  releaseStage?: string;
  startTime?: number;
}

const getServiceCreatorValue = (service: Partial<RunningService>) => {
  const email = String(service.createdByUserEmail || '').trim().toLowerCase();
  if (email) return email;
  return String(service.createdByUserName || '').trim().toLowerCase();
};

const getServiceCreatorLabel = (service: Partial<RunningService>) => {
  const email = String(service.createdByUserEmail || '').trim();
  if (email) return email;
  const name = String(service.createdByUserName || '').trim();
  return name || 'unknown creator';
};

interface PromptTemplate {
  id: string;
  name: string;
  companyName: string;
  domain: string;
  requirements: string;
  csuitePrompt: string;
  journeyPrompt: string;
  response?: string; // JSON response from Copilot
  originalConfig?: any; // Full config for pre-loaded templates
  createdAt: string;
  isPreloaded?: boolean;
}

const TEMPLATES_STORAGE_KEY = 'bizobs_prompt_templates';
const DEMO_SCHEDULES_STORAGE_KEY = 'bizobs_demo_schedules';

interface DemoScheduleEntry {
  id: string;
  customerName: string;
  companyName: string;
  journeyType: string;
  fromAt: string;
  toAt: string;
  timezone: string;
  tenantTimezone: string;
  schedulerEmail: string;
  schedulerName: string;
  createdAt: string;
  notes?: string;
}

function mergePromptTemplates(localTemplates: PromptTemplate[], sharedTemplates: PromptTemplate[]): PromptTemplate[] {
  const byId = new Map<string, PromptTemplate>();

  for (const t of sharedTemplates) {
    if (t?.id) byId.set(t.id, t);
  }

  for (const t of localTemplates) {
    if (!t?.id) continue;
    const existing = byId.get(t.id);
    if (!existing) {
      byId.set(t.id, t);
      continue;
    }

    const localTime = Date.parse(t.createdAt || '');
    const sharedTime = Date.parse(existing.createdAt || '');
    const useLocal = Number.isFinite(localTime) && Number.isFinite(sharedTime)
      ? localTime >= sharedTime
      : true;

    byId.set(t.id, useLocal ? t : existing);
  }

  return [...byId.values()].sort((a, b) => {
    const aTime = Date.parse(a.createdAt || '');
    const bTime = Date.parse(b.createdAt || '');
    if (Number.isFinite(aTime) && Number.isFinite(bTime)) return bTime - aTime;
    return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
  });
}

const toLocalDateInput = (d: Date) => {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const buildCalendarDays = (monthStart: Date) => {
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const firstDay = new Date(year, month, 1);
  const weekdayOffset = firstDay.getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const days: Array<{ date: Date; inCurrentMonth: boolean }> = [];

  for (let i = 0; i < weekdayOffset; i++) {
    const date = new Date(year, month, i - weekdayOffset + 1);
    days.push({ date, inCurrentMonth: false });
  }

  for (let day = 1; day <= daysInMonth; day++) {
    days.push({ date: new Date(year, month, day), inCurrentMonth: true });
  }

  while (days.length % 7 !== 0) {
    const next = days.length - (weekdayOffset + daysInMonth) + 1;
    days.push({ date: new Date(year, month + 1, next), inCurrentMonth: false });
  }

  return days;
};

const startOfWeek = (d: Date) => {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  copy.setDate(copy.getDate() - copy.getDay());
  return copy;
};

const endOfWeek = (d: Date) => {
  const start = startOfWeek(d);
  const end = new Date(start);
  end.setDate(start.getDate() + 7);
  return end;
};

const formatScheduleRange = (fromIso: string, toIso: string) => {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  return `${from.toLocaleString()} - ${to.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

const toJourneyKey = (companyName: string, journeyType: string) => {
  return `${String(companyName || '').trim().toLowerCase()}::${String(journeyType || '').trim().toLowerCase()}`;
};

// ── AI provider catalog ──────────────────────────────────────────────────
// Mirrors AI_PROVIDERS in api/proxy-api.function.ts. Keep the ids in sync:
// the function normalizes anything unknown to 'openai-compatible'.
type AiProviderId = 'openai' | 'openai-compatible' | 'azure-openai' | 'github-models' | 'anthropic' | 'ollama';

interface AiProviderCatalogEntry {
  id: AiProviderId;
  label: string;
  defaultModel: string;
  suggestedModels: string[];
  needsBaseUrl: boolean;
  needsKey: boolean;
  alwaysViaVm: boolean;
  keyHint: string;
  keyUrl?: string;
  note?: string;
}

const AI_PROVIDER_CATALOG: AiProviderCatalogEntry[] = [
  {
    id: 'openai', label: 'OpenAI', defaultModel: 'gpt-4.1',
    suggestedModels: ['gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
    needsBaseUrl: false, needsKey: true, alwaysViaVm: false,
    keyHint: 'sk-...', keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'anthropic', label: 'Anthropic (Claude)', defaultModel: 'claude-3-5-sonnet-latest',
    suggestedModels: ['claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
    needsBaseUrl: false, needsKey: true, alwaysViaVm: false,
    keyHint: 'sk-ant-...', keyUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'github-models', label: 'GitHub Models (Copilot PAT)', defaultModel: 'gpt-4.1',
    suggestedModels: ['gpt-4.1', 'gpt-4o', 'gpt-4.1-mini'],
    needsBaseUrl: false, needsKey: true, alwaysViaVm: false,
    keyHint: 'ghp_... or github_pat_...', keyUrl: 'https://github.com/settings/personal-access-tokens',
    note: 'A fine-grained token with default read-only access is enough.',
  },
  {
    id: 'azure-openai', label: 'Azure OpenAI', defaultModel: 'gpt-4.1',
    suggestedModels: ['gpt-4.1', 'gpt-4o'],
    needsBaseUrl: true, needsKey: true, alwaysViaVm: false,
    keyHint: 'Azure API key',
    note: 'Base URL is your deployment endpoint, e.g. https://<resource>.openai.azure.com/openai/deployments/<deployment>',
  },
  {
    id: 'openai-compatible', label: 'OpenAI-compatible (OpenRouter, vLLM, LiteLLM, etc.)', defaultModel: 'gpt-4.1',
    suggestedModels: [],
    needsBaseUrl: true, needsKey: true, alwaysViaVm: false,
    keyHint: 'Provider API key',
    note: 'Any gateway exposing POST /chat/completions. Base URL should include the version path, e.g. https://openrouter.ai/api/v1',
  },
  {
    id: 'ollama', label: 'Ollama (on the demo host)', defaultModel: 'llama3.2',
    suggestedModels: ['llama3.2', 'llama3.1', 'mistral'],
    needsBaseUrl: false, needsKey: false, alwaysViaVm: true,
    keyHint: '',
    note: 'Runs on the demo host, so calls always route through it. No API key needed.',
  },
];

const aiProviderDef = (id: string): AiProviderCatalogEntry =>
  AI_PROVIDER_CATALOG.find(p => p.id === id)
  || AI_PROVIDER_CATALOG.find(p => p.id === 'openai-compatible')!;

export const HomePage = () => {
  const [activeTab, setActiveTab] = useState('welcome');
  const [selectedPathway, setSelectedPathway] = useState<'ai' | 'manual' | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [domain, setDomain] = useState('');
  const [requirements, setRequirements] = useState('');
  const [copilotResponse, setCopilotResponse] = useState('');
  const [prompt1, setPrompt1] = useState('');
  const [prompt2, setPrompt2] = useState('');
  const [savedTemplates, setSavedTemplates] = useState<PromptTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [isGeneratingServices, setIsGeneratingServices] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({ 
    appTemplates: false, 
    myTemplates: false,
    vcarbDemo: false 
  });
  const [apiSettings, setApiSettingsState] = useState({
    host: DEFAULT_SETTINGS.apiHost,
    port: DEFAULT_SETTINGS.apiPort,
    protocol: DEFAULT_SETTINGS.apiProtocol,
  });

  // ── Settings via shared Document Service ──────────────────────────────────

  // Settings modal state
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [settingsForm, setSettingsForm] = useState<ApiSettingsFull>(DEFAULT_SETTINGS);
  const [settingsStatus, setSettingsStatus] = useState('');
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [detectedCallerIp, setDetectedCallerIp] = useState<string | null>(null);

  // Services modal state
  const [showServicesModal, setShowServicesModal] = useState(false);
  const [runningServices, setRunningServices] = useState<RunningService[]>([]);
  const [isLoadingServices, setIsLoadingServices] = useState(false);
  const [isStoppingServices, setIsStoppingServices] = useState(false);
  const [stoppingCompany, setStoppingCompany] = useState<string | null>(null);
  const [servicesStatus, setServicesStatus] = useState('');

  // Dormant services state
  const [dormantServices, setDormantServices] = useState<any[]>([]);
  const [isLoadingDormant, setIsLoadingDormant] = useState(false);
  const [isClearingDormant, setIsClearingDormant] = useState(false);
  const [showDormantWarning, setShowDormantWarning] = useState<string | null>(null); // company name or 'all'
  const [clearingDormantCompany, setClearingDormantCompany] = useState<string | null>(null);

  const journeyInventory: RunningService[] = [...runningServices, ...dormantServices].filter((service, index, all) => {
    const key = [service.companyName, service.journeyType, service.baseServiceName || service.service, service.stepName].join('::');
    return index === all.findIndex((candidate) => {
      const candidateKey = [candidate.companyName, candidate.journeyType, candidate.baseServiceName || candidate.service, candidate.stepName].join('::');
      return candidateKey === key;
    });
  });

  // Settings modal tab state
  const [settingsTab, setSettingsTab] = useState<'config' | 'edgeconnect' | 'system' | 'ai'>('config');

  // System maintenance state
  const [systemHealth, setSystemHealth] = useState<any>(null);
  const [isLoadingHealth, setIsLoadingHealth] = useState(false);
  const [isRunningCleanup, setIsRunningCleanup] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<any>(null);
  const [generatedDashboards, setGeneratedDashboards] = useState<any[]>([]);
  const [isLoadingGeneratedDashboards, setIsLoadingGeneratedDashboards] = useState(false);
  const [deletingDashboardId, setDeletingDashboardId] = useState<string | null>(null);
  const [dashboardMgmtStatus, setDashboardMgmtStatus] = useState('');

  // EdgeConnect state
  const [edgeConnects, setEdgeConnects] = useState<any[]>([]);
  const [isLoadingEC, setIsLoadingEC] = useState(false);
  const [ecStatus, setEcStatus] = useState('');
  const [isDeletingEC, setIsDeletingEC] = useState<string | null>(null);
  const [ecMatchResult, setEcMatchResult] = useState<{ matched: boolean; name?: string; pattern?: string } | null>(null);
  const [isCheckingMatch, setIsCheckingMatch] = useState(false);
  const [isCreatingEC, setIsCreatingEC] = useState(false);
  // EdgeConnect config inputs (for YAML generation & verification)
  const [ecName, setEcName] = useState('bizobs-demonstrator');
  const [ecHostPattern, setEcHostPattern] = useState('');
  const [ecClientId, setEcClientId] = useState('');
  const [ecClientSecret, setEcClientSecret] = useState('');

  // Tooltip state for header buttons
  const [showServicesTooltip, setShowServicesTooltip] = useState(false);
  const [showSettingsTooltip, setShowSettingsTooltip] = useState(false);
  const [showGetStartedTooltip, setShowGetStartedTooltip] = useState(false);
  const [showScheduleTooltip, setShowScheduleTooltip] = useState(false);
  const [showNavMenu, setShowNavMenu] = useState(false);
  const navMenuRef = useRef<HTMLDivElement>(null);
  const [showScheduleMenu, setShowScheduleMenu] = useState(false);
  const scheduleMenuRef = useRef<HTMLDivElement>(null);
  const [showSupportMenu, setShowSupportMenu] = useState(false);
  const supportMenuRef = useRef<HTMLDivElement>(null);
  const [showBugReportModal, setShowBugReportModal] = useState(false);
  const [isSubmittingBugReport, setIsSubmittingBugReport] = useState(false);
  const [bugReportStatus, setBugReportStatus] = useState('');
  const [bugReportIssueUrl, setBugReportIssueUrl] = useState<string | null>(null);
  const [bugReportForm, setBugReportForm] = useState({
    title: '',
    summary: '',
    stepsToReproduce: '',
    expectedBehavior: '',
    actualBehavior: '',
  });
  const [demoSchedules, setDemoSchedules] = useState<DemoScheduleEntry[]>([]);
  const [scheduleStatus, setScheduleStatus] = useState('');
  const [scheduleForm, setScheduleForm] = useState({
    customerName: '',
    companyName: '',
    journeyType: '',
    fromAt: '',
    toAt: '',
    notes: '',
  });
  const tenantCalendarTimezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
      return 'UTC';
    }
  }, []);
  const [scheduleTimezone, setScheduleTimezone] = useState('');
  const [scheduleAuditView, setScheduleAuditView] = useState<'day' | 'week' | 'month'>('week');
  const [scheduleCalendarMonth, setScheduleCalendarMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });
  const [scheduleDate, setScheduleDate] = useState(() => toLocalDateInput(new Date()));
  const [scheduleFromTime, setScheduleFromTime] = useState('09:00');
  const [scheduleToTime, setScheduleToTime] = useState('10:00');
  const [bizEventJourneyOptions, setBizEventJourneyOptions] = useState<Array<{ customerName: string; companyName: string; journeyType: string }>>([]);
  const [isLoadingScheduleOptions, setIsLoadingScheduleOptions] = useState(false);
  const [lastScheduleOptionsRefresh, setLastScheduleOptionsRefresh] = useState<number | null>(null);

  const runningJourneyOptions = useMemo(() => {
    const seen = new Set<string>();
    const rows: Array<{ customerName: string; companyName: string; journeyType: string }> = [];
    journeyInventory.forEach((service) => {
      const company = String(service.companyName || '').trim();
      const journey = String(service.journeyType || service.journeyDetail || '').trim();
      if (!company || !journey) return;
      const key = `${company}::${journey}`.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({
        customerName: company,
        companyName: company,
        journeyType: journey,
      });
    });
    return rows.sort((a, b) => {
      const companyCmp = a.companyName.localeCompare(b.companyName);
      return companyCmp !== 0 ? companyCmp : a.journeyType.localeCompare(b.journeyType);
    });
  }, [journeyInventory]);

  const scheduleJourneyOptions = useMemo(() => {
    return bizEventJourneyOptions.length > 0 ? bizEventJourneyOptions : runningJourneyOptions;
  }, [bizEventJourneyOptions, runningJourneyOptions]);

  const journeyRuntimeByKey = useMemo(() => {
    const map = new Map<string, { running: number; dormant: number }>();

    runningServices.forEach((service) => {
      const key = toJourneyKey(String(service.companyName || ''), String(service.journeyType || service.journeyDetail || ''));
      if (!key || key === '::') return;
      const curr = map.get(key) || { running: 0, dormant: 0 };
      map.set(key, { ...curr, running: curr.running + 1 });
    });

    dormantServices.forEach((service) => {
      const key = toJourneyKey(String(service.companyName || ''), String(service.journeyType || service.journeyDetail || ''));
      if (!key || key === '::') return;
      const curr = map.get(key) || { running: 0, dormant: 0 };
      map.set(key, { ...curr, dormant: curr.dormant + 1 });
    });

    return map;
  }, [runningServices, dormantServices]);

  const getScheduleReadiness = useCallback((entry: DemoScheduleEntry) => {
    const key = toJourneyKey(entry.companyName, entry.journeyType);
    const counts = journeyRuntimeByKey.get(key) || { running: 0, dormant: 0 };
    const now = Date.now();
    const fromMs = Date.parse(entry.fromAt);
    const toMs = Date.parse(entry.toAt);
    const isLiveWindow = Number.isFinite(fromMs) && Number.isFinite(toMs) && now >= fromMs && now <= toMs;
    const minsToStart = Number.isFinite(fromMs) ? Math.floor((fromMs - now) / 60000) : Number.POSITIVE_INFINITY;
    const isUpcomingSoon = minsToStart >= 0 && minsToStart <= 60;
    const fullyUp = counts.running > 0 && counts.dormant === 0;
    const partiallyUp = counts.running > 0 && counts.dormant > 0;

    if (isLiveWindow && fullyUp) {
      return { label: 'LIVE READY', detail: `${counts.running} running`, color: '#73be28', bg: 'rgba(115,190,40,0.15)', border: 'rgba(115,190,40,0.4)' };
    }
    if (isLiveWindow && partiallyUp) {
      return { label: 'LIVE AT RISK', detail: `${counts.running} running, ${counts.dormant} dormant`, color: '#f39c12', bg: 'rgba(243,156,18,0.14)', border: 'rgba(243,156,18,0.38)' };
    }
    if (isLiveWindow) {
      return { label: 'LIVE DOWN', detail: 'no running services', color: '#dc322f', bg: 'rgba(220,50,47,0.14)', border: 'rgba(220,50,47,0.4)' };
    }

    if (isUpcomingSoon && fullyUp) {
      return { label: 'READY', detail: `${counts.running} running`, color: '#73be28', bg: 'rgba(115,190,40,0.15)', border: 'rgba(115,190,40,0.4)' };
    }
    if (isUpcomingSoon && partiallyUp) {
      return { label: 'AT RISK', detail: `${counts.running} running, ${counts.dormant} dormant`, color: '#f39c12', bg: 'rgba(243,156,18,0.14)', border: 'rgba(243,156,18,0.38)' };
    }
    if (isUpcomingSoon) {
      return { label: 'NOT READY', detail: 'no running services', color: '#dc322f', bg: 'rgba(220,50,47,0.14)', border: 'rgba(220,50,47,0.4)' };
    }

    if (fullyUp) {
      return { label: 'UP', detail: `${counts.running} running`, color: '#8ec7ff', bg: 'rgba(0,161,201,0.14)', border: 'rgba(0,161,201,0.38)' };
    }
    if (partiallyUp) {
      return { label: 'PARTIAL', detail: `${counts.running} running, ${counts.dormant} dormant`, color: '#f1c40f', bg: 'rgba(243,156,18,0.14)', border: 'rgba(243,156,18,0.38)' };
    }
    return { label: 'UNKNOWN/DOWN', detail: 'no running services', color: '#aabbd0', bg: 'rgba(112,150,205,0.14)', border: 'rgba(112,150,205,0.35)' };
  }, [journeyRuntimeByKey]);

  const runningCustomerCompanyOptions = useMemo(() => {
    return Array.from(new Set(scheduleJourneyOptions.map((option) => option.companyName))).sort((a, b) => a.localeCompare(b));
  }, [scheduleJourneyOptions]);

  const runningJourneyTypesForSelectedCompany = useMemo(() => {
    if (!scheduleForm.companyName) return [] as string[];
    return Array.from(new Set(
      scheduleJourneyOptions
        .filter((option) => option.companyName === scheduleForm.companyName)
        .map((option) => option.journeyType)
    )).sort((a, b) => a.localeCompare(b));
  }, [scheduleJourneyOptions, scheduleForm.companyName]);

  const scheduleCalendarDays = useMemo(() => buildCalendarDays(scheduleCalendarMonth), [scheduleCalendarMonth]);

  const filteredDemoSchedules = useMemo(() => {
    const anchor = new Date(`${scheduleDate}T00:00:00`);
    return demoSchedules
      .filter((entry) => {
        const from = new Date(entry.fromAt);
        if (scheduleAuditView === 'day') {
          return from.toDateString() === anchor.toDateString();
        }
        if (scheduleAuditView === 'week') {
          const start = startOfWeek(anchor);
          const end = endOfWeek(anchor);
          return from >= start && from < end;
        }
        return from.getMonth() === anchor.getMonth() && from.getFullYear() === anchor.getFullYear();
      })
      .sort((a, b) => Date.parse(a.fromAt) - Date.parse(b.fromAt));
  }, [demoSchedules, scheduleDate, scheduleAuditView]);

  // Close nav menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (navMenuRef.current && !navMenuRef.current.contains(e.target as Node)) {
        setShowNavMenu(false);
      }
      if (scheduleMenuRef.current && !scheduleMenuRef.current.contains(e.target as Node)) {
        setShowScheduleMenu(false);
      }
      if (supportMenuRef.current && !supportMenuRef.current.contains(e.target as Node)) {
        setShowSupportMenu(false);
      }
    };
    if (showNavMenu || showScheduleMenu || showSupportMenu) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showNavMenu, showScheduleMenu, showSupportMenu]);

  useEffect(() => {
    if (!scheduleDate || !scheduleFromTime || !scheduleToTime) return;
    setScheduleForm((prev) => ({
      ...prev,
      fromAt: `${scheduleDate}T${scheduleFromTime}`,
      toAt: `${scheduleDate}T${scheduleToTime}`,
    }));
  }, [scheduleDate, scheduleFromTime, scheduleToTime]);

  useEffect(() => {
    if (!scheduleTimezone) setScheduleTimezone(tenantCalendarTimezone);
  }, [scheduleTimezone, tenantCalendarTimezone]);

  const loadScheduleOptionsFromBizEvents = useCallback(async (silent = false) => {
    if (!silent) setIsLoadingScheduleOptions(true);
    try {
      const query = `fetch bizevents, from: now()-30d
| filter isNotNull(json.companyName) and isNotNull(json.journeyType)
| fields timestamp, companyName = json.companyName, journeyType = json.journeyType
| sort timestamp desc
| limit 2000`;

      const res = await functions.call('proxy-api', {
        data: {
          action: 'execute-dql',
          apiHost: apiSettings.host,
          apiPort: apiSettings.port,
          apiProtocol: apiSettings.protocol,
          ...getAuditUser(),
          body: { query, timeoutMs: 15000, maxRecords: 2000 },
        },
      });
      const data = await res.json() as any;
      if (!data?.success) {
        if (!silent) setScheduleStatus(`❌ Could not load BizEvents options: ${data?.error || 'Unknown error'}`);
        return;
      }

      const seen = new Set<string>();
      const options: Array<{ customerName: string; companyName: string; journeyType: string }> = [];
      (data.records || []).forEach((record: any) => {
        const company = String(record.companyName || '').trim();
        const journey = String(record.journeyType || '').trim();
        if (!company || !journey) return;
        const key = `${company}::${journey}`.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        options.push({ customerName: company, companyName: company, journeyType: journey });
      });

      options.sort((a, b) => {
        const byCompany = a.companyName.localeCompare(b.companyName);
        return byCompany !== 0 ? byCompany : a.journeyType.localeCompare(b.journeyType);
      });

      setBizEventJourneyOptions(options);
      setLastScheduleOptionsRefresh(Date.now());
      if (!silent) {
        setScheduleStatus(options.length > 0
          ? `✅ Loaded ${options.length} journey option(s) from BizEvents`
          : '⚠️ No recent BizEvents found. Falling back to running journeys.');
      }
    } catch (err: any) {
      if (!silent) setScheduleStatus(`❌ BizEvents load failed: ${err?.message || 'Unknown error'}`);
    } finally {
      if (!silent) setIsLoadingScheduleOptions(false);
    }
  }, [apiSettings.host, apiSettings.port, apiSettings.protocol]);

  useEffect(() => {
    if (!showScheduleMenu) return;
    void loadScheduleOptionsFromBizEvents(true);
    const id = setInterval(() => {
      void loadScheduleOptionsFromBizEvents(true);
    }, 60000);
    return () => clearInterval(id);
  }, [showScheduleMenu, loadScheduleOptionsFromBizEvents]);

  const refreshScheduleRuntime = useCallback(async () => {
    try {
      const [runningRes, dormantRes] = await Promise.all([
        functions.call('proxy-api', {
          data: {
            action: 'get-services',
            apiHost: apiSettings.host,
            apiPort: apiSettings.port,
            apiProtocol: apiSettings.protocol,
          },
        }),
        functions.call('proxy-api', {
          data: {
            action: 'get-dormant-services',
            apiHost: apiSettings.host,
            apiPort: apiSettings.port,
            apiProtocol: apiSettings.protocol,
          },
        }),
      ]);

      const runningJson = await runningRes.json() as any;
      const dormantJson = await dormantRes.json() as any;

      if (runningJson?.success && Array.isArray(runningJson?.data?.childServices)) {
        setRunningServices(runningJson.data.childServices);
      }
      if (dormantJson?.success && Array.isArray(dormantJson?.data?.dormantServices)) {
        setDormantServices(dormantJson.data.dormantServices);
      }
    } catch {
      // Keep current runtime snapshot if refresh fails.
    }
  }, [apiSettings.host, apiSettings.port, apiSettings.protocol]);

  useEffect(() => {
    if (!showScheduleMenu) return;
    void refreshScheduleRuntime();
    const id = setInterval(() => {
      void refreshScheduleRuntime();
    }, 30000);
    return () => clearInterval(id);
  }, [showScheduleMenu, refreshScheduleRuntime]);

  // VCARB Race state
  const navigate = useNavigate();
  const [isStartingRace, setIsStartingRace] = useState(false);
  const [raceStatus, setRaceStatus] = useState<string | null>(null);

  // Journeys modal state
  const [showJourneysModal, setShowJourneysModal] = useState(false);
  const [journeysData, setJourneysData] = useState<RunningService[]>([]);
  const [isLoadingJourneys, setIsLoadingJourneys] = useState(false);
  const [journeysStatus, setJourneysStatus] = useState('');
  const [journeyAssets, setJourneyAssets] = useState<Record<string, { dashboard: { exists: boolean; id: string; url: string; name?: string }; bizflow: { exists: boolean; name?: string } }>>({});

  // Dashboard generation state
  const [dashboardUrl, setDashboardUrl] = useState<string | null>(null);
  const [isGeneratingDashboard, setIsGeneratingDashboard] = useState(false);

  // Generate Visuals modal sub-tab state
  const [visualsSubTab, setVisualsSubTab] = useState<'dashboard' | 'saved' | 'pdf'>('pdf');
  const DASHBOARD_DTCTL_UI_ENABLED = false;
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfStatus, setPdfStatus] = useState('');
  const [dashboardStatus, setDashboardStatus] = useState('');
  const [generatedDashboardJson, setGeneratedDashboardJson] = useState<any>(null);
  const [dashboardDeployPreflight, setDashboardDeployPreflight] = useState<{ status: 'idle' | 'checking' | 'ready' | 'error'; message: string; details?: any }>({ status: 'idle', message: 'Preflight not checked yet.' });
  const [selectedSavedDashboardId, setSelectedSavedDashboardId] = useState<string | null>(null);
  const [showDashboardPreflightDetails, setShowDashboardPreflightDetails] = useState(false);

  // Saved dashboards state
  const [savedDashboards, setSavedDashboards] = useState<any[]>([]);
  const [isLoadingSavedDashboards, setIsLoadingSavedDashboards] = useState(false);
  const [savedDashboardFilterCompany, setSavedDashboardFilterCompany] = useState('all');
  const [savedDashboardFilterJourney, setSavedDashboardFilterJourney] = useState('all');
  const [savedDashboardFilterSource, setSavedDashboardFilterSource] = useState('all');

  // MCP custom prompt state
  const [mcpDashboardPrompt, setMcpDashboardPrompt] = useState('');

  // Dashboard template generation modal state
  const [showGenerateDashboardModal, setShowGenerateDashboardModal] = useState(false);
  const [dashboardCompanyName, setDashboardCompanyName] = useState('');
  const [dashboardJourneyType, setDashboardJourneyType] = useState('');
  const [availableCompanies, setAvailableCompanies] = useState<string[]>([]);
  const [availableJourneys, setAvailableJourneys] = useState<string[]>([]);
  const [isLoadingDashboardData, setIsLoadingDashboardData] = useState(false);
  const [dashboardGenerationStatus, setDashboardGenerationStatus] = useState('');
  const [bizEventsAvailable, setBizEventsAvailable] = useState<null | boolean>(null);
  const [bizEventsCount, setBizEventsCount] = useState<number>(0);
  const [isBizEventsChecking, setIsBizEventsChecking] = useState(false);



  // Chaos Nemesis Agent modal state
  const [showChaosModal, setShowChaosModal] = useState(false);
  const [chaosTab, setChaosTab] = useState<'active' | 'inject' | 'targeted' | 'smart'>('active');
  const [activeFaults, setActiveFaults] = useState<any[]>([]);
  const [chaosRecipes, setChaosRecipes] = useState<any[]>([]);
  const [targetedServices, setTargetedServices] = useState<Record<string, any>>({});
  const [isLoadingChaos, setIsLoadingChaos] = useState(false);
  const [chaosStatus, setChaosStatus] = useState('');
  const [isInjectingChaos, setIsInjectingChaos] = useState(false);
  const [isRevertingChaos, setIsRevertingChaos] = useState(false);
  const [smartChaosGoal, setSmartChaosGoal] = useState('');
  const [isSmartChaosRunning, setIsSmartChaosRunning] = useState(false);
  const [injectForm, setInjectForm] = useState({ type: 'enable_errors', target: '', intensity: 5, duration: 60 });
  const [chaosFilterCompany, setChaosFilterCompany] = useState('all');
  const [chaosFilterCreator, setChaosFilterCreator] = useState('all');

  // Step 2 guided sub-step state
  const [step2Phase, setStep2Phase] = useState<'prompts' | 'response' | 'generate'>(  'prompts');

  // AI generation state. Note: the gh* names are historical (this used to be
  // GitHub-Copilot-only). They now mean "the configured AI provider", whichever
  // one that is. ghCopilotConfigured gates every Generate button in the app.
  const [ghCopilotConfigured, setGhCopilotConfigured] = useState(false);
  const [ghCopilotChecking, setGhCopilotChecking] = useState(false);
  const [ghCopilotToken, setGhCopilotToken] = useState('');
  const [ghCopilotSaving, setGhCopilotSaving] = useState(false);
  const [ghCopilotStatus, setGhCopilotStatus] = useState('');
  const [ghCopilotModel, setGhCopilotModel] = useState('gpt-4.1');

  // Provider-agnostic AI settings (provider/baseUrl/routeViaVm live in the shared
  // app-settings document; the API key lives in the Dynatrace credential vault).
  const [aiProvider, setAiProvider] = useState<AiProviderId>('github-models');
  const [aiBaseUrl, setAiBaseUrl] = useState('');
  const [aiRouteViaVm, setAiRouteViaVm] = useState(false);
  const [aiProviderHost, setAiProviderHost] = useState('');
  const [aiHostAllowed, setAiHostAllowed] = useState(true);
  const [aiConfigSaving, setAiConfigSaving] = useState(false);
  const [ghGenerating1, setGhGenerating1] = useState(false);
  const [ghGenerating2, setGhGenerating2] = useState(false);
  const [ghGeneratingAll, setGhGeneratingAll] = useState(false);
  const [ghResult1, setGhResult1] = useState('');
  const [ghResult2, setGhResult2] = useState('');

  // AI Generation Modal state — full automated pipeline
  const [showAiGenModal, setShowAiGenModal] = useState(false);
  const [aiGenSteps, setAiGenSteps] = useState<Array<{ label: string; status: 'pending' | 'running' | 'done' | 'error'; detail?: string }>>([]);
  const [aiGenComplete, setAiGenComplete] = useState(false);
  const [aiGenError, setAiGenError] = useState('');
  const [aiGenDashboardUrl, setAiGenDashboardUrl] = useState<string | null>(null);
  const [aiGenDashboardCompany, setAiGenDashboardCompany] = useState('');
  const [aiGenDashboardJourney, setAiGenDashboardJourney] = useState('');

  // "Use Your Own AI Prompt" (paste) flow state
  const [showPasteAiModal, setShowPasteAiModal] = useState(false);
  const [pastedAiResponse, setPastedAiResponse] = useState('');
  const [extractedJourneys, setExtractedJourneys] = useState<string[]>([]);
  const [selectedJourneyName, setSelectedJourneyName] = useState('');
  const [ownAiPhase, setOwnAiPhase] = useState<'details' | 'paste' | 'generate'>('details');

  // Journey picker modal state (shown after prompt 1 when requirements blank)
  const [showJourneyPickerModal, setShowJourneyPickerModal] = useState(false);
  const [journeyPickerResolve, setJourneyPickerResolve] = useState<((journey: string) => void) | null>(null);

  // Toast notification state
  const [toastMessage, setToastMessage] = useState('');
  const [toastType, setToastType] = useState<'success' | 'error' | 'warning' | 'info'>('info');
  const [toastVisible, setToastVisible] = useState(false);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Confirm dialog state (replaces native confirm())
  const [confirmDialog, setConfirmDialog] = useState<{ message: string; onConfirm: () => void } | null>(null);

  // Builtin settings detection state (OpenPipeline, BizEvents capture, OneAgent features)
  const [builtinSettingsDetected, setBuiltinSettingsDetected] = useState<Record<string, boolean>>({});
  const [isDeployingConfigs, setIsDeployingConfigs] = useState(false);
  const [deployConfigsStatus, setDeployConfigsStatus] = useState('');
  const [connectionTestedOk, setConnectionTestedOk] = useState(() => {
    try { return localStorage.getItem('bizobs_connection_tested') === 'true'; } catch { return false; }
  });

  // Get Started checklist state — persisted to Dynatrace tenant settings
  const [showGetStartedModal, setShowGetStartedModal] = useState(false);
  const [checklist, setChecklist] = useState<Record<string, boolean>>(() => {
    try { return JSON.parse(localStorage.getItem('bizobs_checklist') || '{}'); } catch { return {}; }
  });
  const checklistSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveChecklistToTenant = useCallback((next: Record<string, boolean>) => {
    // Debounced save to shared Document Service
    if (checklistSaveRef.current) clearTimeout(checklistSaveRef.current);
    checklistSaveRef.current = setTimeout(async () => {
      try {
        const current = await loadAppSettings();
        await saveAppSettings({ ...current.settings, checklistState: JSON.stringify(next) });
      } catch { /* silent */ }
    }, 1500);
  }, []);

  // Generic helper: merge a partial value into the shared Document
  const tenantFieldSaveRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTenantField = useCallback((partial: Record<string, unknown>, debounceMs = 500) => {
    if (tenantFieldSaveRef.current) clearTimeout(tenantFieldSaveRef.current);
    tenantFieldSaveRef.current = setTimeout(async () => {
      try {
        const current = await loadAppSettings();
        await saveAppSettings({ ...current.settings, ...partial } as AppSettings);
      } catch { /* silent */ }
    }, debounceMs);
  }, []);

  const toggleCheck = (key: string) => {
    setChecklist(prev => {
      const next = { ...prev, [key]: !prev[key] };
      localStorage.setItem('bizobs_checklist', JSON.stringify(next));
      saveChecklistToTenant(next);
      return next;
    });
  };
  const checklistSteps = [
    { key: 'server-ip', label: 'Configure Server IP', section: 'server' },
    { key: 'edgeconnect-create', label: 'Create EdgeConnect in Dynatrace', section: 'network' },
    { key: 'edgeconnect-deploy', label: 'Deploy EdgeConnect on Server', section: 'network' },
    { key: 'edgeconnect-online', label: 'Verify EdgeConnect is Online', section: 'network' },
    { key: 'oneagent', label: 'OneAgent Installed on Host', section: 'monitoring' },
    { key: 'test-connection', label: 'Test Connection from App', section: 'verify' },
    { key: 'openpipeline', label: 'OpenPipeline Pipeline Created', section: 'config' },
    { key: 'openpipeline-routing', label: 'OpenPipeline Routing Configured', section: 'config' },
    { key: 'biz-events', label: 'Business Event Capture Rule', section: 'config' },
    { key: 'feature-flags', label: 'OneAgent Feature Flag Enabled', section: 'config' },
    { key: 'outbound-github-models', label: 'AI Provider Outbound Allowed', section: 'config' },
    { key: 'automation-workflow', label: 'Fix-It Agent Workflow Deployed', section: 'config' },
  ];

  // Auto-detected checklist state (merged with manual checks)
  // These are computed from live state and override manual toggles
  const autoDetected: Record<string, boolean> = {
    'server-ip': !!(apiSettings.host && apiSettings.host !== '' && apiSettings.host !== 'localhost'),
    'edgeconnect-create': builtinSettingsDetected['edgeconnect-create'] || edgeConnects.length > 0,
    'edgeconnect-deploy': builtinSettingsDetected['edgeconnect-deploy'] || edgeConnects.some((ec: any) => (ec.metadata?.instances || []).length > 0),
    'edgeconnect-online': builtinSettingsDetected['edgeconnect-online'] || edgeConnects.some((ec: any) => (ec.metadata?.instances || []).length > 0),
    'oneagent': builtinSettingsDetected['oneagent'] || false,
    'test-connection': builtinSettingsDetected['test-connection'] || connectionTestedOk || ecMatchResult?.matched === true,
    'openpipeline': builtinSettingsDetected['openpipeline'] || false,
    'openpipeline-routing': builtinSettingsDetected['openpipeline-routing'] || false,
    'biz-events': builtinSettingsDetected['biz-events'] || false,
    'feature-flags': builtinSettingsDetected['feature-flags'] || false,
    'outbound-github-models': builtinSettingsDetected['outbound-github-models'] || false,
    'automation-workflow': builtinSettingsDetected['automation-workflow'] || false,
  };
  const isStepComplete = (key: string) => autoDetected[key] || checklist[key];
  const completedCount = checklistSteps.filter(s => isStepComplete(s.key)).length;
  const totalSteps = checklistSteps.length;

  /** Show toast notification at bottom of app */
  const showToast = useCallback((message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info', duration = 4000) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToastMessage(message);
    setToastType(type);
    setToastVisible(true);
    toastTimerRef.current = setTimeout(() => setToastVisible(false), duration);
  }, []);

  const resetBugReportState = useCallback(() => {
    setBugReportForm({
      title: '',
      summary: '',
      stepsToReproduce: '',
      expectedBehavior: '',
      actualBehavior: '',
    });
    setBugReportStatus('');
    setBugReportIssueUrl(null);
  }, []);

  const closeBugReportModal = useCallback(() => {
    if (isSubmittingBugReport) return;
    setShowBugReportModal(false);
    resetBugReportState();
  }, [isSubmittingBugReport, resetBugReportState]);

  const openBugReportModal = useCallback(() => {
    setShowSupportMenu(false);
    resetBugReportState();
    setShowBugReportModal(true);
    void trackUiUsage('open-bug-report', 'feedback', {
      pagePath: '/',
      destination: 'github-direct-issue',
    });
  }, [resetBugReportState]);

  const submitBugReport = useCallback(async () => {
    const title = bugReportForm.title.trim();
    const summary = bugReportForm.summary.trim();
    const stepsToReproduce = bugReportForm.stepsToReproduce.trim();
    const expectedBehavior = bugReportForm.expectedBehavior.trim();
    const actualBehavior = bugReportForm.actualBehavior.trim();

    if (!title) {
      showToast('Please enter a short bug title.', 'warning');
      return;
    }
    if (!summary && !stepsToReproduce && !actualBehavior) {
      showToast('Add the bug summary or reproduction details before submitting.', 'warning', 5000);
      return;
    }

    setIsSubmittingBugReport(true);
    setBugReportIssueUrl(null);
    setBugReportStatus('Submitting issue to GitHub...');

    try {
      const res = await functions.call('proxy-api', {
        data: {
          action: 'github-create-issue',
          apiHost: apiSettings.host,
          apiPort: apiSettings.port,
          apiProtocol: apiSettings.protocol,
          ...getAuditUser(),
          body: {
            repoOwner: 'LawrenceBarratt90',
            repoName: 'Business-Observability-Demonstrator-Internal',
            title,
            summary,
            stepsToReproduce,
            expectedBehavior,
            actualBehavior,
            labels: ['bug'],
            appVersion: APP_VERSION,
            tenantUrl: TENANT_URL,
            pagePath: '/',
          },
        },
      });
      const data = await res.json() as any;

      if (!data?.success) {
        const failureReason = String(data?.details || data?.error || 'Unknown error').trim();
        setBugReportStatus(`❌ ${failureReason}`);
        showToast(`Bug report failed: ${data?.error || 'Unknown error'}`, 'error', 7000);
        return;
      }

      const issueNumber = String(data?.data?.issueNumber || '').trim();
      const issueUrl = String(data?.data?.issueUrl || '').trim();
      setBugReportStatus(`✅ Issue #${issueNumber || '?'} created successfully.`);
      setBugReportIssueUrl(issueUrl || null);
      setBugReportForm({
        title: '',
        summary: '',
        stepsToReproduce: '',
        expectedBehavior: '',
        actualBehavior: '',
      });
      showToast(`Bug report submitted as issue #${issueNumber || '?'}`, 'success', 7000);
      void trackUiUsage('submit-bug-report', 'feedback', {
        pagePath: '/',
        destination: 'github-direct-issue',
        issueNumber,
      });
    } catch (err: any) {
      const message = err?.message || 'Unknown error';
      setBugReportStatus(`❌ ${message}`);
      showToast(`Bug report failed: ${message}`, 'error', 7000);
    } finally {
      setIsSubmittingBugReport(false);
    }
  }, [apiSettings.host, apiSettings.port, apiSettings.protocol, bugReportForm, showToast]);



  // Load saved templates from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem(TEMPLATES_STORAGE_KEY);
      if (stored) {
        setSavedTemplates(JSON.parse(stored));
      } else {
        // First time running - load initial templates from saved-configs
        const initialTemplates = INITIAL_TEMPLATES.map(t => ({
          ...t,
          // Generate prompts on demand when loaded
          csuitePrompt: t.csuitePrompt || '',
          journeyPrompt: t.journeyPrompt || ''
        }));
        setSavedTemplates(initialTemplates);
        localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(initialTemplates));
        saveTenantField({ promptTemplates: JSON.stringify(initialTemplates) });
        console.log(`✅ Loaded ${initialTemplates.length} initial templates`);
        console.log(`[BizObs] App version: v${APP_VERSION}`);
      }
    } catch (error) {
      console.error('Error loading templates:', error);
    }
  }, []);

  // Sync settings from shared Document → local state
  const settingsLoadedRef = useRef(false);
  useEffect(() => {
    if (settingsLoadedRef.current) return;
    settingsLoadedRef.current = true;

    loadAppSettings().then(({ settings: loaded, source }) => {
      console.log('[BizObs] Settings loaded from', source, ':', loaded.apiHost);

      if (source === 'document') {
        setApiSettingsState({ host: loaded.apiHost, port: loaded.apiPort, protocol: loaded.apiProtocol });
        setSettingsForm({
          apiHost: loaded.apiHost,
          apiPort: loaded.apiPort,
          apiProtocol: loaded.apiProtocol,
          enableAutoGeneration: loaded.enableAutoGeneration,
        });
        console.log('[BizObs] Applied shared settings → apiHost:', loaded.apiHost);
      } else {
        console.log('[BizObs] Shared settings unavailable or default — using in-memory defaults');
      }

      // Restore checklist
      if (loaded.checklistState) {
        try {
          const restored = JSON.parse(loaded.checklistState);
          if (restored && typeof restored === 'object') {
            setChecklist(restored);
            localStorage.setItem('bizobs_checklist', loaded.checklistState);
          }
        } catch { /* ignore */ }
      }
      // Restore prompt templates
      if (loaded.promptTemplates) {
        try {
          const restoredTemplates = JSON.parse(loaded.promptTemplates);
          if (Array.isArray(restoredTemplates) && restoredTemplates.length > 0) {
            let localTemplates: PromptTemplate[] = [];
            try {
              const localRaw = localStorage.getItem(TEMPLATES_STORAGE_KEY);
              const parsedLocal = localRaw ? JSON.parse(localRaw) : [];
              if (Array.isArray(parsedLocal)) localTemplates = parsedLocal;
            } catch { /* ignore */ }

            const mergedTemplates = mergePromptTemplates(localTemplates, restoredTemplates);
            setSavedTemplates(mergedTemplates);
            localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(mergedTemplates));
            console.log(`[BizObs] Restored templates from shared doc: shared=${restoredTemplates.length}, merged=${mergedTemplates.length}`);

            if (mergedTemplates.length > restoredTemplates.length) {
              saveTenantField({ promptTemplates: JSON.stringify(mergedTemplates) }, 0);
            }
          }
        } catch { /* ignore */ }
      }

      // Restore demo schedules
      if (loaded.demoSchedules) {
        try {
          const restoredSchedules = JSON.parse(loaded.demoSchedules);
          if (Array.isArray(restoredSchedules)) {
            const normalized = restoredSchedules
              .filter((entry: any) => entry && entry.companyName && entry.journeyType && (entry.fromAt || entry.scheduledAt))
              .map((entry: any) => ({
                id: String(entry.id || `${entry.companyName}-${entry.journeyType}-${(entry.fromAt || entry.scheduledAt)}-${Date.now()}`),
                customerName: String(entry.customerName || entry.companyName || 'Unknown Customer'),
                companyName: String(entry.companyName),
                journeyType: String(entry.journeyType),
                fromAt: String(entry.fromAt || entry.scheduledAt),
                toAt: String(entry.toAt || new Date(Date.parse(String(entry.fromAt || entry.scheduledAt)) + 60 * 60 * 1000).toISOString()),
                timezone: String(entry.timezone || tenantCalendarTimezone),
                tenantTimezone: String(entry.tenantTimezone || tenantCalendarTimezone),
                schedulerEmail: String(entry.schedulerEmail || '').trim().toLowerCase(),
                schedulerName: String(entry.schedulerName || '').trim(),
                createdAt: String(entry.createdAt || new Date().toISOString()),
                notes: String(entry.notes || ''),
              })) as DemoScheduleEntry[];
            const sorted = normalized.sort((a, b) => Date.parse(a.fromAt) - Date.parse(b.fromAt));
            setDemoSchedules(sorted);
            localStorage.setItem(DEMO_SCHEDULES_STORAGE_KEY, JSON.stringify(sorted));
          }
        } catch { /* ignore */ }
      } else {
        try {
          const localSchedulesRaw = localStorage.getItem(DEMO_SCHEDULES_STORAGE_KEY);
          const localSchedules = localSchedulesRaw ? JSON.parse(localSchedulesRaw) : [];
          if (Array.isArray(localSchedules) && localSchedules.length > 0) {
            setDemoSchedules(localSchedules as DemoScheduleEntry[]);
            saveTenantField({ demoSchedules: JSON.stringify(localSchedules) }, 0);
          }
        } catch { /* ignore */ }
      }

      // Restore connectionTested
      if (loaded.connectionTested === true) {
        setConnectionTestedOk(true);
        localStorage.setItem('bizobs_connection_tested', 'true');
      }
    }).catch(err => {
      console.warn('[BizObs] Settings load failed:', err);
    });
  }, []);

  const scheduleDemo = () => {
    const customer = scheduleForm.customerName.trim();
    const company = scheduleForm.companyName.trim();
    const journey = scheduleForm.journeyType.trim();
    const fromAt = scheduleForm.fromAt;
    const toAt = scheduleForm.toAt;

    if (!customer || !company || !journey || !fromAt || !toAt) {
      setScheduleStatus('❌ Select customer/company, journey type, and a start/end time for the demo readiness window');
      return;
    }

    const existsInRunning = scheduleJourneyOptions.some((option) => option.companyName === company && option.journeyType === journey);
    if (!existsInRunning) {
      setScheduleStatus('❌ Select a journey from BizEvents/running journey options so readiness can be validated');
      return;
    }

    const parsedFrom = Date.parse(fromAt);
    const parsedTo = Date.parse(toAt);
    if (!Number.isFinite(parsedFrom) || !Number.isFinite(parsedTo) || parsedFrom < Date.now() - 60000) {
      setScheduleStatus('❌ Please choose a valid upcoming timeframe');
      return;
    }
    if (parsedTo <= parsedFrom) {
      setScheduleStatus('❌ "To" time must be after "From" time');
      return;
    }

    const { userEmail, userName } = getAuditUser();
    const entry: DemoScheduleEntry = {
      id: `demo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      customerName: customer,
      companyName: company,
      journeyType: journey,
      fromAt: new Date(parsedFrom).toISOString(),
      toAt: new Date(parsedTo).toISOString(),
      timezone: scheduleTimezone || tenantCalendarTimezone,
      tenantTimezone: tenantCalendarTimezone,
      schedulerEmail: userEmail,
      schedulerName: userName,
      createdAt: new Date().toISOString(),
      notes: scheduleForm.notes.trim(),
    };

    const updated = [...demoSchedules, entry].sort((a, b) => Date.parse(a.fromAt) - Date.parse(b.fromAt));
    setDemoSchedules(updated);
    localStorage.setItem(DEMO_SCHEDULES_STORAGE_KEY, JSON.stringify(updated));
    saveTenantField({ demoSchedules: JSON.stringify(updated) }, 0);

    setScheduleStatus(`✅ Demo readiness window saved in tenant timezone (${tenantCalendarTimezone})`);
    showToast(`Scheduled ${entry.customerName} · ${entry.companyName} (${entry.journeyType})`, 'success', 3000);
    setScheduleTimezone(tenantCalendarTimezone);
    setScheduleForm((prev) => ({ ...prev, notes: '' }));
  };

  const removeScheduledDemo = (id: string) => {
    const updated = demoSchedules.filter((entry) => entry.id !== id);
    setDemoSchedules(updated);
    localStorage.setItem(DEMO_SCHEDULES_STORAGE_KEY, JSON.stringify(updated));
    saveTenantField({ demoSchedules: JSON.stringify(updated) }, 0);
    showToast('Removed scheduled demo', 'info', 2500);
  };

  // ── Load AI provider status (provider, model, key, outbound allowlist) ──
  // Reads whatever the app function resolved from the shared settings document
  // plus the credential vault, so the Settings panel reflects real backend state.
  const refreshAiProviderStatus = useCallback(async () => {
    setGhCopilotChecking(true);
    try {
      const resp = await functions.call('proxy-api', { data: { action: 'ai-provider-status', apiHost: '', apiPort: '', apiProtocol: '' } });
      const res = await resp.json();
      if (res.success && res.data) {
        const d = res.data;
        const def = aiProviderDef(d.provider);
        setAiProvider(def.id);
        setAiBaseUrl(String(d.baseUrl || ''));
        setAiRouteViaVm(Boolean(d.routeViaVm));
        setAiProviderHost(String(d.host || ''));
        setAiHostAllowed(d.hostAllowed !== false);
        setGhCopilotModel(String(d.model || def.defaultModel));
        setGhCopilotConfigured(Boolean(d.keyConfigured));
      }
    } catch { /* leave defaults in place */ }
    setGhCopilotChecking(false);
  }, []);

  useEffect(() => { void refreshAiProviderStatus(); }, [refreshAiProviderStatus]);

  // Options for the inline model pickers. Curated per provider, and always
  // includes the currently selected model so a controlled <select> never holds
  // a value it has no matching <option> for.
  const aiModelOptions = useMemo(() => {
    const base = aiProviderDef(aiProvider).suggestedModels;
    return Array.from(new Set([ghCopilotModel, ...base].filter(Boolean)));
  }, [aiProvider, ghCopilotModel]);

  // Persists provider/model/baseUrl/routeViaVm into the shared app-settings
  // document. The API key is never stored here, it goes to the credential vault.
  const persistAiConfig = useCallback(async (
    overrides?: Partial<{ provider: AiProviderId; model: string; baseUrl: string; routeViaVm: boolean }>
  ): Promise<boolean> => {
    const next = {
      provider: aiProvider,
      model: ghCopilotModel,
      baseUrl: aiBaseUrl,
      routeViaVm: aiRouteViaVm,
      ...overrides,
    };
    const current = await loadAppSettings();
    return saveAppSettings({ ...current.settings, ai: next } as AppSettings);
  }, [aiProvider, ghCopilotModel, aiBaseUrl, aiRouteViaVm]);

  // ── Detect builtin Dynatrace settings via serverless function ──
  // Runs once on load if stale (>1 hour), or when forced via Refresh button
  const DETECT_CACHE_KEY = 'bizobs_detect_timestamp';
  const DETECT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
  const lastDetectRef = useRef<number>(0);
  const [isDetecting, setIsDetecting] = useState(false);

  const detectBuiltinSettings = useCallback(async (force = false) => {
    // Skip if already ran recently (within 1 hour) unless forced
    const now = Date.now();
    if (!force) {
      const lastRun = lastDetectRef.current || (() => {
        try { return parseInt(localStorage.getItem(DETECT_CACHE_KEY) || '0', 10); } catch { return 0; }
      })();
      if (now - lastRun < DETECT_INTERVAL_MS) return;
    }

    console.log('[BizObs] Running detect with host:', apiSettings.host, 'force:', force);
    setIsDetecting(true);
    try {
      const result = await callProxyWithRetry(
        { action: 'detect-builtin-settings', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol, body: { hostIp: apiSettings.host } }
      ) as { success: boolean; data?: Record<string, boolean> };
      console.log('[BizObs] Detect result:', result);
      if (result.success && result.data) {
        setBuiltinSettingsDetected(result.data);
        // If test-connection came back true from server, persist it
        if (result.data['test-connection']) {
          setConnectionTestedOk(true);
          localStorage.setItem('bizobs_connection_tested', 'true');
          saveTenantField({ connectionTested: true });
        }
        // Merge detected true values into persisted checklist
        setChecklist(prev => {
          const merged = { ...prev };
          for (const [k, v] of Object.entries(result.data!)) {
            if (v === true) merged[k] = true;
          }
          localStorage.setItem('bizobs_checklist', JSON.stringify(merged));
          saveChecklistToTenant(merged);
          return merged;
        });
        // Record successful detect timestamp
        lastDetectRef.current = now;
        localStorage.setItem(DETECT_CACHE_KEY, String(now));

        // Auto-deploy outbound allowlist if not yet configured (required for direct AI provider calls).
        // NOTE: the 'outbound-github-models' key is a backend detection id, kept for compatibility.
        // Saving a provider key also allowlists that provider's host via ai-provider-save-key.
        if (result.data['outbound-github-models'] === false) {
          console.log('[BizObs] Auto-deploying outbound allowlist for AI provider hosts...');
          try {
            await callProxyWithRetry(
              { action: 'deploy-builtin-settings', body: { configs: ['outbound-github-models'] } },
              3, 2000
            );
            console.log('[BizObs] Outbound allowlist auto-deployed successfully');
          } catch (e: any) {
            console.warn('[BizObs] Outbound allowlist auto-deploy failed:', e.message);
          }
        }
      }
    } catch (err) {
      console.warn('Failed to detect builtin settings:', err);
    }
    setIsDetecting(false);
  }, [apiSettings.host, apiSettings.port, apiSettings.protocol, saveChecklistToTenant]);

  // Auto-detect on mount (respects 1-hour cache)
  // Only runs after settings have been loaded from SDK/localStorage
  const detectRanRef = useRef(false);
  useEffect(() => {
    if (!detectRanRef.current && settingsLoadedRef.current && apiSettings.host && apiSettings.host !== 'localhost') {
      detectRanRef.current = true;
      console.log('[BizObs] Auto-detect triggered with host:', apiSettings.host);
      detectBuiltinSettings(false);
    }
  }, [detectBuiltinSettings, apiSettings.host]);

  // ── Deploy builtin Dynatrace settings from Get Started ──
  const deployBuiltinConfigs = async (configKeys: string[]) => {
    setIsDeployingConfigs(true);
    setDeployConfigsStatus('⏳ Deploying configurations...');
    try {
      const result = await callProxyWithRetry(
        { action: 'deploy-builtin-settings', body: { configs: configKeys } },
        5, 2000, setDeployConfigsStatus
      ) as { success: boolean; data?: Record<string, { success: boolean; error?: string }> };
      if (result.success && result.data) {
        const succeeded = Object.entries(result.data).filter(([, v]) => v.success).map(([k]) => k);
        const failed = Object.entries(result.data).filter(([, v]) => !v.success).map(([k, v]) => `${k}: ${v.error}`);
        if (failed.length === 0) {
          setDeployConfigsStatus(`✅ Deployed ${succeeded.length} config(s) successfully!`);
          showToast(`Deployed: ${succeeded.join(', ')}`, 'success');
        } else {
          setDeployConfigsStatus(`⚠️ ${succeeded.length} deployed, ${failed.length} failed: ${failed.join('; ')}`);
        }
      } else {
        setDeployConfigsStatus('❌ Deployment failed');
      }
    } catch (err: any) {
      setDeployConfigsStatus(`❌ ${err.message}`);
    }
    setIsDeployingConfigs(false);
    // Re-detect after deployment
    await detectBuiltinSettings(true);
  };

  // ── EdgeConnect Logic ──────────────────────────────────
  const loadEdgeConnects = async () => {
    setIsLoadingEC(true);
    setEcStatus('');
    try {
      const result = await edgeConnectClient.listEdgeConnects({ addFields: 'metadata' });
      setEdgeConnects(result.edgeConnects || []);
    } catch (err: any) {
      setEcStatus(`❌ Failed to load EdgeConnects: ${err.message}`);
      setEdgeConnects([]);
    }
    setIsLoadingEC(false);
  };

  // Load EdgeConnects on mount for checklist auto-detection
  useEffect(() => { loadEdgeConnects(); }, []);

  // Auto-populate API host from EdgeConnect host patterns on first install
  const ecAutoPopulatedRef = useRef(false);
  useEffect(() => {
    if (ecAutoPopulatedRef.current || edgeConnects.length === 0) return;
    const currentHost = apiSettings.host;
    // Extract the first valid host pattern from an online EdgeConnect (prefer online, fallback to any)
    const onlineEc = edgeConnects.find((ec: any) => (ec.metadata?.instances || []).length > 0) || edgeConnects[0];
    const patterns: string[] = onlineEc?.hostPatterns || [];
    const candidateHost = patterns.find((p: string) => p && p !== 'localhost' && p !== '127.0.0.1');
    if (!candidateHost) return;

    // Auto-sync if host is default OR stale (no longer present in current EC host patterns).
    const isDefaultHost = !currentHost || currentHost === 'localhost' || currentHost === 'bizobs-demonstrator';
    const isStaleHost = !!currentHost && !patterns.includes(currentHost);
    if (!isDefaultHost && !isStaleHost) return;

    ecAutoPopulatedRef.current = true;
    console.log('[BizObs] Auto-syncing API host from EdgeConnect hostPattern:', candidateHost, '(current:', currentHost || 'none', ')');
    const autoSettings: AppSettings = {
      apiHost: candidateHost,
      apiPort: '8080',
      apiProtocol: 'http',
      enableAutoGeneration: false,
    };
    setApiSettingsState({ host: candidateHost, port: '8080', protocol: 'http' });
    setSettingsForm(autoSettings);
    void saveAppSettings(autoSettings);
  }, [edgeConnects, apiSettings.host]);

  const deleteEdgeConnect = async (ecId: string, ecName: string) => {
    if (!confirm(`Delete EdgeConnect "${ecName}"? This cannot be undone.`)) return;
    setIsDeletingEC(ecId);
    setEcStatus(`🗑️ Deleting ${ecName}...`);
    try {
      await edgeConnectClient.deleteEdgeConnect({ edgeConnectId: ecId });
      setEcStatus(`✅ Deleted "${ecName}"`);
      await loadEdgeConnects();
    } catch (err: any) {
      setEcStatus(`❌ Failed to delete: ${err.message}`);
    }
    setIsDeletingEC(null);
  };

  // Create EdgeConnect via SDK — auto-generates OAuth credentials
  const createEdgeConnect = async () => {
    const name = ecName.trim();
    const host = (ecHostPattern.trim() || settingsForm.apiHost || '').trim();
    if (!name || !host) {
      setEcStatus('❌ Name and host pattern / IP are required');
      return;
    }
    setIsCreatingEC(true);
    setEcStatus('⏳ Creating EdgeConnect & generating credentials...');
    try {
      const result = await callProxyWithRetry({
          action: 'ec-create',
          apiHost: '', apiPort: '', apiProtocol: '',
          body: { ecName: name, hostPatterns: [host] },
      }) as any;
      if (!result.success) {
        const rawErr = result.debug?.rawError || '';
        if (rawErr.includes('already exist') || rawErr.includes('constraintViolations')) {
          setEcStatus('⚠️ An EdgeConnect with that name or host pattern already exists. Delete it first (below) or use different values.');
        } else {
          setEcStatus(`❌ ${result.error}`);
        }
        setIsCreatingEC(false);
        return;
      }
      // Auto-populate the credentials from SDK response
      setEcClientId(result.data?.oauthClientId || '');
      setEcClientSecret(result.data?.oauthClientSecret || '');
      setEcStatus('✅ EdgeConnect created! Credentials auto-filled below. Copy the YAML and deploy on your server.');
      await loadEdgeConnects();
      await checkEdgeConnectMatch();
    } catch (err: any) {
      setEcStatus(`❌ Failed: ${err.message}`);
    }
    setIsCreatingEC(false);
  };

  // Generate YAML from EdgeConnect credentials
  const generateEcYaml = () => {
    return `name: ${ecName.trim() || 'bizobs-demonstrator'}\napi_endpoint_host: ${TENANT_HOST}\noauth:\n  client_id: ${ecClientId.trim() || '<your-client-id>'}\n  client_secret: ${ecClientSecret.trim() || '<your-client-secret>'}\n  resource: urn:dtenvironment:${TENANT_ID}\n  endpoint: ${SSO_ENDPOINT}`;
  };

  // Derived: is any EdgeConnect online?
  const isAnyEcOnline = edgeConnects.some((ec: any) => (ec.metadata?.instances || []).length > 0);
  // Derived: is EdgeConnect route matched?
  const isEcRouteActive = ecMatchResult?.matched === true;

  const checkEdgeConnectMatch = async () => {
    const host = ecHostPattern || apiSettings.host || 'localhost';
    const port = apiSettings.port || '8080';
    const proto = apiSettings.protocol || 'http';
    setIsCheckingMatch(true);
    setEcMatchResult(null);
    try {
      const result = await edgeConnectClient.getMatchedEdgeConnects({ url: `${proto}://${host}:${port}/api/health` });
      if (result.matched) {
        setEcMatchResult({ matched: true, name: result.matched.name, pattern: result.matched.matchedPattern });
      } else {
        setEcMatchResult({ matched: false });
      }
    } catch (err: any) {
      setEcMatchResult({ matched: false });
    }
    setIsCheckingMatch(false);
  };

  // ── Settings Modal Logic ──────────────────────────────────
  const openSettingsModal = () => {
    setSettingsForm({
      apiHost: apiSettings.host,
      apiPort: apiSettings.port,
      apiProtocol: apiSettings.protocol,
      enableAutoGeneration: settingsForm.enableAutoGeneration,
    });
    setSettingsStatus('');
    setShowSettingsModal(true);

  };

  const saveSettingsFromModal = async () => {
    setIsSavingSettings(true);
    setSettingsStatus('💾 Saving to shared app config...');

    // Build the full settings payload including tenant-scoped extras
    const fullSettings: AppSettings = {
      ...settingsForm,
      checklistState: JSON.stringify(checklist),
      promptTemplates: JSON.stringify(savedTemplates),
      connectionTested: connectionTestedOk,
    };

    const docSaved = await saveAppSettings(fullSettings);

    if (docSaved) {
      setSettingsStatus('✅ Settings saved to shared app config (all users will see these)');
    } else {
      const saveError = getLastAppSettingsSaveError();
      setSettingsStatus(`❌ Shared document write failed — settings were not saved globally${saveError ? ` (${saveError})` : ''}`);
    }

    setApiSettingsState({ host: settingsForm.apiHost, port: settingsForm.apiPort, protocol: settingsForm.apiProtocol });

    // Auto-register host pattern with EdgeConnect so the serverless proxy can reach the server
    const newHost = settingsForm.apiHost.trim();
    if (newHost && newHost !== 'localhost' && newHost !== '127.0.0.1') {
      try {
        const ecResult = await callProxyWithRetry({
            action: 'ec-update-patterns',
            apiHost: '', apiPort: '', apiProtocol: '',
            body: { hostPatterns: [newHost] },
        }) as any;
        if (ecResult.success && ecResult.data?.added?.length > 0) {
          setSettingsStatus(prev => `${prev}\n🔌 Auto-registered ${newHost} as EdgeConnect host pattern`);
        }
        // Silently succeed if pattern already existed
      } catch {
        // Non-fatal — EdgeConnect may not exist yet or user hasn't set it up
        console.warn('[BizObs] Could not auto-register EdgeConnect host pattern (non-fatal)');
      }
    }

    setIsSavingSettings(false);
    // Re-detect builtin settings after saving config (force since settings changed)
    detectBuiltinSettings(true);
    setTimeout(() => setShowSettingsModal(false), 800);
  };

  // ── System Maintenance Logic ──────────────────────────────
  const loadSystemHealth = async () => {
    setIsLoadingHealth(true);
    setCleanupResult(null);
    try {
      const result = await callProxyWithRetry(
        { action: 'system-health', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
      ) as any;
      if (result.success) {
        setSystemHealth(result);
      } else {
        setSystemHealth({ error: result.error || 'Failed to load system health' });
      }
    } catch (err: any) {
      setSystemHealth({ error: err.message || 'Connection failed' });
    }
    setIsLoadingHealth(false);
  };

  const runSystemCleanup = async (itemIds?: string[]) => {
    setIsRunningCleanup(true);
    setCleanupResult(null);
    try {
      const result = await callProxyWithRetry(
        { action: 'system-cleanup', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol, body: itemIds ? { itemIds } : {} }
      ) as any;
      setCleanupResult(result);
      // Refresh health after cleanup
      loadSystemHealth();
    } catch (err: any) {
      setCleanupResult({ success: false, error: err.message || 'Cleanup failed' });
    }
    setIsRunningCleanup(false);
  };

  const loadGeneratedDashboards = async () => {
    setIsLoadingGeneratedDashboards(true);
    try {
      const result = await callProxyWithRetry(
        { action: 'list-generated-dashboards', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol },
        2,
        1000
      ) as any;
      if (result.success) {
        setGeneratedDashboards(Array.isArray(result.dashboards) ? result.dashboards : []);
      } else {
        setGeneratedDashboards([]);
        setDashboardMgmtStatus(`❌ ${result.error || 'Failed to list dashboards'}`);
      }
    } catch (err: any) {
      setGeneratedDashboards([]);
      setDashboardMgmtStatus(`❌ ${err.message || 'Failed to list dashboards'}`);
    }
    setIsLoadingGeneratedDashboards(false);
  };

  const deleteGeneratedDashboard = async (dashboardId: string) => {
    const id = String(dashboardId || '').trim();
    if (!id) return;
    const ok = window.confirm(`Delete dashboard ${id}? This cannot be undone.`);
    if (!ok) return;

    setDeletingDashboardId(id);
    setDashboardMgmtStatus('');
    try {
      const result = await callProxyWithRetry(
        {
          action: 'delete-generated-dashboard',
          apiHost: apiSettings.host,
          apiPort: apiSettings.port,
          apiProtocol: apiSettings.protocol,
          body: { dashboardId: id },
        },
        2,
        1000
      ) as any;

      if (result.success) {
        setDashboardMgmtStatus(`✅ Deleted ${id}`);
        setGeneratedDashboards(prev => prev.filter((d: any) => String(d?.id || '') !== id));
      } else {
        setDashboardMgmtStatus(`❌ ${result.error || `Failed to delete ${id}`}`);
      }
    } catch (err: any) {
      setDashboardMgmtStatus(`❌ ${err.message || `Failed to delete ${id}`}`);
    }
    setDeletingDashboardId(null);
  };

  const repairGeneratedDashboardSharing = async () => {
    setDashboardMgmtStatus('⏳ Repairing dashboard sharing...');
    try {
      const result = await callProxyWithRetry(
        { action: 'repair-dashboard-sharing', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol },
        2,
        1000
      ) as any;
      if (result.success) {
        setDashboardMgmtStatus(`✅ Sharing repaired for ${result.repairedCount || 0} dashboard(s)`);
      } else {
        setDashboardMgmtStatus(`❌ ${result.error || 'Failed to repair sharing'}`);
      }
    } catch (err: any) {
      setDashboardMgmtStatus(`❌ ${err.message || 'Failed to repair sharing'}`);
    }
    loadGeneratedDashboards();
  };

  const testConnectionFromModal = async () => {
    setIsTestingConnection(true);
    setSettingsStatus('🔄 Testing connection...');
    try {
      const result = await callProxyWithRetry(
        { action: 'test-connection', apiHost: settingsForm.apiHost, apiPort: settingsForm.apiPort, apiProtocol: settingsForm.apiProtocol },
        5, 2000, setSettingsStatus
      ) as any;
      // Capture caller IP reported by the BizObs server (the actual source IP that reached it)
      if (result.callerIp) setDetectedCallerIp(result.callerIp);
      if (result.success) {
        const ipNote = result.callerIp ? ` (source IP: ${result.callerIp})` : '';
        setSettingsStatus(`✅ ${result.message}${ipNote}`);
        // Persist successful test so checklist stays green
        setConnectionTestedOk(true);
        localStorage.setItem('bizobs_connection_tested', 'true');
        saveTenantField({ connectionTested: true });
      } else {
        setSettingsStatus(`❌ ${result.error || result.details}`);
        setConnectionTestedOk(false);
        localStorage.setItem('bizobs_connection_tested', 'false');
        saveTenantField({ connectionTested: false });
      }
    } catch (error: any) {
      setSettingsStatus(`❌ ${error.message}`);
    }
    setIsTestingConnection(false);
  };

  // ── Business Flow Management ──────────────────────────────────
  const [bizFlows, setBizFlows] = useState<{ objectId: string; name: string; isSmartscapeTopologyEnabled: boolean; stepsCount: number }[]>([]);
  const [isLoadingBizFlows, setIsLoadingBizFlows] = useState(false);
  const [isDeletingBizFlows, setIsDeletingBizFlows] = useState(false);
  const [bizFlowStatus, setBizFlowStatus] = useState('');

  const loadBizFlows = async () => {
    setIsLoadingBizFlows(true);
    setBizFlowStatus('⏳ Loading business flows...');
    try {
      const result = await callProxyWithRetry({ action: 'list-business-flows', apiHost: '', apiPort: '', apiProtocol: '' }) as any;
      if (result.success && result.data?.flows) {
        setBizFlows(result.data.flows);
        setBizFlowStatus(`Found ${result.data.flows.length} business flow(s)`);
      } else {
        setBizFlowStatus(`❌ ${result.error || 'Failed to list business flows'}`);
      }
    } catch (err: any) {
      setBizFlowStatus(`❌ ${err.message}`);
    }
    setIsLoadingBizFlows(false);
  };

  const deleteNonEntityBizFlows = async () => {
    const toDelete = bizFlows.filter(f => !f.isSmartscapeTopologyEnabled);
    if (toDelete.length === 0) {
      setBizFlowStatus('ℹ️ No non-entity business flows to delete');
      return;
    }
    setIsDeletingBizFlows(true);
    setBizFlowStatus(`🗑️ Deleting ${toDelete.length} non-entity business flow(s)...`);
    try {
      const result = await callProxyWithRetry({
        action: 'delete-business-flows', apiHost: '', apiPort: '', apiProtocol: '',
        body: { objectIds: toDelete.map(f => f.objectId) },
      }) as any;
      if (result.success) {
        setBizFlowStatus(`✅ Deleted ${result.data?.deletedCount || toDelete.length} business flow(s). Entity flows preserved.`);
        await loadBizFlows();
      } else {
        setBizFlowStatus(`❌ ${result.error}`);
      }
    } catch (err: any) {
      setBizFlowStatus(`❌ ${err.message}`);
    }
    setIsDeletingBizFlows(false);
  };

  const deleteAllBizFlows = async () => {
    if (bizFlows.length === 0) {
      setBizFlowStatus('ℹ️ No business flows to delete');
      return;
    }
    setIsDeletingBizFlows(true);
    setBizFlowStatus(`🗑️ Deleting all ${bizFlows.length} business flow(s)...`);
    try {
      const result = await callProxyWithRetry({
        action: 'delete-business-flows', apiHost: '', apiPort: '', apiProtocol: '',
        body: { objectIds: bizFlows.map(f => f.objectId) },
      }) as any;
      if (result.success) {
        setBizFlowStatus(`✅ Deleted ${result.data?.deletedCount || bizFlows.length} business flow(s).`);
        await loadBizFlows();
      } else {
        setBizFlowStatus(`❌ ${result.error}`);
      }
    } catch (err: any) {
      setBizFlowStatus(`❌ ${err.message}`);
    }
    setIsDeletingBizFlows(false);
  };

  // ── Services Modal Logic ──────────────────────────────────
  const openServicesModal = async () => {
    setShowServicesModal(true);
    setServicesStatus('');
    await Promise.all([loadRunningServices(), loadDormantServices()]);
  };

  const loadRunningServices = async () => {
    setIsLoadingServices(true);
    try {
      const result = await callProxyWithRetry(
        { action: 'get-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
      ) as any;
      if (result.success && result.data?.childServices) {
        setRunningServices(result.data.childServices);
        setServicesStatus(result.data.childServices.length > 0
          ? `${result.data.childServices.length} service(s) running`
          : 'No services running');
      } else {
        setRunningServices([]);
        setServicesStatus('Could not retrieve services');
      }
    } catch (error: any) {
      setRunningServices([]);
      setServicesStatus(`❌ ${error.message}`);
    }
    setIsLoadingServices(false);
  };

  const stopAllServices = async () => {
    setConfirmDialog({
      message: '⚠️ Stop ALL running services? This will kill every child service on the server.',
      onConfirm: () => doStopAllServices()
    });
  };

  const doStopAllServices = async () => {
    setIsStoppingServices(true);
    setServicesStatus('🛑 Stopping all services...');
    try {
      const result = await callProxyWithRetry(
        { action: 'stop-all-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol },
        5, 2000, setServicesStatus
      ) as any;
      setServicesStatus(result.success ? '✅ All services stopped!' : `❌ ${result.data?.error || 'Failed'}`);
      await Promise.all([loadRunningServices(), loadDormantServices()]);
    } catch (error: any) {
      setServicesStatus(`❌ ${error.message}`);
    }
    setIsStoppingServices(false);
  };

  const stopCompanyServices = async (company: string) => {
    setIsStoppingServices(true);
    setStoppingCompany(company);
    setServicesStatus(`🛑 Stopping services for ${company}...`);
    try {
      const result = await callProxyWithRetry(
        { action: 'stop-company-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol, body: { companyName: company } },
        5, 2000, setServicesStatus
      ) as any;
      setServicesStatus(result.success ? `✅ Stopped ${result.data?.stoppedServices?.length || 0} service(s) for ${company}` : `❌ ${result.data?.error || 'Failed'}`);
      await Promise.all([loadRunningServices(), loadDormantServices()]);
    } catch (error: any) {
      setServicesStatus(`❌ ${error.message}`);
    }
    setStoppingCompany(null);
    setIsStoppingServices(false);
  };

  // ── Dormant Services Logic ────────────────────────────────
  const loadDormantServices = async () => {
    setIsLoadingDormant(true);
    try {
      const result = await callProxyWithRetry(
        { action: 'get-dormant-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
      ) as any;
      if (result.success && result.data?.dormantServices) {
        setDormantServices(result.data.dormantServices);
      } else {
        setDormantServices([]);
      }
    } catch {
      setDormantServices([]);
    }
    setIsLoadingDormant(false);
  };

  const clearAllDormantServices = async () => {
    setIsClearingDormant(true);
    try {
      await callProxyWithRetry(
        { action: 'clear-dormant-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
      );
      setServicesStatus('🧹 Dormant services cleared');
      await loadDormantServices();
    } catch (error: any) {
      setServicesStatus(`❌ ${error.message}`);
    }
    setIsClearingDormant(false);
    setShowDormantWarning(null);
  };

  const clearCompanyDormantServices = async (company: string) => {
    setClearingDormantCompany(company);
    try {
      await callProxyWithRetry(
        { action: 'clear-company-dormant', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol, body: { companyName: company } }
      );
      setServicesStatus(`🧹 Dormant services cleared for ${company}`);
      await loadDormantServices();
    } catch (error: any) {
      setServicesStatus(`❌ ${error.message}`);
    }
    setClearingDormantCompany(null);
    setShowDormantWarning(null);
  };

  // ── Journeys Modal Logic ──────────────────────────────────
  const openJourneysModal = async () => {
    setShowJourneysModal(true);
    setJourneysStatus('');
    await Promise.all([loadJourneysData(), loadDormantServices()]);
  };

  const loadJourneysData = async () => {
    setIsLoadingJourneys(true);
    try {
      const [result, dormantResult] = await Promise.all([
        callProxyWithRetry(
          { action: 'get-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
        ) as Promise<any>,
        callProxyWithRetry(
          { action: 'get-dormant-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol }
        ) as Promise<any>,
      ]);
      if (result.success && result.data?.childServices) {
        const services: RunningService[] = [...(result.data.childServices || []), ...((dormantResult.success && dormantResult.data?.dormantServices) ? dormantResult.data.dormantServices : [])].filter((service, index, all) => {
          const journeyKey = service.journeyType || service.journeyDetail || 'Unknown';
          const key = [service.companyName, journeyKey, service.baseServiceName || service.service, service.stepName].join('::');
          return index === all.findIndex((candidate) => {
            const candidateJourneyKey = candidate.journeyType || candidate.journeyDetail || 'Unknown';
            const candidateKey = [candidate.companyName, candidateJourneyKey, candidate.baseServiceName || candidate.service, candidate.stepName].join('::');
            return candidateKey === key;
          });
        });
        setJourneysData(services);
        const count = services.length;
        const activeCount = (result.data.childServices || []).length;
        setJourneysStatus(count > 0 ? `${count} service(s) across active and dormant journeys (${activeCount} active)` : 'No journeys found');

        // Build unique company+journey pairs and check assets
        if (count > 0) {
          const pairs = new Map<string, { company: string; journeyType: string }>();
          services.forEach(s => {
            const company = s.companyName || 'Unknown';
            const jType = s.journeyType || s.journeyDetail || 'Unknown';
            pairs.set(`${company}::${jType}`, { company, journeyType: jType });
          });
          try {
            const assetResult = await callProxyWithRetry({
              action: 'check-journey-assets',
              apiHost: '', apiPort: '', apiProtocol: '',
              body: { journeys: Array.from(pairs.values()) },
            }) as any;
            if (assetResult.success && assetResult.data) {
              setJourneyAssets(assetResult.data);
            }
          } catch { /* non-fatal */ }
        }
      } else {
        setJourneysData([]);
        setJourneysStatus('Could not retrieve journey data');
      }
    } catch (error: any) {
      setJourneysData([]);
      setJourneysStatus(`❌ ${error.message}`);
    }
    setIsLoadingJourneys(false);
  };



  /** Build a URL to the Dynatrace Dashboards app filtered by company */
  const getDashboardSearchUrl = (company: string) => {
    const q = encodeURIComponent(company);
    return `${TENANT_URL}/ui/apps/dynatrace.dashboards/?query=${q}`;
  };

  // Download dashboard JSON to browser
  const downloadDashboardJson = () => {
    if (!generatedDashboardJson) return;
    const dashboardName = generatedDashboardJson.name || generatedDashboardJson.metadata?.company || 'dashboard';
    const filename = `${dashboardName.replace(/\s+/g, '_')}.json`;
    // Export inner content only — Dynatrace import expects the content object, not the full doc wrapper
    const exportData = generatedDashboardJson.content || generatedDashboardJson;
    const json = JSON.stringify(exportData, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };
  const chaosProxy = async (action: string, body?: any) => {
    return await callProxyWithRetry(
      { action, apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol, body }
    ) as any;
  };

  const openChaosModal = async () => {
    setShowChaosModal(true);
    setChaosStatus('');
    setChaosTab('active');
    setChaosFilterCompany('all');
    setChaosFilterCreator('all');
    await Promise.all([loadChaosData(), loadRunningServices()]);
  };

  const loadChaosData = async () => {
    setIsLoadingChaos(true);
    try {
      const [activeRes, recipesRes, targetedRes] = await Promise.all([
        chaosProxy('chaos-get-active'),
        chaosProxy('chaos-get-recipes'),
        chaosProxy('chaos-get-targeted'),
      ]);
      if (activeRes.success) {
        const rawFaults = activeRes.data?.activeFaults || activeRes.data || [];
        const normalized = Array.isArray(rawFaults)
          ? rawFaults.map((f: any) => ({ ...f, id: f?.id || f?.chaosId || '' }))
          : [];
        setActiveFaults(normalized);
      }
      if (recipesRes.success) setChaosRecipes(activeRes.data?.recipes || recipesRes.data?.recipes || recipesRes.data || []);
      if (targetedRes.success) setTargetedServices(targetedRes.data?.serviceOverrides || targetedRes.data || {});
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
    setIsLoadingChaos(false);
  };

  const chaosCompanyOptions = Array.from(new Set(
    runningServices
      .map((service) => String(service.companyName || '').trim())
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  const chaosCreatorOptions = Array.from(new Set(
    runningServices
      .map((service) => getServiceCreatorValue(service))
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  const chaosTargetServices = runningServices.filter((service) => {
    const company = String(service.companyName || '').trim();
    const creator = getServiceCreatorValue(service);
    if (chaosFilterCompany !== 'all' && company !== chaosFilterCompany) return false;
    if (chaosFilterCreator !== 'all' && creator !== chaosFilterCreator) return false;
    return true;
  });

  const injectChaos = async () => {
    if (!injectForm.target) { setChaosStatus('⚠️ Select a target service'); return; }
    setIsInjectingChaos(true);
    setChaosStatus(`💉 Injecting chaos on ${injectForm.target}...`);
    try {
      const payload = { type: injectForm.type, target: injectForm.target, intensity: injectForm.intensity, duration: injectForm.duration };
      const result = await chaosProxy('chaos-inject', payload);
      if (result.success) {
        setChaosStatus(`✅ Chaos injected: ${injectForm.type} on ${injectForm.target} (intensity ${injectForm.intensity}, ${injectForm.duration}s)`);
        showToast(`💉 Nemesis injected on ${injectForm.target}`, 'warning', 5000);
        await loadChaosData();
      } else {
        setChaosStatus(`❌ ${result.data?.error || result.error || 'Injection failed'}`);
      }
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
    setIsInjectingChaos(false);
  };

  const revertFault = async (faultId?: string) => {
    const resolvedFaultId = String(faultId || '').trim();
    if (!resolvedFaultId) {
      setChaosStatus('❌ Revert failed: missing fault ID. Refresh active faults and try again.');
      showToast('❌ Revert failed: missing fault ID', 'error');
      return;
    }
    setIsRevertingChaos(true);
    setChaosStatus('🔄 Reverting fault...');
    try {
      const result = await chaosProxy('chaos-revert', { faultId: resolvedFaultId });
      if (result.success) {
        setChaosStatus('✅ Fault reverted');
        showToast('✅ Chaos fault reverted', 'success');
        await loadChaosData();
      } else {
        setChaosStatus(`❌ ${result.data?.error || 'Revert failed'}`);
      }
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
    setIsRevertingChaos(false);
  };

  const revertAllFaults = async () => {
    setIsRevertingChaos(true);
    setChaosStatus('🔄 Reverting all faults...');
    try {
      const result = await chaosProxy('chaos-revert-all');
      if (result.success) {
        setChaosStatus('✅ All faults reverted');
        showToast('✅ All chaos faults reverted', 'success');
        await loadChaosData();
      } else {
        setChaosStatus(`❌ ${result.data?.error || 'Revert failed'}`);
      }
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
    setIsRevertingChaos(false);
  };

  const removeTargetedService = async (serviceName: string) => {
    try {
      const result = await chaosProxy('chaos-remove-target', { serviceName });
      if (result.success) {
        setChaosStatus(`✅ Removed override for ${serviceName}`);
        showToast(`✅ ${serviceName} error override removed`, 'success');
        await loadChaosData();
      } else {
        setChaosStatus(`❌ ${result.data?.error || 'Remove failed'}`);
      }
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
  };

  const compareSavedDashboardVersions = (item: any) => {
    const sameSeries = savedDashboards
      .filter((candidate: any) => candidate.company === item.company && candidate.journeyType === item.journeyType && candidate.id !== item.id)
      .sort((a: any, b: any) => String(b.savedAt || '').localeCompare(String(a.savedAt || '')));

    const baseline = (selectedSavedDashboardId && selectedSavedDashboardId !== item.id
      ? savedDashboards.find((candidate: any) => candidate.id === selectedSavedDashboardId)
      : null) || sameSeries[0];

    if (!baseline) {
      showToast('No comparable version found for this company/journey yet.', 'info', 4000);
      return;
    }

    const comparisonLines = [
      `Comparing ${item.dashboardName || item.id} to ${baseline.dashboardName || baseline.id}`,
      '',
      `Company: ${item.company || 'unknown'} vs ${baseline.company || 'unknown'}`,
      `Journey: ${item.journeyType || 'unknown'} vs ${baseline.journeyType || 'unknown'}`,
      `Version: v${item.artifactVersion || '?'} vs v${baseline.artifactVersion || '?'}`,
      `Tiles: ${item.tileCount || '?'} vs ${baseline.tileCount || '?'}`,
      `Generation: ${item.generationMethod || 'unknown'} vs ${baseline.generationMethod || 'unknown'}`,
      `Source: ${item.source || 'unknown'} vs ${baseline.source || 'unknown'}`,
      `Saved: ${item.savedAt ? new Date(item.savedAt).toLocaleString() : '—'} vs ${baseline.savedAt ? new Date(baseline.savedAt).toLocaleString() : '—'}`,
      item.artifactPath || baseline.artifactPath ? `Artifact path: ${item.artifactPath || '—'} vs ${baseline.artifactPath || '—'}` : '',
    ].filter(Boolean);

    window.alert(comparisonLines.join('\n'));
  };

  const savedDashboardCompanies = Array.from(new Set(savedDashboards.map((item: any) => item.company).filter(Boolean))).sort();
  const savedDashboardJourneys = Array.from(new Set(savedDashboards.map((item: any) => item.journeyType).filter(Boolean))).sort();
  const savedDashboardSources = Array.from(new Set(savedDashboards.map((item: any) => item.source).filter(Boolean))).sort();
  const filteredSavedDashboards = savedDashboards.filter((item: any) => {
    if (savedDashboardFilterCompany !== 'all' && item.company !== savedDashboardFilterCompany) return false;
    if (savedDashboardFilterJourney !== 'all' && item.journeyType !== savedDashboardFilterJourney) return false;
    if (savedDashboardFilterSource !== 'all' && item.source !== savedDashboardFilterSource) return false;
    return true;
  });

  // ============================================================================
  // DASHBOARD GENERATION & DEPLOYMENT (Using Dynatrace SDK)
  // ============================================================================

  const openGenerateDashboardModal = async () => {
    setShowGenerateDashboardModal(true);
    setDashboardCompanyName('');
    setDashboardJourneyType('');
    setDashboardGenerationStatus('');
    setBizEventsAvailable(null);
    setBizEventsCount(0);
    setIsBizEventsChecking(false);
    setPdfStatus('');
    setVisualsSubTab(DASHBOARD_DTCTL_UI_ENABLED ? 'dashboard' : 'pdf');
    setShowDashboardPreflightDetails(false);
    setSavedDashboardFilterCompany('all');
    setSavedDashboardFilterJourney('all');
    setSavedDashboardFilterSource('all');
    setDashboardDeployPreflight(
      DASHBOARD_DTCTL_UI_ENABLED
        ? { status: 'checking', message: 'Checking dtctl and Dynatrace credentials...' }
        : { status: 'idle', message: 'Dashboard generation is temporarily hidden in the UI.' }
    );
    setIsLoadingDashboardData(true);
    if (DASHBOARD_DTCTL_UI_ENABLED) {
      void loadSavedDashboards();
      void ensureDashboardDeployReady().catch(() => {});
    }

    try {
      const result = await Promise.race([
        callProxyWithRetry(
          { action: 'get-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol },
          2,
          1000
        ) as Promise<any>,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Timed out loading services for dashboard generation')), 15000)),
      ]) as any;
      if (result.success && result.data?.childServices) {
        const services = result.data.childServices as RunningService[];
        const companies = Array.from(new Set(services.map(s => s.companyName).filter(Boolean))) as string[];
        const journeys = Array.from(new Set(services.map(s => s.journeyType).filter(Boolean))) as string[];
        setAvailableCompanies(companies.sort());
        setAvailableJourneys(journeys.sort());
        setRunningServices(services);
      } else {
        setAvailableCompanies([]);
        setAvailableJourneys([]);
      }
    } catch (error: any) {
      console.warn('[Generate Visuals] Failed to load services:', error.message);
      // Fallback to already loaded in-memory journey inventory so UI does not get stuck.
      const fallbackCompanies = Array.from(new Set(
        journeyInventory
          .map(s => s.companyName)
          .filter((v): v is string => Boolean(v && String(v).trim()))
      )).sort();
      const fallbackJourneys = Array.from(new Set(
        journeyInventory
          .map(s => s.journeyType)
          .filter((v): v is string => Boolean(v && String(v).trim()))
      )).sort();
      setAvailableCompanies(fallbackCompanies);
      setAvailableJourneys(fallbackJourneys);
      if (fallbackCompanies.length === 0) {
        setDashboardGenerationStatus('⚠️ Could not load services from server. Open Journeys first or retry in a few seconds.');
      }
    } finally {
      setIsLoadingDashboardData(false);
    }
  };

  // Load saved dashboards from EC2 host
  const loadSavedDashboards = async () => {
    setIsLoadingSavedDashboards(true);
    try {
      const result = await callProxyWithRetry({
        action: 'list-saved-dashboards',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
      }) as any;
      if (result.success && result.dashboards) {
        setSavedDashboards(result.dashboards);
      }
    } catch (err: any) {
      console.warn('[Saved Dashboards] Failed to load:', err.message);
    }
    setIsLoadingSavedDashboards(false);
  };

  const ensureDashboardDeployReady = async () => {
    setDashboardDeployPreflight({ status: 'checking', message: 'Checking dtctl and Dynatrace credentials...' });
    const result = await callProxyWithRetry({
      action: 'preflight-dtctl',
      apiHost: apiSettings.host,
      apiPort: apiSettings.port,
      apiProtocol: apiSettings.protocol,
    }, 2, 1500) as any;

    const data = result?.data || {};
    if (!result?.success || !data?.ready) {
      const reason = data?.error || result?.error || 'dtctl preflight failed';
      const hint = data?.dynatrace?.environmentConfigured === false || data?.dynatrace?.tokenConfigured === false
        ? 'Check DT_ENVIRONMENT / DT_PLATFORM_TOKEN on the backend host.'
        : 'Check backend connectivity and dtctl installation.';
      setDashboardDeployPreflight({ status: 'error', message: `${reason} ${hint}`.trim(), details: data });
      throw new Error(`${reason} ${hint}`.trim());
    }

    setDashboardDeployPreflight({
      status: 'ready',
      message: `Ready: ${data?.dtctl?.version || 'dtctl installed'} · ${data?.dynatrace?.environmentUrl || 'environment configured'}`,
      details: data,
    });
    return data;
  };

  const loadSavedDashboardVersion = async (item: any) => {
    try {
      const result = await callProxyWithRetry({
        action: 'load-saved-dashboard',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: { dashboardId: item.id },
      }) as any;
      if (!result?.success) {
        throw new Error(result?.error || 'Failed to load saved dashboard');
      }

      const payload = result.dashboard ? result : result.data || result;
      if (!payload?.dashboard) {
        throw new Error('Saved dashboard has no dashboard payload');
      }

      setGeneratedDashboardJson(payload.dashboard);
      setSelectedSavedDashboardId(item.id);
      setDashboardCompanyName(payload.company || item.company || '');
      setDashboardJourneyType(payload.journeyType || item.journeyType || '');
      setVisualsSubTab('dashboard');
      setDashboardGenerationStatus(`📦 Loaded ${item.dashboardName || item.id}${item.artifactVersion ? ` (v${item.artifactVersion})` : ''} from ${item.source || 'saved history'}.`);
      showToast('Loaded saved dashboard version.', 'success', 4000);
    } catch (err: any) {
      showToast(`Failed to load saved dashboard: ${err.message}`, 'error', 5000);
    }
  };

  const redeploySavedDashboardVersion = async (item: any) => {
    setDashboardGenerationStatus(`⏳ Redeploying ${item.dashboardName || item.id}${item.artifactVersion ? ` v${item.artifactVersion}` : ''}...`);
    setVisualsSubTab('dashboard');
    try {
      await ensureDashboardDeployReady();
      const loaded = await callProxyWithRetry({
        action: 'load-saved-dashboard',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: { dashboardId: item.id },
      }) as any;
      if (!loaded?.success) {
        throw new Error(loaded?.error || 'Failed to load dashboard artifact');
      }

      const payload = loaded.dashboard ? loaded : loaded.data || loaded;
      const deployRes = await callProxyWithRetry({
        action: 'deploy-dashboard',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: {
          dashboard: payload.dashboard,
          company: payload.company || item.company,
          journeyType: payload.journeyType || item.journeyType,
        },
      }, 3, 2000, setDashboardGenerationStatus) as any;

      if (!deployRes?.success || !deployRes?.data?.data?.dashboardUrl && !deployRes?.data?.dashboardUrl) {
        const errMsg = deployRes?.data?.error || deployRes?.error || 'Redeploy failed';
        throw new Error(errMsg);
      }

      const deployData = deployRes.data?.data || deployRes.data;
      setDashboardUrl(`${TENANT_URL}${deployData.dashboardUrl}`);
      setGeneratedDashboardJson(payload.dashboard);
      setSelectedSavedDashboardId(item.id);
      setDashboardGenerationStatus(`✅ Redeployed ${item.dashboardName || item.id}${item.artifactVersion ? ` v${item.artifactVersion}` : ''}.`);
      showToast('Saved dashboard version redeployed.', 'success', 6000);
      await loadSavedDashboards();
    } catch (err: any) {
      setDashboardGenerationStatus(`❌ ${err.message}`);
      showToast(`Redeploy failed: ${err.message}`, 'error', 6000);
    }
  };

  // Deploy a saved dashboard to Dynatrace (re-use MCP deploy)
  const deploySavedDashboard = async (item: any) => {
    setDashboardGenerationStatus(`⏳ Deploying saved dashboard: ${item.company} / ${item.journeyType}...`);
    setVisualsSubTab('pdf');
    try {
      await ensureDashboardDeployReady();
      const result = await callProxyWithRetry({
        action: 'generate-deploy-dashboard',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: { company: item.company, journeyType: item.journeyType, useAI: true, model: 'gpt-4.1' },
      }, 5, 3000, setDashboardGenerationStatus) as any;
      if (result.success && result.data?.dashboardUrl) {
        const { dashboardUrl, tileCount, alreadyExisted } = result.data;
        const verb = alreadyExisted ? 'updated' : 'deployed';
        setDashboardGenerationStatus(`✅ ${tileCount} tiles ${verb} for ${item.company}`);
        setDashboardUrl(`${TENANT_URL}${dashboardUrl}`);
        showToast(`📊 Dashboard ${verb}! Click the link to open.`, 'success', 8000);
      } else {
        setDashboardGenerationStatus(`❌ ${result.error || 'Deploy failed'}`);
      }
    } catch (err: any) {
      setDashboardGenerationStatus(`❌ ${err.message}`);
    }
  };

  // Delete a saved dashboard from EC2 host
  const deleteSavedDashboard = async (id: string) => {
    try {
      await callProxyWithRetry({
        action: 'delete-saved-dashboard',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: { dashboardId: id },
      }) as any;
      setSavedDashboards(prev => prev.filter(d => d.id !== id));
      showToast('🗑️ Dashboard removed.', 'info', 3000);
    } catch (err: any) {
      console.warn('[Saved Dashboards] Delete failed:', err.message);
    }
  };

  // Retry helper for EdgeConnect calls — retries with exponential backoff to survive reconnection gaps and timeouts.
  const callProxyWithRetry = async (payload: any, attempts = 5, initialDelayMs = 2000, statusSetter?: (msg: string) => void) => {
    const isRetryableMessage = (msg: string) => /connection error|edgeconnect|timed out|signal|rate limit|too many requests|429|try again in a few minutes|function\s+proxy-api\s+has\s+failed|has\s+failed/i.test(msg || '');
    const enrichedPayload = { ...payload, ...getAuditUser() };

    let lastErr: any;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await functions.call('proxy-api', { data: enrichedPayload });
        const data = await res.json();

        // Some proxy paths return HTTP 200 with success:false. Retry if it's a transient/rate-limit failure.
        if (data && data.success === false) {
          const errMsg = String(data.error || data.data?.error || data.message || 'Unknown proxy error');
          const isRetryable = isRetryableMessage(errMsg);
          if (i < attempts && isRetryable) {
            const baseDelay = initialDelayMs * Math.pow(1.8, i - 1);
            const delay = /rate limit|too many requests|429/i.test(errMsg)
              ? Math.max(10000, baseDelay)
              : baseDelay;
            if (statusSetter) statusSetter(`⏳ ${/rate limit|too many requests|429/i.test(errMsg) ? 'Rate limited' : 'Transient issue'} — retry ${i}/${attempts - 1} in ${Math.round(delay / 1000)}s...`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
        }

        return data;
      } catch (err: any) {
        lastErr = err;
        const errMsg = String(err?.message || err || 'Unknown error');
        const isRetryable = isRetryableMessage(errMsg);
        console.warn(`[Proxy retry] Attempt ${i}/${attempts} failed:`, err.message);
        if (i < attempts && isRetryable) {
          const baseDelay = initialDelayMs * Math.pow(1.5, i - 1); // 2s, 3s, 4.5s, 6.75s
          const delay = /rate limit|too many requests|429/i.test(errMsg)
            ? Math.max(10000, baseDelay)
            : baseDelay;
          if (statusSetter) statusSetter(`⏳ ${/rate limit|too many requests|429/i.test(errMsg) ? 'Rate limited' : 'Retrying'} — attempt ${i}/${attempts - 1} in ${Math.round(delay / 1000)}s...`);
          await new Promise(r => setTimeout(r, delay));
        } else if (!isRetryable) {
          throw err; // Non-retryable errors should not retry
        }
      }
    }
    throw lastErr;
  };

  const callGithubCopilotGenerateWithBackoff = async (
    prompt: string,
    model: string,
    statusSetter?: (msg: string) => void,
    phaseLabel = 'Generation'
  ) => {
    const isTransientProxyFailure = (msg: string) => /function\s+proxy-api\s+has\s+failed|timed out|timeout|signal|rate limit|too many requests|429/i.test(msg || '');
    const maxRateLimitCycles = 4;
    for (let cycle = 1; cycle <= maxRateLimitCycles; cycle++) {
      let res: any;
      try {
        res = await callProxyWithRetry({
          action: 'github-copilot-generate',
          apiHost: apiSettings.host,
          apiPort: apiSettings.port,
          apiProtocol: apiSettings.protocol,
          body: { prompt, model },
        }, 2, 2000, statusSetter);
      } catch (err: any) {
        const errMsg = String(err?.message || 'Unknown error');
        if (isTransientProxyFailure(errMsg) && cycle < maxRateLimitCycles) {
          const waitMs = Math.min(20000, 4000 * cycle);
          if (statusSetter) {
            statusSetter(`⏳ ${phaseLabel}: transient proxy issue, retrying in ${Math.round(waitMs / 1000)}s...`);
          }
          await new Promise(r => setTimeout(r, waitMs));
          continue;
        }
        return { success: false, error: errMsg };
      }

      if (res?.success) return res;

      const errMsg = String(res?.error || res?.message || 'Unknown error');
      const code = String(res?.code || '').toUpperCase();
      const retryable =
        /rate limit|too many requests|429|try again in a few minutes|timed out|timeout|signal|abort/i.test(errMsg) ||
        code === 'RATE_LIMITED' ||
        code === 'GEN_TIMEOUT';
      if (!retryable || cycle === maxRateLimitCycles) return res;

      const waitMs = Math.min(30000, 5000 * cycle);
      if (statusSetter) {
        statusSetter(`⏳ ${phaseLabel}: rate limited, waiting ${Math.round(waitMs / 1000)}s before retry ${cycle + 1}/${maxRateLimitCycles}...`);
      }
      await new Promise(r => setTimeout(r, waitMs));
    }
    return { success: false, error: `${phaseLabel}: rate limit retries exhausted` };
  };

  const callDynatraceAssistGenerateWithBackoff = async (
    prompt: string,
    statusSetter?: (msg: string) => void,
    phaseLabel = 'C-Suite generation'
  ) => {
    return callGithubCopilotGenerateWithBackoff(
      prompt,
      'gpt-4.1',
      statusSetter,
      phaseLabel
    );
  };

  const commitJourneyToRepo = async (journeyPayload: any, source: 'manual' | 'ai-agent' | 'pasted-ai' = 'manual') => {
    try {
      const result = await callProxyWithRetry({
        action: 'github-journey-commit',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: {
          repoOwner: 'LawrenceBarratt90',
          repoName: 'Business-Observability-Demonstrator---Journeys',
          branch: 'main',
          source,
          appVersion: APP_VERSION,
          journey: journeyPayload,
        },
      }, 2, 1200) as any;

      if (!result?.success) {
        console.warn('[journey-commit] commit failed:', result?.error || 'unknown error');
      }
    } catch (err: any) {
      console.warn('[journey-commit] commit request failed:', err?.message || err);
    }
  };

  // Shared helper — generates dashboard and deploys directly to Dynatrace via dtctl path.
  // Called both manually (Generate Dashboard button) and automatically after a new journey is created.
  // When customPrompt is provided, Copilot shapes the dashboard according to the requested focus.
  const autoDownloadDashboard = async (company: string, journeyType: string, customPrompt?: string) => {
    const label = customPrompt ? '⏳ AI is crafting your custom dashboard...' : '⏳ Generating dashboard with AI, deploying via dtctl...';
    setDashboardStatus(label);
    await ensureDashboardDeployReady();
    const bodyPayload: any = { company, journeyType, useAI: true };
    if (customPrompt) bodyPayload.customPrompt = customPrompt;
    bodyPayload.model = 'gpt-4.1';
    const result = await callProxyWithRetry({
        action: 'generate-deploy-dashboard',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: bodyPayload
    }, 3, 5000, setDashboardStatus) as any;

    if (result.success && result.data?.dashboardUrl) {
      const { dashboardUrl, tileCount, alreadyExisted } = result.data;
      setGeneratedDashboardJson(null);
      const verb = alreadyExisted ? 'updated' : 'deployed';
      setDashboardStatus(`✅ ${tileCount} tiles ${verb} via dtctl`);
      setDashboardUrl(`${TENANT_URL}${dashboardUrl}`);
      showToast(`📊 Dashboard ${verb} via dtctl! Click the link to open it in Dynatrace.`, 'success', 8000);
    } else {
      throw new Error(result.error || result.data?.error || 'Dashboard generation failed — check dtctl credentials in Settings');
    }
  };
  // Auto-deploy a tailored Business Flow to Dynatrace whenever a journey is created.
  const autoDeployBusinessFlow = async (company: string, journeyType: string, steps: Array<{stepName?: string; name?: string; hasError?: boolean}>) => {
    try {
      const result = await callProxyWithRetry({
          action: 'deploy-business-flow',
          apiHost: apiSettings.host,
          apiPort: apiSettings.port,
          apiProtocol: apiSettings.protocol,
          body: { companyName: company, journeyType, steps }
      }) as any;
      if (result.success && result.data?.ok) {
        showToast(`🔄 Business Flow "${company} - ${journeyType}" deployed to Dynatrace!`, 'success', 6000);
      } else {
        const err = result.data?.error || result.error || 'Unknown error';
        console.warn('[Business Flow] Auto-deploy failed:', err);
        showToast(`⚠️ Business Flow deploy failed: ${err}`, 'warning', 5000);
      }
    } catch (err: any) {
      console.warn('[Business Flow] Auto-deploy error:', err.message);
    }
  };

  const normalizeServiceName = (rawService: any, rawStep: any) => {
    const candidate = String(rawService || rawStep || 'step-service');
    return candidate
      .trim()
      .replace(/[^a-zA-Z0-9\-_\s]/g, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[\s_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase();
  };

  // BizEvents availability check when company + journey are both selected
  useEffect(() => {
    if (!dashboardCompanyName || !dashboardJourneyType) {
      setBizEventsAvailable(null);
      setBizEventsCount(0);
      return;
    }
    let cancelled = false;
    setIsBizEventsChecking(true);
    setBizEventsAvailable(null);
    const safeCompany = dashboardCompanyName.replace(/["\\]/g, '');
    const safeJourney = dashboardJourneyType.replace(/["\\]/g, '');
    callProxyWithRetry({
      action: 'execute-dql',
      apiHost: apiSettings.host,
      apiPort: apiSettings.port,
      apiProtocol: apiSettings.protocol,
      body: {
        query: `fetch bizevents | filter event.kind == "BIZ_EVENT" | filter json.companyName == "${safeCompany}" | filter json.journeyType == "${safeJourney}" | summarize count()`,
        timeoutMs: 15000,
        maxRecords: 1,
      },
    }, 1, 0).then((result: any) => {
      if (cancelled) return;
      const count: number = result?.records?.[0]?.count ?? result?.records?.[0]?.['count()'] ?? 0;
      setBizEventsAvailable(result.success && count > 0);
      setBizEventsCount(count);
    }).catch(() => {
      if (!cancelled) setBizEventsAvailable(false);
    }).finally(() => {
      if (!cancelled) setIsBizEventsChecking(false);
    });
    return () => { cancelled = true; };
  }, [dashboardCompanyName, dashboardJourneyType]);

  const generateAndDeployDashboard = async () => {
    if (!dashboardCompanyName || !dashboardJourneyType) {
      setDashboardGenerationStatus('⚠️ Please select both company and journey type');
      return;
    }

    setIsGeneratingDashboard(true);
    const hasPrompt = !!mcpDashboardPrompt.trim();
    setDashboardGenerationStatus(hasPrompt
      ? '🧠 AI is crafting your custom dashboard — this may take a minute...'
      : '⏳ Generating dashboard with AI, deploying via dtctl...');

    try {
      console.log('[Dashboard] 📊 MCP generate+deploy via proxy:', {
        company: dashboardCompanyName,
        journeyType: dashboardJourneyType,
        customPrompt: hasPrompt ? mcpDashboardPrompt.trim() : undefined,
      });

      // Use the MCP-powered seamless generate+deploy flow
      await autoDownloadDashboard(
        dashboardCompanyName,
        dashboardJourneyType,
        hasPrompt ? mcpDashboardPrompt.trim() : undefined
      );
      setDashboardGenerationStatus(`✅ Dashboard deployed to Dynatrace!`);
      setTimeout(() => setShowGenerateDashboardModal(false), 5000);
    } catch (error: any) {
      console.error('[Dashboard] ❌ Error:', error);
      setDashboardGenerationStatus(`❌ ${error.message}`);
      showToast(`❌ ${error.message}`, 'error', 5000);
    } finally {
      setIsGeneratingDashboard(false);
    }
  };

  const runSmartChaos = async () => {
    if (!smartChaosGoal.trim()) { setChaosStatus('⚠️ Enter a chaos goal'); return; }
    setIsSmartChaosRunning(true);
    setChaosStatus('🤖 Nemesis AI analysing and injecting chaos...');
    try {
      const result = await chaosProxy('chaos-smart', { goal: smartChaosGoal });
      if (result.success && result.data) {
        const d = result.data;
        setChaosStatus(`✅ Nemesis AI: ${d.type || 'injected'} on ${d.target || 'auto'} (intensity ${d.intensity || '?'})`);
        showToast(`👹 Nemesis unleashed: ${d.type || 'auto'}`, 'warning', 5000);
        setSmartChaosGoal('');
        await loadChaosData();
      } else {
        setChaosStatus(`❌ ${result.data?.error || result.error || 'Smart chaos failed'}`);
      }
    } catch (error: any) {
      setChaosStatus(`❌ ${error.message}`);
    }
    setIsSmartChaosRunning(false);
  };


  // Generate prompts when moving to step 2
  useEffect(() => {
    if (activeTab === 'step2' && companyName && domain) {
      const csuite = generateCsuitePrompt({ companyName, domain, requirements });
      const journey = generateJourneyPrompt({ companyName, domain, requirements });
      setPrompt1(csuite);
      setPrompt2(journey);
    }
  }, [activeTab, companyName, domain, requirements]);

  const copyToClipboard = (text: string, promptName: string) => {
    navigator.clipboard.writeText(text);
    showToast(`${promptName} copied to clipboard!`, 'success', 2500);
  };

  // Normalize journey payload to prevent duplicate steps at both journey.steps and top-level steps
  const normalizeJourneyPayload = (parsedResponse: any) => {
    if (!parsedResponse) return parsedResponse;
    
    const hasJourneySteps = Array.isArray(parsedResponse.journey?.steps) && parsedResponse.journey.steps.length > 0;
    const hasTopLevelSteps = Array.isArray(parsedResponse.steps) && parsedResponse.steps.length > 0;
    
    // If both exist, ensure we only send one set of steps via journey.steps
    if (hasJourneySteps && hasTopLevelSteps) {
      console.log('[normalization] Found steps in both journey.steps and top-level steps. Keeping journey.steps only.');
      const normalized = {
        ...parsedResponse,
        steps: undefined // Remove top-level steps to prevent duplication
      };
      delete normalized.steps; // Explicitly delete
      return normalized;
    }
    
    return parsedResponse;
  };

  const getJourneyIdentityFromPayload = (payload: any) => {
    const journey = payload?.journey || payload || {};
    const steps = Array.isArray(journey?.steps) ? journey.steps : (Array.isArray(payload?.steps) ? payload.steps : []);
    const resolvedCompanyName = String(journey.companyName || payload?.companyName || steps?.[0]?.companyName || companyName || '').trim();
    const resolvedJourneyType = String(journey.journeyType || journey.journeyDetail || payload?.journeyType || payload?.journeyDetail || domain || '').trim();
    return {
      companyName: resolvedCompanyName,
      journeyType: resolvedJourneyType,
      key: toJourneyKey(resolvedCompanyName, resolvedJourneyType),
    };
  };

  const ensureJourneyCanStart = async (payload: any, statusSetter?: (msg: string) => void) => {
    const identity = getJourneyIdentityFromPayload(payload);
    if (!identity.companyName || !identity.journeyType) {
      return true;
    }

    const servicesResult = await callProxyWithRetry(
      { action: 'get-services', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol },
      3,
      1000,
      statusSetter
    ) as any;

    const activeServices = Array.isArray(servicesResult?.data?.childServices) ? servicesResult.data.childServices : [];
    const conflictingServices = activeServices.filter((service: any) => {
      const serviceKey = toJourneyKey(String(service.companyName || ''), String(service.journeyType || service.journeyDetail || ''));
      return serviceKey === identity.key;
    });

    if (conflictingServices.length === 0) {
      return true;
    }

    const shouldStopExisting = window.confirm(
      `${identity.companyName} / ${identity.journeyType} already has ${conflictingServices.length} running service(s).\n\nStop the existing journey and replace it with the new one?`
    );
    if (!shouldStopExisting) {
      showToast(`Cancelled. Existing ${identity.companyName} / ${identity.journeyType} journey is still running.`, 'warning', 5000);
      return false;
    }

    if (statusSetter) {
      statusSetter(`🛑 Stopping existing ${identity.companyName} / ${identity.journeyType} journey...`);
    }

    const stopResult = await callProxyWithRetry(
      {
        action: 'stop-company-services',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: {
          companyName: identity.companyName,
          journeyType: identity.journeyType,
          allowRestart: true,
        },
      },
      5,
      1000,
      statusSetter
    ) as any;

    if (!stopResult?.success) {
      throw new Error(stopResult?.error || stopResult?.data?.error || 'Failed to stop existing journey');
    }

    await Promise.all([loadRunningServices(), loadDormantServices()]);
    await new Promise((resolve) => setTimeout(resolve, 750));
    return true;
  };

    const parseJourneyJsonWithRepair = (raw: string): { parsed: any; cleanJson: string } => {
      let cleanJson = (raw || '').trim();
      if (cleanJson.startsWith('```')) {
        cleanJson = cleanJson.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
      }

      const firstBrace = cleanJson.indexOf('{');
      const lastBrace = cleanJson.lastIndexOf('}');
      if (firstBrace >= 0 && lastBrace > firstBrace) {
        cleanJson = cleanJson.slice(firstBrace, lastBrace + 1);
      }

      const attempts: string[] = [cleanJson];

      const repairUnescapedInnerQuotes = (text: string) => {
        let out = '';
        let inString = false;
        let escape = false;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (escape) { out += ch; escape = false; continue; }
          if (ch === '\\') { out += ch; escape = true; continue; }
          if (ch === '"') {
            if (!inString) { inString = true; out += ch; continue; }
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j++;
            const next = text[j] || '';
            const looksLikeTerminator = next === ',' || next === '}' || next === ']' || next === ':';
            if (looksLikeTerminator) { inString = false; out += ch; } else { out += '\\"'; }
            continue;
          }
          out += ch;
        }
        return out;
      };

      const repairedBasic = cleanJson
        .replace(/\r/g, '').replace(/\n/g, ' ').replace(/[\u0000-\u001F]/g, ' ')
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, '"$1"')
        .replace(/\u201c|\u201d/g, '"').replace(/\u2018|\u2019/g, "'");
      attempts.push(repairedBasic);

      const repairedQuotes = repairUnescapedInnerQuotes(repairedBasic);
      attempts.push(repairedQuotes);

      // Common LLM defect: missing comma between sibling properties.
      // Example: {"a":"x" "b":"y"} -> {"a":"x", "b":"y"}
      const repairMissingCommasBetweenProperties = (text: string) => {
        let out = text;
        // String value followed by next property key
        out = out.replace(/(:\s*"(?:\\.|[^"\\])*")\s+("[A-Za-z0-9_.$-]+"\s*:)/g, '$1, $2');
        // Number/boolean/null value followed by next property key
        out = out.replace(/(:\s*(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null))\s+("[A-Za-z0-9_.$-]+"\s*:)/g, '$1, $2');
        // Object/array value followed by next property key
        out = out.replace(/([}\]])\s+("[A-Za-z0-9_.$-]+"\s*:)/g, '$1, $2');
        return out;
      };
      const repairedCommas = repairMissingCommasBetweenProperties(repairedQuotes);
      attempts.push(repairedCommas);

      // Common LLM defect: missing comma between array items.
      // Example: [{"a":1} {"b":2}] -> [{"a":1}, {"b":2}]
      const repairMissingCommasBetweenArrayItems = (text: string) => {
          // First pass: simple regex to replace }{ with },{ and ][ with ],[
          let out = text.replace(/\}\s*\{/g, '},{').replace(/\]\s*\[/g, '],[');
        
          // Second pass: more sophisticated character-by-character scan for edge cases
          let result = '';
          let inString = false;
          let escape = false;
          let lastSignificant = '';
          let sawWhitespaceSinceLastSignificant = false;
          const stack: string[] = [];

          const canStartArrayValue = (ch: string) => {
            return ch === '{' || ch === '[' || ch === '"' || ch === '-' || /\d/.test(ch) || ch === 't' || ch === 'f' || ch === 'n';
          };

          const shouldInsertComma = (ch: string) => {
            if (stack[stack.length - 1] !== '[') return false;
            if (!canStartArrayValue(ch)) return false;
            if (!lastSignificant || lastSignificant === '[' || lastSignificant === ',' || lastSignificant === ':') return false;

            // Prefer cases where a boundary is obvious, while still covering direct object/array adjacency.
            return sawWhitespaceSinceLastSignificant || lastSignificant === '}' || lastSignificant === ']' || lastSignificant === '"';
          };

          for (let i = 0; i < out.length; i++) {
            const ch = out[i];

            if (escape) {
              result += ch;
              escape = false;
              continue;
            }

            if (inString) {
              result += ch;
              if (ch === '\\') {
                escape = true;
              } else if (ch === '"') {
                inString = false;
                lastSignificant = '"';
                sawWhitespaceSinceLastSignificant = false;
              }
              continue;
            }

            if (/\s/.test(ch)) {
              result += ch;
              sawWhitespaceSinceLastSignificant = true;
              continue;
            }

            if (shouldInsertComma(ch)) {
              result += ', ';
              lastSignificant = ',';
              sawWhitespaceSinceLastSignificant = false;
            }

            result += ch;

            if (ch === '"') {
              inString = true;
              sawWhitespaceSinceLastSignificant = false;
              continue;
            }

            if (ch === '{' || ch === '[') {
              stack.push(ch);
            } else if (ch === '}' && stack[stack.length - 1] === '{') {
              stack.pop();
            } else if (ch === ']' && stack[stack.length - 1] === '[') {
              stack.pop();
            }

            lastSignificant = ch;
            sawWhitespaceSinceLastSignificant = false;
          }

          return result;
      };
      const repairedArrayItemCommas = repairMissingCommasBetweenArrayItems(repairedCommas);
      attempts.push(repairedArrayItemCommas);

      const balanceLikelyTruncated = (text: string) => {
        let inString = false; let escape = false; let curly = 0; let square = 0;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (escape) { escape = false; continue; }
          if (ch === '\\') { escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === '{') curly++; else if (ch === '}') curly = Math.max(0, curly - 1);
          else if (ch === '[') square++; else if (ch === ']') square = Math.max(0, square - 1);
        }
        let out = text;
        if (inString) out += '"';
        out += ']'.repeat(square);
        out += '}'.repeat(curly);
        return out;
      };
      attempts.push(balanceLikelyTruncated(repairedBasic));
      attempts.push(balanceLikelyTruncated(repairedQuotes));
      attempts.push(balanceLikelyTruncated(repairedCommas));
      attempts.push(balanceLikelyTruncated(repairedArrayItemCommas));

      const errors: string[] = [];
      for (const attempt of attempts) {
        try { return { parsed: JSON.parse(attempt), cleanJson: attempt }; } catch (e: any) { errors.push(e?.message || String(e)); }
      }
      const lastErr = errors[errors.length - 1] || 'Invalid JSON response';
      const posMatch = String(lastErr).match(/position\s+(\d+)/i);
      if (posMatch) {
        const pos = Number(posMatch[1]);
        const start = Math.max(0, pos - 80);
        const end = Math.min(cleanJson.length, pos + 80);
        const snippet = cleanJson.slice(start, end).replace(/\s+/g, ' ');
        throw new Error(`${lastErr}. Near: ${snippet}`);
      }
      throw new Error(lastErr);
    };

  const validateJourneyNamingConventions = (parsedResponse: any) => {
    const journeyConfig = parsedResponse?.journey || parsedResponse;
    const steps = journeyConfig?.steps || parsedResponse?.steps || [];
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new Error('Invalid response: missing journey steps array');
    }

    const genericStepPattern = /^(step|stage|phase)\s*[-_]*\d+$/i;
    const genericServicePattern = /^(step|stage|phase)\s*[-_]*\d+\s*service$/i;

    const badStepNames: string[] = [];
    const badServiceNames: string[] = [];

    const normalizedSteps = steps.map((s: any, idx: number) => {
      const stepName = String(s.stepName || s.name || '').trim();
      if (!stepName) {
        badStepNames.push(`(missing at index ${idx + 1})`);
      } else if (genericStepPattern.test(stepName)) {
        badStepNames.push(stepName);
      }

      const serviceNameRaw = String(s.serviceName || s.service || '').trim();
      if (serviceNameRaw && genericServicePattern.test(serviceNameRaw)) {
        badServiceNames.push(serviceNameRaw);
      }

      return {
        ...s,
        stepName: stepName || `UnnamedStep${idx + 1}`,
        serviceName: normalizeServiceName(serviceNameRaw || stepName, stepName),
      };
    });

    if (badStepNames.length || badServiceNames.length) {
      const details: string[] = [];
      if (badStepNames.length) details.push(`generic step names: ${[...new Set(badStepNames)].join(', ')}`);
      if (badServiceNames.length) details.push(`generic service names: ${[...new Set(badServiceNames)].join(', ')}`);
      throw new Error(`Naming convention failed (${details.join(' | ')}). Use domain-specific business step names, not Step1/Step2.`);
    }

    if (parsedResponse?.journey) {
      parsedResponse.journey.steps = normalizedSteps;
    } else {
      parsedResponse.steps = normalizedSteps;
    }

    return { parsedResponse, journeyConfig: parsedResponse?.journey || parsedResponse };
  };

  const processResponse = async () => {
    if (!copilotResponse.trim()) {
      showToast('Please paste the AI response before proceeding.', 'warning');
      return;
    }
    
    try {
      const { parsed: parsedResponse } = parseJourneyJsonWithRepair(copilotResponse);
      validateJourneyNamingConventions(parsedResponse);
      setGenerationStatus('✅ JSON validated successfully');
      
      // Check if it looks like a journey config
      if (!parsedResponse.journey && !parsedResponse.steps) {
        showToast('Response is valid JSON, but might be missing journey data. Expected "journey" or "steps" field.', 'warning', 6000);
        return;
      }
      
      showToast('Response validated! JSON is ready for service generation.', 'success');
    } catch (error) {
      showToast('Invalid JSON response. Please check the format and try again.', 'error');
      setGenerationStatus('❌ JSON validation failed');
    }
  };

  // Start VCARB Race Operations — loads saved config and triggers journey simulation
  const startVcarbRace = async () => {
    try {
      setIsStartingRace(true);
      setRaceStatus('🏎️ Loading VCARB config...');

      setRaceStatus('🏁 Starting race simulation...');

      const result = await callProxyWithRetry({
        action: 'simulate-vcarb-race',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: { configName: 'vcarb-race-operations' },
      }, 5, 2000) as any;

      if (!result.success) {
        throw new Error(result.error || 'Failed to start VCARB race');
      }

      // Store the raceId so dashboards filter to this specific race
      if (result.raceId) {
        localStorage.setItem('vcarb-active-raceId', result.raceId);
      }

      setRaceStatus('✅ Race is live!');
      showToast('🏎️ VCARB Race Operations started! Opening dashboard...', 'success', 3000);
      setTimeout(() => { setRaceStatus(null); navigate('/vcarb'); }, 1500);
    } catch (err: any) {
      console.error('[VCARB] Start race error:', err);
      setRaceStatus(`❌ ${err.message}`);
      showToast(`Failed to start VCARB race: ${err.message}`, 'error', 8000);
      setTimeout(() => setRaceStatus(null), 8000);
    } finally {
      setIsStartingRace(false);
    }
  };

  const generateServices = async () => {
    if (!copilotResponse.trim()) {
      showToast('Please paste the AI response before generating services.', 'warning');
      return;
    }

    try {
      setIsGeneratingServices(true);
      setGenerationStatus('🔄 Parsing journey data...');

      const { parsed: parsedResponse, cleanJson: cleanResponse } = parseJourneyJsonWithRepair(copilotResponse);
      validateJourneyNamingConventions(parsedResponse);
      
      // Validate journey structure
      if (!parsedResponse.journey && !parsedResponse.steps) {
        throw new Error('Missing journey or steps data in response');
      }

      setGenerationStatus(`🚀 Creating services on ${apiSettings.host}:${apiSettings.port}...`);
      void trackUiUsage('create-journey-manual', 'journey', {
        pagePath: '/',
        companyName: parsedResponse.journey?.companyName || parsedResponse.steps?.[0]?.companyName || companyName,
        journeyType: parsedResponse.journey?.journeyType || domain,
      });
      const { userEmail, userName } = getAuditUser();
      
      // Call via serverless proxy function (bypasses CSP)
      const normalizedPayload = normalizeJourneyPayload(parsedResponse);
      const canStartJourney = await ensureJourneyCanStart(normalizedPayload, setGenerationStatus);
      if (!canStartJourney) {
        return;
      }
      const result = await callProxyWithRetry({
          action: 'simulate-journey',
          apiHost: apiSettings.host,
          apiPort: apiSettings.port,
          apiProtocol: apiSettings.protocol,
          body: {
            ...normalizedPayload,
            userEmail,
            userName,
          },
      }, 5, 2000, setGenerationStatus) as any;

      if (!result.success) {
        const dupData = result.data as any;
        if (result.status === 409 || dupData?.duplicate) {
          const navigateTo = dupData?.navigateTo || '/services';
          setGenerationStatus(`⚠️ Duplicate journey blocked.`);
          const goNow = window.confirm(
            `A journey for "${companyName}" with identical steps is already running.\n\nClick OK to view the running topology, or Cancel to stay here.`
          );
          if (goNow) window.open(navigateTo, '_blank');
          return;
        }
        throw new Error(result.error || `API call failed (status ${result.status})`);
      }

      const data = result.data as any;
      const journey = data?.journey;
      const jId = journey?.journeyId || data?.journeyId || 'N/A';
      const jCompany = journey?.steps?.[0]?.companyName || data?.companyName || companyName;
      setGenerationStatus(`✅ Services created successfully! Journey ID: ${jId}`);
      showToast(`Services generated! Journey: ${jId} • Company: ${jCompany}`, 'success', 6000);

      // Build full steps for business flow deployment
      const journeyConfig = parsedResponse.journey || parsedResponse;
      const fullSteps = (journeyConfig.steps || parsedResponse.steps || []).map((s: any) => ({
        ...s,
        stepName: s.stepName || s.name,
        serviceName: normalizeServiceName(s.serviceName || s.service, s.stepName || s.name),
        companyName: s.companyName || jCompany,
      }));

      // Auto-deploy Business Flow to Dynatrace for this journey
      autoDeployBusinessFlow(
        jCompany,
        journeyConfig.journeyType || parsedResponse.journey?.journeyType || domain,
        fullSteps
      );

      void commitJourneyToRepo({
        ...journeyConfig,
        companyName: journeyConfig.companyName || jCompany,
        journeyType: journeyConfig.journeyType || parsedResponse.journey?.journeyType || domain,
      }, 'manual');

      // Auto-save to My Templates (same as manual path)
      const autoTemplateName = `${companyName} - ${domain}`;
      const newTemplate: PromptTemplate = {
        id: `template_${Date.now()}`,
        name: autoTemplateName,
        companyName,
        domain,
        requirements,
        csuitePrompt: prompt1,
        journeyPrompt: prompt2,
        response: cleanResponse,
        createdAt: new Date().toISOString(),
        isPreloaded: false,
      };
      const updated = [...savedTemplates, newTemplate];
      setSavedTemplates(updated);
      localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(updated));
      saveTenantField({ promptTemplates: JSON.stringify(updated) });
      
    } catch (error: any) {
      console.error('Service generation error:', error);
      setGenerationStatus(`❌ Failed: ${error.message}`);
      showToast(`Failed to generate services: ${error.message}`, 'error', 8000);
    } finally {
      setIsGeneratingServices(false);
    }
  };

  const saveTemplate = () => {
    if (!templateName.trim()) {
      showToast('Please enter a template name.', 'warning');
      return;
    }

    const newTemplate: PromptTemplate = {
      id: `template_${Date.now()}`,
      name: templateName,
      companyName,
      domain,
      requirements,
      csuitePrompt: prompt1,
      journeyPrompt: prompt2,
      response: copilotResponse, // Save the JSON response
      createdAt: new Date().toISOString(),
      isPreloaded: false // User-created template
    };

    const updated = [...savedTemplates, newTemplate];
    setSavedTemplates(updated);
    localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(updated));
    saveTenantField({ promptTemplates: JSON.stringify(updated) });
    setTemplateName('');
    setShowSaveDialog(false);
    showToast(`Template "${templateName}" saved!`, 'success');
  };

  // ── Full AI Generation Pipeline (modal flow) ─────────────
  const runAiGenerationPipeline = async () => {
    type StepObj = { label: string; status: 'pending' | 'running' | 'done' | 'error'; detail?: string };
    const steps: StepObj[] = [
      { label: 'Generating C-Suite Analysis', status: 'pending' },
      { label: 'Select Journey from Analysis', status: 'pending' },
      { label: 'Generating Journey Config', status: 'pending' },
      { label: 'Validating JSON', status: 'pending' },
      { label: 'Creating Services', status: 'pending' },
      { label: 'Saving Journey to GitHub', status: 'pending' },
      { label: 'Saving to My Templates', status: 'pending' },
    ];
    setAiGenSteps([...steps]);
    setAiGenComplete(false);
    setAiGenError('');
    setShowAiGenModal(true);
    let stepIdx = 0;

    const updateStep = (idx: number, update: Partial<StepObj>) => {
      steps[idx] = { ...steps[idx], ...update };
      setAiGenSteps([...steps]);
    };

    try {
      // Step 1: Generate C-Suite Analysis
      updateStep(stepIdx, { status: 'running' });
      setGhGenerating1(true);
      setGhResult1('');
      const csuite = generateCsuitePrompt({ companyName, domain, requirements });
      setPrompt1(csuite);
      const res1 = await callDynatraceAssistGenerateWithBackoff(
        csuite,
        (msg) => updateStep(stepIdx, { status: 'running', detail: msg }),
        'C-Suite generation'
      );
      setGhGenerating1(false);
      if (!res1.success) {
        throw new Error(`C-Suite generation failed: ${res1.error}`);
      }
      setGhResult1(res1.data.content);
      const g1 = res1.data.genai;
      updateStep(stepIdx, { status: 'done', detail: g1 ? `${g1.model} · ${g1.totalTokens} tokens · ${(g1.durationMs / 1000).toFixed(1)}s` : `Model: ${res1.data.model}` });
      stepIdx++;

      // Extract journeys from analysis and let user pick one
      let journeyReqs = requirements;
      {
        updateStep(stepIdx, { status: 'running' });
        const foundJourneys = extractJourneysFromText(res1.data.content);
        setExtractedJourneys(foundJourneys);
        // If user typed requirements, try to pre-select a matching journey
        const preselect = requirements.trim()
          ? foundJourneys.find(j => j.toLowerCase().includes(requirements.trim().toLowerCase())) || foundJourneys[0] || requirements.trim()
          : foundJourneys[0] || '';
        setSelectedJourneyName(preselect);

        // Show journey picker modal and wait for user selection
        const chosenJourney = await new Promise<string>((resolve) => {
          setJourneyPickerResolve(() => resolve);
          setShowJourneyPickerModal(true);
        });
        setShowJourneyPickerModal(false);
        setJourneyPickerResolve(null);
        journeyReqs = chosenJourney;
        updateStep(stepIdx, { status: 'done', detail: `Selected: "${chosenJourney}"` });
        stepIdx++;
      }

      // Generate Journey Config
      updateStep(stepIdx, { status: 'running' });
      setGhGenerating2(true);
      setGhResult2('');
      const journey = generateJourneyPrompt({ companyName, domain, requirements: journeyReqs });
      setPrompt2(journey);
      const contextPrefix = `Here is the C-suite analysis from the previous step:\n\n${res1.data.content}\n\nNow, based on that context, generate the "${journeyReqs}" journey:\n\n`;
      const res2 = await callGithubCopilotGenerateWithBackoff(
        contextPrefix + journey,
        'gpt-4.1',
        (msg) => updateStep(stepIdx, { status: 'running', detail: msg }),
        'Journey generation'
      );
      setGhGenerating2(false);
      if (!res2.success) {
        throw new Error(`Journey generation failed: ${res2.error}`);
      }
      setGhResult2(res2.data.content);
      const g2 = res2.data.genai;
      updateStep(stepIdx, { status: 'done', detail: g2 ? `${g2.model} · ${g2.totalTokens} tokens · ${(g2.durationMs / 1000).toFixed(1)}s` : `Model: ${res2.data.model}` });
      stepIdx++;

      // Validate JSON
      updateStep(stepIdx, { status: 'running' });
      const { parsed: parsedResponse, cleanJson } = parseJourneyJsonWithRepair(res2.data.content);
      const validated = validateJourneyNamingConventions(parsedResponse);
      if (!parsedResponse.journey && !parsedResponse.steps) {
        throw new Error('Invalid response: missing "journey" or "steps" field');
      }
      setCopilotResponse(cleanJson);
      const journeyConfig = validated.journeyConfig;
      const jType = journeyConfig.journeyType || parsedResponse.journey?.journeyType || domain;
      const stepCount = (journeyConfig.steps || parsedResponse.steps || []).length;
      updateStep(stepIdx, { status: 'done', detail: `${stepCount} steps · ${jType}` });
      stepIdx++;

      // Generate Services
      updateStep(stepIdx, { status: 'running' });
      setIsGeneratingServices(true);
      const { userEmail, userName } = getAuditUser();
      void trackUiUsage('create-journey-ai-agent', 'journey', {
        pagePath: '/',
        companyName: parsedResponse.journey?.companyName || parsedResponse.steps?.[0]?.companyName || companyName,
        journeyType: jType,
      });
      const normalizedPayload = normalizeJourneyPayload(parsedResponse);
      const canStartJourney = await ensureJourneyCanStart(normalizedPayload, (msg) => updateStep(stepIdx, { status: 'running', detail: msg }));
      if (!canStartJourney) {
        updateStep(stepIdx, { status: 'error', detail: 'Cancelled because an identical journey is already running.' });
        return;
      }
      const result = await callProxyWithRetry({
        action: 'simulate-journey',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: {
          ...normalizedPayload,
          userEmail,
          userName,
        },
      }, 5, 2000) as any;
      setIsGeneratingServices(false);
      if (!result.success) {
        const dupData = result.data as any;
        if (result.status === 409 || dupData?.duplicate) {
          const navigateTo = dupData?.navigateTo || '/services';
          updateStep(stepIdx, { status: 'error', detail: `Duplicate blocked — identical journey already running for ${companyName}.` });
          const goNow = window.confirm(
            `A journey for "${companyName}" with identical steps is already running.\n\nClick OK to view the running topology, or Cancel to stay here.`
          );
          if (goNow) window.open(navigateTo, '_blank');
          return;
        }
        throw new Error(result.error || `Service creation failed (status ${result.status})`);
      }
      const data = result.data as any;
      const jObj = data?.journey;
      const jId = jObj?.journeyId || data?.journeyId || 'N/A';
      const jCompany = jObj?.steps?.[0]?.companyName || data?.companyName || companyName;
      updateStep(stepIdx, { status: 'done', detail: `Journey: ${jId}` });
      stepIdx++;

      // Auto-deploy Business Flow
      const fullSteps = (journeyConfig.steps || parsedResponse.steps || []).map((s: any) => ({
        ...s,
        stepName: s.stepName || s.name,
        serviceName: normalizeServiceName(s.serviceName || s.service, s.stepName || s.name),
        companyName: s.companyName || jCompany,
      }));
      autoDeployBusinessFlow(jCompany, jType, fullSteps);

      // Commit journey to GitHub repo
      updateStep(stepIdx, { status: 'running' });
      await commitJourneyToRepo({
        ...journeyConfig,
        companyName: journeyConfig.companyName || jCompany,
        journeyType: jType,
      }, 'ai-agent');
      updateStep(stepIdx, { status: 'done', detail: 'Journey saved to repo' });
      stepIdx++;

      // Auto-save to My Templates
      updateStep(stepIdx, { status: 'running' });
      const autoTemplateName = `${companyName} - ${jType}`;
      const newTemplate: PromptTemplate = {
        id: `template_${Date.now()}`,
        name: autoTemplateName,
        companyName,
        domain,
        requirements: journeyReqs || requirements,
        csuitePrompt: csuite,
        journeyPrompt: journey,
        response: cleanJson,
        createdAt: new Date().toISOString(),
        isPreloaded: false,
      };
      const updated = [...savedTemplates, newTemplate];
      setSavedTemplates(updated);
      localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(updated));
      saveTenantField({ promptTemplates: JSON.stringify(updated) });
      updateStep(stepIdx, { status: 'done', detail: `Saved as "${autoTemplateName}"` });

      setAiGenDashboardCompany(jCompany);
      setAiGenDashboardJourney(jType);
      setAiGenComplete(true);
      setGenerationStatus(`✅ Journey created! Services live and ready. Go to Navigation > Generate Visuals to create dashboards. Journey ID: ${jId}`);
      setActiveTab('step2');
      setStep2Phase('generate');
    } catch (err: any) {
      setGhGenerating1(false);
      setGhGenerating2(false);
      setIsGeneratingServices(false);
      setShowJourneyPickerModal(false);
      setJourneyPickerResolve(null);
      const failedIdx = steps.findIndex(s => s.status === 'running');
      if (failedIdx >= 0) updateStep(failedIdx, { status: 'error', detail: err.message });
      setAiGenError(err.message);
    }
  };

  // ── Extract journey names from a pasted C-Suite AI response ─────────────
  const extractJourneysFromText = (text: string): string[] => {
    const journeys: string[] = [];
    const seenLower = new Set<string>();

    const normalizeJourneyName = (value: string) => {
      let out = value.trim();
      // Remove common generic prefixes that are not useful as a journey label.
      out = out.replace(/^(?:business|customer|digital)\s+journey\s+/i, '');
      out = out.replace(/^journey\s*[:\-]\s*/i, '');
      // Keep only the concise journey title when models append descriptions.
      out = out.replace(/\s*[:\-]\s+.*$/, '');
      // Keep labels concise for the picker.
      out = out.replace(/\s*\([^)]*\)\s*$/, '');
      out = out.replace(/[.;:,\s]+$/, '');
      out = out.replace(/\s{2,}/g, ' ').trim();
      return out ? out.charAt(0).toUpperCase() + out.slice(1) : out;
    };
    
    const addJourney = (name: string) => {
      const clean = normalizeJourneyName(name
        .replace(/^[-•*]\s+/, '')
        .replace(/^\d+\.\s+/, '')
        .replace(/\*\*/g, '')
        .replace(/[""\u201C\u201D]/g, '')
        .replace(/:+\s*$/, '')
        .trim());
      if (clean && clean.length < 100 && clean.length > 2 && !seenLower.has(clean.toLowerCase())) {
        const lower = clean.toLowerCase();
        if (
          !lower.includes('instructions') &&
          !lower.includes('replace the bracketed') &&
          !lower.includes('e.g.') &&
          !lower.includes('constraints from input') &&
          !lower.match(/^journey\s?(names?|classification|candidates)/i)
        ) {
          journeys.push(clean);
          seenLower.add(lower);
        }
      }
    };

    // Primary: "Recommended Journey Candidates" section with any format
    const recommendedMatch = text.match(/(?:Recommended Journey Candidates|Journey Candidates)[:\s]*\n([\s\S]*?)(?:\n##|\n###|\n\*\*|\n---|\n$)/i);
    if (recommendedMatch) {
      const block = recommendedMatch[1];
      const bullets = block.match(/(?:[-•*]|\d+[.)])\s+["\u201C]?[^"\n]+["\u201D]?/g) || [];
      bullets.forEach(b => addJourney(b));

      // Some models return plain lines in this section without bullets.
      if (journeys.length < 3) {
        block
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line && !line.startsWith('#') && !/^\*\*?instructions?/i.test(line))
          .forEach(line => addJourney(line));
      }
    }

    // Secondary: "Critical User Journeys" section
    if (journeys.length === 0) {
      const criticalMatch = text.match(/Critical User (?:Journeys|Flows|Processes)[:\s]*\n([\s\S]*?)(?:\n##|\n###|\n\*\*[A-Z]|\n---|\n$)/i);
      if (criticalMatch) {
        const block = criticalMatch[1];
        const bullets = block.match(/(?:[-•*]|\d+[.)])\s+[^'\n]+/g) || [];
        bullets.forEach(b => addJourney(b));
      }
    }

    // Tertiary: "Journey Classification" or "Journey Names"
    if (journeys.length === 0) {
      const classMatch = text.match(/Journey (?:Classification|Names)[:\s]*\n([\s\S]*?)(?:\n##|\n###|\n\*\*[A-Z]|\n---|\n$)/i);
      if (classMatch) {
        const block = classMatch[1];
        const bullets = block.match(/(?:[-•*]|\d+[.)])\s+[^'\n]+/g) || [];
        bullets.forEach(b => addJourney(b));
      }
    }

    // Fallback 1: All quoted journey-like names (5+ characters, no "instructions")
    if (journeys.length === 0) {
      const allQuoted = text.match(/(?:[-•*]|\d+[.)])\s+["\u201C]([^"\u201D]{5,80})["\u201D]/g) || [];
      allQuoted.forEach(m => addJourney(m));
    }

    // Fallback 2: Any bullet points after the word "journey" lowercase
    if (journeys.length === 0) {
      const journeyIdx = text.toLowerCase().lastIndexOf('journey');
      if (journeyIdx > -1) {
        const afterJourney = text.slice(journeyIdx);
        const bullets = afterJourney.match(/(?:[-•*]|\d+[.)])\s+([^\n]{5,80})/g) || [];
        bullets.slice(0, 5).forEach(b => addJourney(b));
      }
    }

    // Fallback 3: Parse any uppercase-starting bullet points that look like journey names (2-5 words)
    if (journeys.length === 0) {
      const capitalBullets = text.match(/(?:[-•*]|\d+[.)])\s+([A-Z][^:\n]{5,75})/g) || [];
      capitalBullets.forEach(b => {
        const name = b.replace(/^(?:[-•*]|\d+[.)])\s+/, '').trim();
        if (name && !name.match(/^(the|a|an|for)\s/i) && name.split(/\s+/).length <= 6) {
          addJourney(name);
        }
      });
    }

    return journeys.slice(0, 3); // Always show a concise set of 3 journey choices
  };

  // ── Pipeline using pasted C-Suite analysis + selected journey ─────────────
  const runPastedAiPipeline = async (csuiteText: string, journeyName: string) => {
    type StepObj = { label: string; status: 'pending' | 'running' | 'done' | 'error'; detail?: string };
    const steps: StepObj[] = [
      { label: 'Using Pasted C-Suite Analysis', status: 'pending' },
      { label: `Generating "${journeyName}" Config`, status: 'pending' },
      { label: 'Validating JSON', status: 'pending' },
      { label: 'Creating Services', status: 'pending' },
      { label: 'Saving to My Templates', status: 'pending' },
    ];
    setAiGenSteps([...steps]);
    setAiGenComplete(false);
    setAiGenError('');
    setShowPasteAiModal(false);
    setShowAiGenModal(true);

    const updateStep = (idx: number, update: Partial<StepObj>) => {
      steps[idx] = { ...steps[idx], ...update };
      setAiGenSteps([...steps]);
    };

    try {
      // Step 1: Use pasted analysis (already have it)
      updateStep(0, { status: 'running' });
      setGhResult1(csuiteText);
      const csuite = `[Pasted from external AI]\n\n${csuiteText.substring(0, 200)}...`;
      setPrompt1(csuite);
      updateStep(0, { status: 'done', detail: `${csuiteText.length.toLocaleString()} chars · ${extractedJourneys.length} journeys found` });

      // Step 2: Generate Journey Config with selected journey
      updateStep(1, { status: 'running' });
      setGhGenerating2(true);
      setGhResult2('');
      // Override requirements with the selected journey name
      const journeyReqs = `${journeyName} — based on the C-suite analysis provided`;
      const journey = generateJourneyPrompt({ companyName, domain, requirements: journeyReqs });
      setPrompt2(journey);
      const contextPrefix = `Here is the C-suite analysis from the previous step:\n\n${csuiteText}\n\nNow, based on that context, generate the "${journeyName}" journey:\n\n`;
      const res2 = await callGithubCopilotGenerateWithBackoff(
        contextPrefix + journey,
        'gpt-4.1',
        (msg) => updateStep(1, { status: 'running', detail: msg }),
        'Journey generation'
      );
      setGhGenerating2(false);
      if (!res2.success) {
        throw new Error(`Journey generation failed: ${res2.error}`);
      }
      setGhResult2(res2.data.content);
      const g2 = res2.data.genai;
      updateStep(1, { status: 'done', detail: g2 ? `${g2.model} · ${g2.totalTokens} tokens · ${(g2.durationMs / 1000).toFixed(1)}s` : `Model: ${res2.data.model}` });

      // Step 3: Validate JSON
      updateStep(2, { status: 'running' });
      const { parsed: parsedResponse, cleanJson } = parseJourneyJsonWithRepair(res2.data.content);
      const validated = validateJourneyNamingConventions(parsedResponse);
      if (!parsedResponse.journey && !parsedResponse.steps) {
        throw new Error('Invalid response: missing "journey" or "steps" field');
      }
      setCopilotResponse(cleanJson);
      const journeyConfig = validated.journeyConfig;
      const jType = journeyConfig.journeyType || parsedResponse.journey?.journeyType || domain;
      const stepCount = (journeyConfig.steps || parsedResponse.steps || []).length;
      updateStep(2, { status: 'done', detail: `${stepCount} steps · ${jType}` });

      // Step 4: Generate Services
      updateStep(3, { status: 'running' });
      setIsGeneratingServices(true);
      const { userEmail, userName } = getAuditUser();
      const normalizedPayload = normalizeJourneyPayload(parsedResponse);
      const canStartJourney = await ensureJourneyCanStart(normalizedPayload, (msg) => updateStep(3, { status: 'running', detail: msg }));
      if (!canStartJourney) {
        updateStep(3, { status: 'error', detail: 'Cancelled because an identical journey is already running.' });
        setIsGeneratingServices(false);
        return;
      }
      const result = await callProxyWithRetry({
        action: 'simulate-journey',
        apiHost: apiSettings.host,
        apiPort: apiSettings.port,
        apiProtocol: apiSettings.protocol,
        body: {
          ...normalizedPayload,
          userEmail,
          userName,
        },
      }, 5, 2000) as any;
      setIsGeneratingServices(false);
      if (!result.success) {
        const dupData = result.data as any;
        if (result.status === 409 || dupData?.duplicate) {
          const navigateTo = dupData?.navigateTo || '/services';
          updateStep(3, { status: 'error', detail: `Duplicate blocked — identical journey already running for ${companyName}.` });
          const goNow = window.confirm(
            `A journey for "${companyName}" with identical steps is already running.\n\nClick OK to view the running topology, or Cancel to stay here.`
          );
          if (goNow) window.open(navigateTo, '_blank');
          setIsGeneratingServices(false);
          return;
        }
        throw new Error(result.error || `Service creation failed (status ${result.status})`);
      }
      const data = result.data as any;
      const jObj = data?.journey;
      const jId = jObj?.journeyId || data?.journeyId || 'N/A';
      const jCompany = jObj?.steps?.[0]?.companyName || data?.companyName || companyName;
      updateStep(3, { status: 'done', detail: `Journey: ${jId}` });

      // Auto-deploy Business Flow
      const fullSteps = (journeyConfig.steps || parsedResponse.steps || []).map((s: any) => ({
        ...s,
        stepName: s.stepName || s.name,
        serviceName: normalizeServiceName(s.serviceName || s.service, s.stepName || s.name),
        companyName: s.companyName || jCompany,
      }));
      autoDeployBusinessFlow(jCompany, jType, fullSteps);
      void commitJourneyToRepo({
        ...journeyConfig,
        companyName: journeyConfig.companyName || jCompany,
        journeyType: jType,
      }, 'pasted-ai');

      // Step 5: Auto-save to My Templates
      updateStep(4, { status: 'running' });
      const autoTemplateName = `${companyName} - ${jType}`;
      const newTemplate: PromptTemplate = {
        id: `template_${Date.now()}`,
        name: autoTemplateName,
        companyName,
        domain,
        requirements: journeyReqs,
        csuitePrompt: csuite,
        journeyPrompt: journey,
        response: cleanJson,
        createdAt: new Date().toISOString(),
        isPreloaded: false,
      };
      const updated = [...savedTemplates, newTemplate];
      setSavedTemplates(updated);
      localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(updated));
      saveTenantField({ promptTemplates: JSON.stringify(updated) });
      updateStep(4, { status: 'done', detail: `Saved as "${autoTemplateName}"` });

      setAiGenDashboardCompany(jCompany);
      setAiGenDashboardJourney(jType);
      setAiGenComplete(true);
      setGenerationStatus(`✅ Services created successfully! Journey ID: ${jId}`);
      setActiveTab('step2');
      setStep2Phase('generate');
    } catch (err: any) {
      setGhGenerating2(false);
      setIsGeneratingServices(false);
      const failedIdx = steps.findIndex(s => s.status === 'running');
      if (failedIdx >= 0) updateStep(failedIdx, { status: 'error', detail: err.message });
      setAiGenError(err.message);
    }
  };

  const loadTemplate = (templateId: string) => {
    const template = savedTemplates.find(t => t.id === templateId);
    if (template) {
      setCompanyName(template.companyName);
      setDomain(template.domain);
      setRequirements(template.requirements);
      setPrompt1(template.csuitePrompt);
      setPrompt2(template.journeyPrompt);
      // Load response - either from response field or originalConfig
      if (template.response) {
        setCopilotResponse(template.response);
      } else if (template.originalConfig) {
        // For pre-loaded templates, check for copilotResponseStep2 field
        const configResponse = template.originalConfig.copilotResponseStep2 
          || template.originalConfig.copilotResponse 
          || JSON.stringify(template.originalConfig, null, 2);
        setCopilotResponse(configResponse);
      } else {
        setCopilotResponse('');
      }
      setSelectedTemplate(templateId);
      // If the template already has a response, go straight to step2 (generate services)
      if (template.response || template.originalConfig) {
        setSelectedPathway('ai');
        setStep2Phase('generate');
        setActiveTab('step2');
      } else {
        setSelectedPathway('ai');
        setActiveTab('step1');
      }
    }
  };

  const deleteTemplate = (templateId: string) => {
    setConfirmDialog({
      message: 'Are you sure you want to delete this template?',
      onConfirm: () => {
        const updated = savedTemplates.filter(t => t.id !== templateId);
        setSavedTemplates(updated);
        localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(updated));
        saveTenantField({ promptTemplates: JSON.stringify(updated) });
        if (selectedTemplate === templateId) {
          setSelectedTemplate('');
        }
        showToast('Template deleted.', 'success');
      }
    });
  };

  const exportTemplate = (templateId: string) => {
    const template = savedTemplates.find(t => t.id === templateId);
    if (template) {
      const dataStr = JSON.stringify(template, null, 2);
      const dataBlob = new Blob([dataStr], { type: 'application/json' });
      const url = URL.createObjectURL(dataBlob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${template.companyName.replace(/\s+/g, '-')}-${template.name.replace(/\s+/g, '-')}.json`;
      link.click();
      URL.revokeObjectURL(url);
    }
  };

  const exportAllTemplates = () => {
    const dataStr = JSON.stringify(savedTemplates, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    const url = URL.createObjectURL(dataBlob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `all-templates-${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const importTemplates = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const content = e.target?.result as string;
        const imported = JSON.parse(content);
        
        // Check if it's a single template or array
        const templates = Array.isArray(imported) ? imported : [imported];
        
        // Merge with existing templates, avoiding duplicates
        const merged = [...savedTemplates];
        templates.forEach((t: PromptTemplate) => {
          if (!merged.find(existing => existing.id === t.id)) {
            merged.push(t);
          }
        });
        
        setSavedTemplates(merged);
        localStorage.setItem(TEMPLATES_STORAGE_KEY, JSON.stringify(merged));
        saveTenantField({ promptTemplates: JSON.stringify(merged) });
        showToast(`Imported ${templates.length} template(s) successfully!`, 'success');
      } catch (error) {
        showToast('Failed to import templates. Please check the file format.', 'error');
      }
    };
    reader.readAsText(file);

    // Reset the input so the same file can be re-imported
    event.target.value = '';
  };

  // Separate pre-loaded and user-created templates
  const preloadedTemplates = savedTemplates.filter(t => t.isPreloaded);
  const userTemplates = savedTemplates.filter(t => !t.isPreloaded);

  // Group templates by company name
  const groupTemplatesByCompany = (templates: PromptTemplate[]) => {
    return templates.reduce((acc, template) => {
      const company = template.companyName || 'Uncategorized';
      if (!acc[company]) {
        acc[company] = [];
      }
      acc[company].push(template);
      return acc;
    }, {} as Record<string, PromptTemplate[]>);
  };

  const preloadedByCompany = groupTemplatesByCompany(preloadedTemplates);
  const userTemplatesByCompany = groupTemplatesByCompany(userTemplates);

  const [expandedCompanies, setExpandedCompanies] = useState<Record<string, boolean>>({});
  const [templateSearch, setTemplateSearch] = useState('');

  // Filter templates by search term (matches company name or template name)
  const filterBySearch = (grouped: Record<string, PromptTemplate[]>) => {
    if (!templateSearch.trim()) return grouped;
    const q = templateSearch.toLowerCase();
    const result: Record<string, PromptTemplate[]> = {};
    for (const [company, templates] of Object.entries(grouped)) {
      if (company.toLowerCase().includes(q)) {
        result[company] = templates;
      } else {
        const matched = templates.filter(t => t.name.toLowerCase().includes(q));
        if (matched.length) result[company] = matched;
      }
    }
    return result;
  };

  const filteredPreloaded = filterBySearch(preloadedByCompany);
  const filteredUserTemplates = filterBySearch(userTemplatesByCompany);

  const toggleCompany = (company: string) => {
    setExpandedCompanies(prev => ({
      ...prev,
      [company]: !prev[company]
    }));
  };

  const toggleSection = (section: string) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section]
    }));
  };

  const renderSidebar = () => (
    <div style={{
      width: 260,
      height: '100%',
      position: 'relative',
      background: Colors.Background.Surface.Default,
      borderRight: `2px solid ${Colors.Border.Neutral.Default}`,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      flexShrink: 0
    }}>
      {/* Sidebar Header */}
      <div style={{ 
        padding: 16,
        borderBottom: `2px solid ${Colors.Border.Neutral.Default}`,
        background: `linear-gradient(135deg, ${Colors.Theme.Primary['70']}, rgba(0, 212, 255, 0.8))`,
      }}>
        <Flex alignItems="center" gap={8} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 22 }}>📁</div>
          <Heading level={5} style={{ marginBottom: 0, color: 'white' }}>Template Library</Heading>
        </Flex>
        <Paragraph style={{ fontSize: 10, marginBottom: 0, color: 'rgba(255,255,255,0.9)', lineHeight: 1.4 }}>
          {preloadedTemplates.length} Preset • {userTemplates.length} Custom
        </Paragraph>
      </div>

      {/* Save Current Button */}
      <div style={{ padding: 12, borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
        <Button 
          variant="emphasized"
          onClick={() => setShowSaveDialog(true)}
          disabled={!companyName || !domain}
          style={{ width: '100%', marginBottom: 6 }}
        >
          💾 Save to My Templates
        </Button>
        <Flex gap={6}>
          <Button onClick={() => fileInputRef.current?.click()} style={{ flex: 1, fontSize: 11, padding: '6px' }}>📥 Import</Button>
          <input ref={fileInputRef} type="file" accept=".json" onChange={importTemplates} style={{ display: 'none' }} />
          <Button onClick={exportAllTemplates} disabled={savedTemplates.length === 0} style={{ flex: 1, fontSize: 11, padding: '6px' }}>📤 Export</Button>
        </Flex>
      </div>

      {/* Save Dialog */}
      {showSaveDialog && (
        <div style={{ 
          padding: 16,
          background: 'rgba(108, 44, 156, 0.15)',
          borderBottom: `2px solid ${Colors.Theme.Primary['70']}`
        }}>
          <Heading level={6} style={{ marginBottom: 12 }}>Save New Template</Heading>
          <TextInput 
            value={templateName}
            onChange={(value) => setTemplateName(value)}
            placeholder="Template name..."
            style={{ marginBottom: 8 }}
          />
          <Flex gap={8}>
            <Button variant="emphasized" onClick={saveTemplate} style={{ flex: 1 }}>Save</Button>
            <Button onClick={() => setShowSaveDialog(false)} style={{ flex: 1 }}>Cancel</Button>
          </Flex>
        </div>
      )}

      {/* Search */}
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
        <TextInput
          value={templateSearch}
          onChange={(value: string) => setTemplateSearch(value)}
          placeholder="🔍 Search templates..."
        />
      </div>

      {/* Templates List - Separated by Type */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 12 }}>
        {/* App Templates Section */}
        <div style={{ marginBottom: 24 }}>
          <div 
            onClick={() => toggleSection('appTemplates')}
            style={{
              padding: 14,
              background: 'linear-gradient(135deg, rgba(0, 161, 201, 0.25), rgba(0, 161, 201, 0.15))',
              borderRadius: 10,
              border: '2px solid rgba(0, 161, 201, 0.6)',
              cursor: 'pointer',
              marginBottom: 12,
              boxShadow: '0 2px 8px rgba(0, 161, 201, 0.2)'
            }}
          >
            <Flex justifyContent="space-between" alignItems="center">
              <Flex alignItems="center" gap={12}>
                <div style={{ fontSize: 20 }}>{expandedSections.appTemplates ? '📂' : '📁'}</div>
                <div>
                  <Strong style={{ fontSize: 15, display: 'block' }}>🏛️ App Templates</Strong>
                  <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 2, opacity: 0.8 }}>
                    Preset templates included with the app
                  </Paragraph>
                </div>
              </Flex>
              <div style={{
                background: 'rgba(0, 161, 201, 0.8)',
                color: 'white',
                padding: '4px 12px',
                borderRadius: 14,
                fontSize: 12,
                fontWeight: 700
              }}>
                {preloadedTemplates.length}
              </div>
            </Flex>
          </div>

          {(expandedSections.appTemplates || templateSearch.trim()) && (
            <div style={{ paddingLeft: 8 }}>
              {Object.keys(filteredPreloaded).sort().map(company => (
            <div key={company} style={{ marginBottom: 16 }}>
              {/* Company Header */}
              <div 
                onClick={() => toggleCompany(company)}
                style={{
                  padding: 12,
                  background: `linear-gradient(135deg, rgba(108, 44, 156, 0.2), rgba(0, 212, 255, 0.1))`,
                  borderRadius: 8,
                  border: `1px solid ${Colors.Theme.Primary['70']}`,
                  cursor: 'pointer',
                  marginBottom: 8
                }}
              >
                <Flex justifyContent="space-between" alignItems="center">
                  <Flex alignItems="center" gap={8}>
                    <div style={{ fontSize: 16 }}>{expandedCompanies[company] ? '📂' : '📁'}</div>
                    <Strong style={{ fontSize: 14 }}>{company}</Strong>
                  </Flex>
                  <div style={{
                    background: Colors.Theme.Primary['70'],
                    color: 'white',
                    padding: '2px 8px',
                    borderRadius: 12,
                    fontSize: 11,
                    fontWeight: 600
                  }}>
                    {filteredPreloaded[company].length}
                  </div>
                </Flex>
              </div>

              {/* Templates under this company */}
              {(expandedCompanies[company] || templateSearch.trim()) && (
                <div style={{ paddingLeft: 8 }}>
                  {filteredPreloaded[company].map(template => (
                    <div 
                      key={template.id}
                      style={{
                        padding: 12,
                        marginBottom: 8,
                        background: selectedTemplate === template.id 
                          ? 'rgba(115, 190, 40, 0.2)' 
                          : Colors.Background.Base.Default,
                        borderRadius: 6,
                        border: `1px solid ${
                          selectedTemplate === template.id 
                            ? Colors.Theme.Success['70'] 
                            : Colors.Border.Neutral.Default
                        }`,
                        cursor: 'pointer',
                        transition: 'all 0.2s ease'
                      }}
                      onClick={() => loadTemplate(template.id)}
                    >
                      <Flex alignItems="flex-start" gap={8}>
                        <div style={{ fontSize: 16, marginTop: 2 }}>
                          {selectedTemplate === template.id ? '✅' : '📄'}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Strong style={{ 
                            fontSize: 13, 
                            display: 'block',
                            marginBottom: 4,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}>
                            {template.name}
                          </Strong>
                          <Paragraph style={{ 
                            fontSize: 11, 
                            marginBottom: 4,
                            opacity: 0.7,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap'
                          }}>
                            {template.domain}
                          </Paragraph>
                          <Paragraph style={{ fontSize: 10, marginBottom: 0, opacity: 0.5 }}>
                            {new Date(template.createdAt).toLocaleDateString()}
                          </Paragraph>
                        </div>
                      </Flex>
                      
                      {/* Action Buttons */}
                      <Flex gap={4} style={{ marginTop: 8 }}>
                        <Button 
                          onClick={(e) => {
                            e.stopPropagation();
                            loadTemplate(template.id);
                          }}
                          style={{ flex: 1, fontSize: 11, padding: '6px' }}
                        >
                          📂 Load
                        </Button>
                        <Button 
                          onClick={(e) => {
                            e.stopPropagation();
                            exportTemplate(template.id);
                          }}
                          style={{ flex: 1, fontSize: 11, padding: '6px' }}
                        >
                          📤 Export
                        </Button>
                        {!template.isPreloaded && (
                          <Button 
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteTemplate(template.id);
                            }}
                            style={{ fontSize: 11, padding: '6px' }}
                          >
                            🗑️
                          </Button>
                        )}
                      </Flex>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
            </div>
          )}
        </div>

        {/* My Templates Section */}
        <div style={{ marginBottom: 24 }}>
          <div 
            onClick={() => toggleSection('myTemplates')}
            style={{
              padding: 14,
              background: 'linear-gradient(135deg, rgba(108, 44, 156, 0.25), rgba(108, 44, 156, 0.15))',
              borderRadius: 10,
              border: '2px solid rgba(108, 44, 156, 0.6)',
              cursor: 'pointer',
              marginBottom: 12,
              boxShadow: '0 2px 8px rgba(108, 44, 156, 0.2)'
            }}
          >
            <Flex justifyContent="space-between" alignItems="center">
              <Flex alignItems="center" gap={12}>
                <div style={{ fontSize: 20 }}>{expandedSections.myTemplates ? '📂' : '📁'}</div>
                <div>
                  <Strong style={{ fontSize: 15, display: 'block' }}>✨ My Templates</Strong>
                  <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 2, opacity: 0.8 }}>
                    Templates you create and save
                  </Paragraph>
                </div>
              </Flex>
              <div style={{
                background: 'rgba(108, 44, 156, 0.8)',
                color: 'white',
                padding: '4px 12px',
                borderRadius: 14,
                fontSize: 12,
                fontWeight: 700
              }}>
                {userTemplates.length}
              </div>
            </Flex>
          </div>

          {(expandedSections.myTemplates || templateSearch.trim()) && (
            <div style={{ paddingLeft: 8 }}>
              {userTemplates.length === 0 && !templateSearch.trim() ? (
                <div style={{
                  padding: 20,
                  textAlign: 'center',
                  background: 'rgba(108, 44, 156, 0.1)',
                  borderRadius: 8,
                  border: `1px dashed ${Colors.Border.Neutral.Default}`,
                  marginBottom: 12
                }}>
                  <div style={{ fontSize: 28, marginBottom: 8 }}>✨</div>
                  <Paragraph style={{ fontSize: 12, marginBottom: 0, lineHeight: 1.5 }}>
                    <Strong>No custom templates yet</Strong><br/>
                    Click "💾 Save Current" above to create your first template!
                  </Paragraph>
                </div>
              ) : (
                Object.keys(filteredUserTemplates).sort().map(company => (
                  <div key={company} style={{ marginBottom: 12 }}>
                    {/* Company Header */}
                    <div 
                      onClick={() => toggleCompany(`user_${company}`)}
                      style={{
                        padding: 12,
                        background: `linear-gradient(135deg, rgba(108, 44, 156, 0.2), rgba(0, 212, 255, 0.1))`,
                        borderRadius: 8,
                        border: `1px solid ${Colors.Theme.Primary['70']}`,
                        cursor: 'pointer',
                        marginBottom: 8
                      }}
                    >
                      <Flex justifyContent="space-between" alignItems="center">
                        <Flex alignItems="center" gap={8}>
                          <div style={{ fontSize: 16 }}>{expandedCompanies[`user_${company}`] ? '📂' : '📁'}</div>
                          <Strong style={{ fontSize: 14 }}>{company}</Strong>
                        </Flex>
                        <div style={{
                          background: Colors.Theme.Primary['70'],
                          color: 'white',
                          padding: '2px 8px',
                          borderRadius: 12,
                          fontSize: 11,
                          fontWeight: 600
                        }}>
                          {filteredUserTemplates[company].length}
                        </div>
                      </Flex>
                    </div>

                    {/* Templates under this company */}
                    {(expandedCompanies[`user_${company}`] || templateSearch.trim()) && (
                      <div style={{ paddingLeft: 8 }}>
                        {filteredUserTemplates[company].map(template => (
                          <div 
                            key={template.id}
                            style={{
                              padding: 12,
                              marginBottom: 8,
                              background: selectedTemplate === template.id 
                                ? 'rgba(115, 190, 40, 0.2)' 
                                : Colors.Background.Base.Default,
                              borderRadius: 6,
                              border: `1px solid ${
                                selectedTemplate === template.id 
                                  ? Colors.Theme.Success['70'] 
                                  : Colors.Border.Neutral.Default
                              }`,
                              cursor: 'pointer',
                              transition: 'all 0.2s ease'
                            }}
                            onClick={() => loadTemplate(template.id)}
                          >
                            <Flex alignItems="flex-start" gap={8}>
                              <div style={{ fontSize: 16, marginTop: 2 }}>
                                {selectedTemplate === template.id ? '✅' : '📄'}
                              </div>
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <Strong style={{ 
                                  fontSize: 13, 
                                  display: 'block',
                                  marginBottom: 4,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}>
                                  {template.name}
                                </Strong>
                                <Paragraph style={{ 
                                  fontSize: 11, 
                                  marginBottom: 4,
                                  opacity: 0.7,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap'
                                }}>
                                  {template.domain}
                                </Paragraph>
                                <Paragraph style={{ fontSize: 10, marginBottom: 0, opacity: 0.5 }}>
                                  {new Date(template.createdAt).toLocaleDateString()}
                                </Paragraph>
                              </div>
                            </Flex>
                            
                            {/* Action Buttons */}
                            <Flex gap={4} style={{ marginTop: 8 }}>
                              <Button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  loadTemplate(template.id);
                                }}
                                style={{ flex: 1, fontSize: 11, padding: '6px' }}
                              >
                                📂 Load
                              </Button>
                              <Button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  exportTemplate(template.id);
                                }}
                                style={{ flex: 1, fontSize: 11, padding: '6px' }}
                              >
                                📤 Export
                              </Button>
                              <Button 
                                onClick={(e) => {
                                  e.stopPropagation();
                                  deleteTemplate(template.id);
                                }}
                                style={{ fontSize: 11, padding: '6px' }}
                              >
                                🗑️
                              </Button>
                            </Flex>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
        {/* vCarb Demo Section */}
        <div style={{ marginBottom: 16 }}>
          <div 
            onClick={() => toggleSection('vcarbDemo')}
            style={{
              padding: 14,
              background: 'linear-gradient(135deg, rgba(225, 6, 0, 0.25), rgba(30, 144, 255, 0.15))',
              borderRadius: 10,
              border: '2px solid rgba(225, 6, 0, 0.6)',
              cursor: 'pointer',
              marginBottom: 12,
              boxShadow: '0 2px 8px rgba(225, 6, 0, 0.2)'
            }}
          >
            <Flex justifyContent="space-between" alignItems="center">
              <Flex alignItems="center" gap={12}>
                <div style={{ fontSize: 20 }}>{expandedSections.vcarbDemo ? '📂' : '📁'}</div>
                <div>
                  <Strong style={{ fontSize: 15, display: 'block' }}>🏎️ vCarb Demo</Strong>
                  <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 2, opacity: 0.8 }}>
                    F1 Race Weekend Operations demo
                  </Paragraph>
                </div>
              </Flex>
              <div style={{
                background: 'rgba(225, 6, 0, 0.8)',
                color: 'white',
                padding: '4px 12px',
                borderRadius: 14,
                fontSize: 12,
                fontWeight: 700
              }}>
                1
              </div>
            </Flex>
          </div>

          {expandedSections.vcarbDemo && (
            <div style={{ paddingLeft: 8 }}>
              <div style={{
                padding: 16,
                background: 'linear-gradient(135deg, rgba(225, 6, 0, 0.08), rgba(30, 144, 255, 0.08))',
                borderRadius: 10,
                border: '1px solid rgba(225, 6, 0, 0.3)',
                marginBottom: 12
              }}>
                <Flex alignItems="center" gap={12} style={{ marginBottom: 12 }}>
                  <img
                    src={VCARB_CAR}
                    alt="VCARB Race Car"
                    style={{
                      height: 48, borderRadius: 8, objectFit: 'cover',
                      border: '2px solid rgba(225,6,0,0.4)',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                    }}
                  />
                  <div>
                    <Strong style={{ fontSize: 14, display: 'block' }}>VCARB Race Weekend</Strong>
                    <Paragraph style={{ fontSize: 11, marginBottom: 0, opacity: 0.7 }}>
                      Simulate a full F1 race weekend with telemetry, pit stops, and strategy
                    </Paragraph>
                  </div>
                </Flex>
                <Flex gap={8}>
                  <button
                    onClick={startVcarbRace}
                    disabled={isStartingRace}
                    style={{
                      flex: 1, padding: '10px 16px', borderRadius: 8, border: 'none',
                      background: isStartingRace ? 'rgba(225,6,0,0.4)' : 'linear-gradient(135deg, #e10600, #ff4136)',
                      color: 'white', fontWeight: 700, fontSize: 13,
                      cursor: isStartingRace ? 'wait' : 'pointer',
                      transition: 'all 0.2s ease',
                      boxShadow: '0 2px 8px rgba(225,6,0,0.3)',
                    }}
                    onMouseOver={e => { if (!isStartingRace) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 4px 12px rgba(225,6,0,0.4)'; } }}
                    onMouseOut={e => { e.currentTarget.style.transform = 'none'; e.currentTarget.style.boxShadow = '0 2px 8px rgba(225,6,0,0.3)'; }}
                  >
                    {isStartingRace ? '🏁 Starting...' : '🏎️ Start the Race'}
                  </button>
                  <Link to="/vcarb" style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '10px 16px', borderRadius: 8,
                    textDecoration: 'none',
                    background: 'rgba(30,144,255,0.1)',
                    border: '1px solid rgba(30,144,255,0.4)',
                    color: '#1e90ff', fontWeight: 600, fontSize: 13,
                    transition: 'all 0.2s ease',
                  }}>
                    🏎️ Race Hub
                  </Link>
                </Flex>
                {raceStatus && (
                  <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(225,6,0,0.1)', border: '1px solid rgba(225,6,0,0.3)', fontSize: 12, fontFamily: 'monospace' }}>
                    {raceStatus}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  const renderWelcomeTab = () => (
    <Flex flexDirection="column" gap={20}>
      <Flex flexDirection="row" gap={20}>
        {/* Left Column: App Overview */}
        <div style={{ flex: 1, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 8 }}>
          <Heading level={3} style={{ marginBottom: 12 }}>🚀 Bridge the Gap Between IT and Business</Heading>
          <Paragraph style={{ marginBottom: 12, fontSize: 14, lineHeight: 1.6 }}>
            <Strong style={{ color: Colors.Theme.Primary['70'] }}>Business Observability Demonstrator</Strong> uses AI to instantly generate realistic, 
            end-to-end customer journey simulations — giving your team a powerful way to showcase how Dynatrace connects 
            <Strong> technical performance</Strong> to <Strong>real business outcomes</Strong>.
          </Paragraph>
          
          <div style={{ background: 'rgba(108, 44, 156, 0.2)', padding: 16, borderRadius: 8, border: '1px solid rgba(108, 44, 156, 0.6)' }}>
            <Heading level={5} style={{ marginBottom: 10, color: Colors.Theme.Primary['70'] }}>✨ What Makes This Different</Heading>
            <ul style={{ fontSize: 13, lineHeight: 1.8, color: Colors.Text.Neutral.Default, margin: 0, paddingLeft: 20 }}>
              <li><Strong>AI-Powered in Seconds:</Strong> Enter any company — AI builds a complete journey with services, revenue data, and KPIs</li>
              <li><Strong>Business Context Built-In:</Strong> Every journey includes conversion funnels, revenue impact, and C-Suite metrics</li>
              <li><Strong>Any Industry, Any Customer:</Strong> Works for retail, banking, healthcare, travel, SaaS — you name it</li>
              <li><Strong>Ready to Demo:</Strong> Realistic traffic simulation with full Dynatrace correlation out of the box</li>
            </ul>
          </div>
        </div>

        {/* Right Column: Why It Matters */}
        <div style={{ flex: 1, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 8 }}>
          <Heading level={3} style={{ marginBottom: 12 }}>💡 Why Business Observability?</Heading>
          
          <Flex flexDirection="column" gap={12}>
            <div style={{ background: 'rgba(115, 190, 40, 0.2)', padding: 14, borderRadius: 8, border: '1px solid rgba(115, 190, 40, 0.6)' }}>
              <Heading level={5} style={{ marginBottom: 6 }}>📈 Speak the Language of Revenue</Heading>
              <Paragraph style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 0 }}>
                Show stakeholders how slow page loads, failed payments, or API errors translate directly into lost revenue and abandoned customers.
              </Paragraph>
            </div>

            <div style={{ background: 'rgba(0, 161, 201, 0.2)', padding: 14, borderRadius: 8, border: '1px solid rgba(0, 161, 201, 0.6)' }}>
              <Heading level={5} style={{ marginBottom: 6 }}>🎯 Tailored to Every Prospect</Heading>
              <Paragraph style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 0 }}>
                Walk into any meeting with a bespoke demo — AI generates journeys specific to the prospect's industry, brand, and digital services.
              </Paragraph>
            </div>

            <div style={{ background: 'rgba(255, 210, 63, 0.2)', padding: 14, borderRadius: 8, border: '1px solid rgba(255, 210, 63, 0.6)' }}>
              <Heading level={5} style={{ marginBottom: 6 }}>⚡ From Zero to Demo in Minutes</Heading>
              <Paragraph style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 0 }}>
                No manual setup, no fake data. AI creates realistic services, user sessions, and business events — ready for a live Dynatrace walkthrough.
              </Paragraph>
            </div>
          </Flex>
        </div>
      </Flex>

      {/* ── Choose Your Pathway ───────────────── */}
      <div style={{ padding: 24, background: 'linear-gradient(135deg, rgba(0, 212, 255, 0.08), rgba(108, 44, 156, 0.08))', borderRadius: 12, border: `1px solid ${Colors.Theme.Primary['70']}` }}>
        <Heading level={3} style={{ marginBottom: 8, textAlign: 'center' }}>🚀 Choose Your Pathway</Heading>
        <Paragraph style={{ textAlign: 'center', fontSize: 13, marginBottom: 24, opacity: 0.8 }}>
          Two ways to create business observability journeys — pick the one that fits your workflow
        </Paragraph>

        <Flex gap={20}>
          {/* Pathway 1: Generate with the configured AI provider */}
          <div
            onClick={() => {
              if (ghCopilotConfigured) {
                setSelectedPathway('ai'); setActiveTab('step1');
              } else {
                setShowSettingsModal(true); setSettingsTab('ai');
              }
            }}
            style={{
              flex: 1, padding: 24, borderRadius: 16, cursor: 'pointer',
              background: ghCopilotConfigured
                ? 'linear-gradient(135deg, rgba(115,190,40,0.08), rgba(0,161,201,0.08))'
                : 'rgba(0,0,0,0.03)',
              border: ghCopilotConfigured
                ? '2px solid rgba(115,190,40,0.4)'
                : `2px dashed ${Colors.Border.Neutral.Default}`,
              boxShadow: ghCopilotConfigured ? '0 4px 16px rgba(115,190,40,0.1)' : 'none',
              transition: 'all 0.2s ease',
              opacity: ghCopilotConfigured ? 1 : 0.55,
            }}
            onMouseEnter={(e) => {
              if (ghCopilotConfigured) { e.currentTarget.style.borderColor = 'rgba(115,190,40,0.8)'; e.currentTarget.style.transform = 'translateY(-2px)'; }
              else { e.currentTarget.style.opacity = '0.7'; }
            }}
            onMouseLeave={(e) => {
              if (ghCopilotConfigured) { e.currentTarget.style.borderColor = 'rgba(115,190,40,0.4)'; e.currentTarget.style.transform = 'translateY(0)'; }
              else { e.currentTarget.style.opacity = '0.55'; }
            }}
          >
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%', margin: '0 auto 12px',
                background: ghCopilotConfigured
                  ? 'linear-gradient(135deg, rgba(115,190,40,0.2), rgba(0,161,201,0.2))'
                  : 'rgba(0,0,0,0.05)',
                border: ghCopilotConfigured
                  ? '2px solid rgba(115,190,40,0.5)'
                  : `2px solid ${Colors.Border.Neutral.Default}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32,
              }}>{ghCopilotConfigured ? '✨' : '🔒'}</div>
              <Heading level={4} style={{ marginBottom: 4 }}>Generate with AI</Heading>
              <Paragraph style={{ fontSize: 12, opacity: 0.7, marginBottom: 0 }}>
                {ghCopilotConfigured
                  ? 'Fully automated. AI generates everything'
                  : 'Requires an AI provider. Click to configure in Settings'}
              </Paragraph>
            </div>
            <Flex flexDirection="column" gap={8}>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>1️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>Enter company name &amp; domain</Paragraph>
              </Flex>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>2️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>AI generates C-Suite analysis</Paragraph>
              </Flex>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>3️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>AI generates journey config &amp; deploys</Paragraph>
              </Flex>
            </Flex>
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <div style={{
                display: 'inline-block', padding: '10px 24px', borderRadius: 10, fontWeight: 700, fontSize: 14,
                background: ghCopilotConfigured
                  ? 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,161,201,0.9))'
                  : Colors.Border.Neutral.Default,
                color: 'white',
              }}>
                {ghCopilotConfigured ? 'Start with AI →' : '🔧 Set Up AI Provider'}
              </div>
            </div>
          </div>

          {/* Pathway 2: Use the prompt templates manually */}
          <div
            onClick={() => { setSelectedPathway('manual'); setActiveTab('step1'); }}
            style={{
              flex: 1, padding: 24, borderRadius: 16, cursor: 'pointer',
              background: 'linear-gradient(135deg, rgba(108,44,156,0.08), rgba(0,161,201,0.08))',
              border: '2px solid rgba(108,44,156,0.4)',
              boxShadow: '0 4px 16px rgba(108,44,156,0.1)',
              transition: 'all 0.2s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'rgba(108,44,156,0.8)'; e.currentTarget.style.transform = 'translateY(-2px)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'rgba(108,44,156,0.4)'; e.currentTarget.style.transform = 'translateY(0)'; }}
          >
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div style={{
                width: 64, height: 64, borderRadius: '50%', margin: '0 auto 12px',
                background: 'linear-gradient(135deg, rgba(108,44,156,0.2), rgba(0,161,201,0.2))',
                border: '2px solid rgba(108,44,156,0.5)',
                display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32,
              }}>📋</div>
              <Heading level={4} style={{ marginBottom: 4 }}>Use AI Prompts Manually</Heading>
              <Paragraph style={{ fontSize: 12, opacity: 0.7, marginBottom: 0 }}>Copy prompts to your own AI: ChatGPT, Gemini, Claude etc.</Paragraph>
            </div>
            <Flex flexDirection="column" gap={8}>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>1️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>Enter company name &amp; domain</Paragraph>
              </Flex>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>2️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>Copy generated prompts to your AI tool</Paragraph>
              </Flex>
              <Flex alignItems="center" gap={8}>
                <div style={{ fontSize: 14, width: 24, textAlign: 'center' }}>3️⃣</div>
                <Paragraph style={{ fontSize: 13, marginBottom: 0 }}>Paste the AI response back &amp; generate config</Paragraph>
              </Flex>
            </Flex>
            <div style={{ marginTop: 16, textAlign: 'center' }}>
              <div style={{
                display: 'inline-block', padding: '10px 24px', borderRadius: 10, fontWeight: 700, fontSize: 14,
                background: 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))',
                color: 'white',
              }}>
                Use Your Own AI →
              </div>
            </div>
          </div>
        </Flex>
      </div>
    </Flex>
  );

  // ── "Use AI Prompts Manually" stepped flow ─────────────
  const renderOwnAiTab = () => (
    <Flex flexDirection="column" gap={20}>
      {/* Phase indicator */}
      <Flex justifyContent="center" alignItems="center" gap={0}>
        {[
          { id: 'paste' as const, label: 'Paste AI Analysis', icon: '📋', num: 1 },
          { id: 'generate' as const, label: 'Pick Journey & Generate', icon: '🚀', num: 2 },
        ].map((phase, index) => (
          <React.Fragment key={phase.id}>
            <Flex
              alignItems="center" gap={8}
              style={{
                padding: '8px 18px', borderRadius: 8,
                background: ownAiPhase === phase.id
                  ? 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.8))'
                  : 'transparent',
                opacity: ownAiPhase === phase.id ? 1 : 0.5,
                cursor: 'pointer',
              }}
              onClick={() => {
                if (phase.id === 'paste') setOwnAiPhase('paste');
                else if (phase.id === 'generate' && pastedAiResponse.length > 50 && selectedJourneyName) setOwnAiPhase('generate');
              }}
            >
              <div style={{ fontSize: 16 }}>{phase.icon}</div>
              <Strong style={{ fontSize: 13, color: ownAiPhase === phase.id ? 'white' : Colors.Text.Neutral.Default }}>
                {phase.label}
              </Strong>
            </Flex>
            {index < 1 && (
              <div style={{
                width: 40, height: 2, margin: '0 4px',
                background: ownAiPhase === 'generate'
                  ? 'rgba(108,44,156,0.7)' : Colors.Border.Neutral.Default,
              }} />
            )}
          </React.Fragment>
        ))}
      </Flex>

      {/* Phase 1: Paste AI Analysis */}
      {ownAiPhase === 'paste' && (
        <Flex gap={24}>
          <div style={{ flex: 3, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Flex alignItems="center" gap={12} style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 28 }}>📋</div>
              <div>
                <Heading level={3} style={{ marginBottom: 0 }}>Paste Your AI Analysis</Heading>
                <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 4, opacity: 0.7 }}>
                  Paste the C-Suite / business analysis from your AI tool below
                </Paragraph>
              </div>
            </Flex>
            <textarea
              value={pastedAiResponse}
              onChange={(e) => {
                const text = e.target.value;
                setPastedAiResponse(text);
                const journeys = extractJourneysFromText(text);
                setExtractedJourneys(journeys);
                setSelectedJourneyName(journeys[0] || '');
              }}
              placeholder={'Paste your AI response here...\n\nExample output from ChatGPT / Gemini / Claude:\n\n### 3. Journey Classification\n- **Industry Type**: Automotive Retail & Services\n- **Journey Names**:\n    - "Vehicle Purchase Journey"\n    - "Finance Application Journey"\n    - "Aftersales Purchase Journey"'}
              style={{
                width: '100%', minHeight: 280, padding: 14,
                background: Colors.Background.Base.Default,
                border: `1px solid ${Colors.Border.Neutral.Default}`,
                borderRadius: 8, color: Colors.Text.Neutral.Default,
                fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5, resize: 'vertical',
              }}
            />
            <Flex justifyContent="space-between" alignItems="center" style={{ marginTop: 16 }}>
              <Button onClick={() => setActiveTab('step1')} style={{ padding: '8px 16px' }}>← Back</Button>
              <Button
                variant="accent"
                disabled={pastedAiResponse.length < 50}
                onClick={() => setOwnAiPhase('generate')}
                style={{
                  padding: '10px 24px', fontWeight: 700, fontSize: 14, borderRadius: 10,
                  background: pastedAiResponse.length >= 50 ? 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))' : undefined,
                  color: pastedAiResponse.length >= 50 ? 'white' : undefined,
                  border: pastedAiResponse.length >= 50 ? 'none' : undefined,
                }}
              >
                Next: Pick Journey →
              </Button>
            </Flex>
          </div>
          <div style={{ flex: 2, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Heading level={4} style={{ marginBottom: 12 }}>📊 Analysis Preview</Heading>
            {pastedAiResponse.length > 50 ? (
              <Flex flexDirection="column" gap={12}>
                <div style={{ padding: 12, background: 'rgba(115,190,40,0.1)', borderRadius: 8, border: '1px solid rgba(115,190,40,0.3)' }}>
                  <Strong style={{ fontSize: 13 }}>📝 {pastedAiResponse.length.toLocaleString()} characters pasted</Strong>
                </div>
                {extractedJourneys.length > 0 && (
                  <div style={{ padding: 12, background: 'rgba(108,44,156,0.1)', borderRadius: 8, border: '1px solid rgba(108,44,156,0.3)' }}>
                    <Strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>🎯 Journeys Detected:</Strong>
                    {extractedJourneys.map((j, i) => (
                      <div key={i} style={{ fontSize: 13, padding: '4px 0', paddingLeft: 8, borderLeft: '3px solid rgba(108,44,156,0.5)' }}>
                        {j}
                      </div>
                    ))}
                  </div>
                )}
              </Flex>
            ) : (
              <Paragraph style={{ fontSize: 13, opacity: 0.5, fontStyle: 'italic' }}>
                Paste your AI analysis on the left to see a preview...
              </Paragraph>
            )}
          </div>
        </Flex>
      )}

      {/* Phase 3: Pick Journey & Generate */}
      {ownAiPhase === 'generate' && (
        <Flex gap={24}>
          <div style={{ flex: 3, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Flex alignItems="center" gap={12} style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 28 }}>🚀</div>
              <div>
                <Heading level={3} style={{ marginBottom: 0 }}>Pick Journey &amp; Generate</Heading>
                <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 4, opacity: 0.7 }}>
                  Select which journey to build, then let AI generate the full configuration
                </Paragraph>
              </div>
            </Flex>

            {/* Journey Selection */}
            <div style={{ marginBottom: 20 }}>
              <Heading level={5} style={{ marginBottom: 10 }}>🎯 Select Journey</Heading>
              {extractedJourneys.length > 0 ? (
                <Flex flexDirection="column" gap={8}>
                  {extractedJourneys.map((j, idx) => (
                    <div
                      key={idx}
                      onClick={() => setSelectedJourneyName(j)}
                      style={{
                        padding: '12px 16px', borderRadius: 10, cursor: 'pointer',
                        background: selectedJourneyName === j
                          ? 'linear-gradient(135deg, rgba(108,44,156,0.15), rgba(0,161,201,0.15))'
                          : Colors.Background.Base.Default,
                        border: `2px solid ${selectedJourneyName === j ? 'rgba(108,44,156,0.6)' : Colors.Border.Neutral.Default}`,
                        transition: 'all 0.15s ease',
                      }}
                    >
                      <Flex alignItems="center" gap={8}>
                        <div style={{
                          width: 24, height: 24, borderRadius: '50%',
                          border: `2px solid ${selectedJourneyName === j ? 'rgba(108,44,156,0.8)' : Colors.Border.Neutral.Default}`,
                          background: selectedJourneyName === j ? 'rgba(108,44,156,0.8)' : 'transparent',
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          color: 'white', fontSize: 12, fontWeight: 700,
                        }}>
                          {selectedJourneyName === j ? '✓' : ''}
                        </div>
                        <Strong style={{ fontSize: 14 }}>{j}</Strong>
                      </Flex>
                    </div>
                  ))}
                </Flex>
              ) : (
                <div style={{ padding: 14, background: 'rgba(220,180,0,0.1)', borderRadius: 8, border: '1px solid rgba(220,180,0,0.3)' }}>
                  <Paragraph style={{ fontSize: 13, marginBottom: 8 }}>
                    No journeys were auto-detected. Type a journey name:
                  </Paragraph>
                  <TextInput
                    value={selectedJourneyName}
                    onChange={(value) => setSelectedJourneyName(value)}
                    placeholder="e.g., Purchase Journey, Subscription Flow"
                    style={{ width: '100%' }}
                  />
                </div>
              )}
            </div>

            {/* Model selector + Generate button */}
            <Flex justifyContent="space-between" alignItems="center">
              <Button onClick={() => setOwnAiPhase('paste')} style={{ padding: '8px 16px' }}>← Back</Button>
              <Flex alignItems="center" gap={12}>
                {ghCopilotConfigured && (
                  <select
                    value={ghCopilotModel}
                    onChange={(e: any) => setGhCopilotModel(e.target.value)}
                    style={{
                      padding: '7px 10px', borderRadius: 6,
                      background: Colors.Background.Base.Default,
                      border: `1px solid ${Colors.Border.Neutral.Default}`,
                      color: Colors.Text.Neutral.Default, fontSize: 12,
                      cursor: 'pointer', minWidth: 140,
                    }}
                  >
                    {aiModelOptions.map(id => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </select>
                )}
                <Button
                  variant="accent"
                  disabled={!selectedJourneyName || !ghCopilotConfigured}
                  onClick={() => runPastedAiPipeline(pastedAiResponse, selectedJourneyName)}
                  title={!ghCopilotConfigured ? 'Configure an AI provider in Settings first' : `Generate "${selectedJourneyName}" journey config`}
                  style={{
                    padding: '12px 28px', fontWeight: 700, fontSize: 15, borderRadius: 10,
                    background: selectedJourneyName && ghCopilotConfigured
                      ? 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))' : undefined,
                    color: selectedJourneyName && ghCopilotConfigured ? 'white' : undefined,
                    border: selectedJourneyName && ghCopilotConfigured ? 'none' : undefined,
                    boxShadow: selectedJourneyName && ghCopilotConfigured ? '0 4px 16px rgba(108,44,156,0.3)' : undefined,
                    opacity: (!selectedJourneyName || !ghCopilotConfigured) ? 0.4 : 1,
                  }}
                >
                  🚀 Generate &amp; Deploy Journey
                </Button>
              </Flex>
            </Flex>
            {!ghCopilotConfigured && (
              <Paragraph style={{ fontSize: 12, marginTop: 12, color: 'rgba(220,50,47,0.8)' }}>
                ⚠️ Configure an AI provider in Settings → AI Provider to enable generation
              </Paragraph>
            )}
          </div>
          <div style={{ flex: 2, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Heading level={4} style={{ marginBottom: 12 }}>📋 Summary</Heading>
            <Flex flexDirection="column" gap={8}>
              <div style={{ padding: 12, background: 'rgba(0,161,201,0.1)', borderRadius: 8 }}>
                <Paragraph style={{ fontSize: 11, marginBottom: 4, opacity: 0.7 }}>Company</Paragraph>
                <Strong style={{ fontSize: 14 }}>{companyName}</Strong>
              </div>
              <div style={{ padding: 12, background: 'rgba(0,161,201,0.1)', borderRadius: 8 }}>
                <Paragraph style={{ fontSize: 11, marginBottom: 4, opacity: 0.7 }}>Domain</Paragraph>
                <Strong style={{ fontSize: 14 }}>{domain}</Strong>
              </div>
              <div style={{ padding: 12, background: 'rgba(108,44,156,0.1)', borderRadius: 8 }}>
                <Paragraph style={{ fontSize: 11, marginBottom: 4, opacity: 0.7 }}>Analysis</Paragraph>
                <Strong style={{ fontSize: 14 }}>{pastedAiResponse.length.toLocaleString()} chars · {extractedJourneys.length} journeys</Strong>
              </div>
              {selectedJourneyName && (
                <div style={{ padding: 12, background: 'rgba(115,190,40,0.1)', borderRadius: 8, border: '2px solid rgba(115,190,40,0.4)' }}>
                  <Paragraph style={{ fontSize: 11, marginBottom: 4, opacity: 0.7 }}>Selected Journey</Paragraph>
                  <Strong style={{ fontSize: 14, color: '#73be28' }}>{selectedJourneyName}</Strong>
                </div>
              )}
            </Flex>
          </div>
        </Flex>
      )}
    </Flex>
  );

  const renderStep1Tab = () => (
    <Flex flexDirection="column" gap={20}>
      <Flex gap={24} style={{ flexWrap: 'wrap', alignItems: 'stretch' }}>
        {/* Left Column: Form */}
        <div style={{ flex: '3 1 460px', minWidth: 0, padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)', boxSizing: 'border-box' }}>
          <Flex alignItems="center" gap={12} style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 28 }}>👤</div>
            <Heading level={3} style={{ marginBottom: 0 }}>Step 1 - Customer Details</Heading>
          </Flex>
          
          <Flex flexDirection="column" gap={16}>
            <div>
              <Heading level={5} style={{ marginBottom: 8 }}>🏢 Company Name</Heading>
              <TextInput 
                value={companyName}
                onChange={(value) => setCompanyName(value)}
                placeholder="e.g., ShopMart, TechCorp, HealthPlus"
                style={{ width: '100%', minWidth: 0 }}
              />
              <Paragraph style={{ fontSize: 12, marginTop: 4, opacity: 0.7, lineHeight: 1.4 }}>
                Company name for your business scenario
              </Paragraph>
            </div>

            <div>
              <Heading level={5} style={{ marginBottom: 8 }}>🌐 Website Domain</Heading>
              <TextInput 
                value={domain}
                onChange={(value) => setDomain(value)}
                placeholder="e.g., shopmart.com, techcorp.io"
                style={{ width: '100%', minWidth: 0 }}
              />
              <Paragraph style={{ fontSize: 12, marginTop: 4, opacity: 0.7, lineHeight: 1.4 }}>
                Domain for the customer journey simulation
              </Paragraph>
            </div>

            <div>
              <Heading level={5} style={{ marginBottom: 8 }}>🎯 Journey Requirements</Heading>
              <textarea 
                value={requirements}
                onChange={(e) => setRequirements(e.target.value)}
                placeholder="e.g., Order journey from website to delivery, Banking loan application process"
                style={{ 
                  width: '100%', 
                  boxSizing: 'border-box',
                  minHeight: 80,
                  padding: 12,
                  background: Colors.Background.Base.Default,
                  border: `1px solid ${Colors.Border.Neutral.Default}`,
                  borderRadius: 4,
                  color: Colors.Text.Neutral.Default,
                  fontFamily: 'inherit',
                  fontSize: 13,
                  lineHeight: 1.5,
                  resize: 'vertical'
                }}
              />
              <Paragraph style={{ fontSize: 11, marginTop: 6, opacity: 0.6, lineHeight: 1.4, fontStyle: 'italic' }}>
                💡 Leave blank and AI will analyse the company then suggest journeys for you to choose from
              </Paragraph>
            </div>

            <Flex justifyContent="space-between" alignItems="center" gap={12} style={{ marginTop: 16 }}>
              <Button onClick={() => setActiveTab('welcome')} style={{ padding: '8px 16px' }}>
                ← Back
              </Button>
              <Flex alignItems="center" gap={12}>
                {/* Model dropdown — only shown for AI pathway when PAT is configured */}
                {selectedPathway === 'ai' && ghCopilotConfigured && (
                  <select
                    value={ghCopilotModel}
                    onChange={(e: any) => setGhCopilotModel(e.target.value)}
                    style={{
                      padding: '7px 10px', borderRadius: 6,
                      background: Colors.Background.Base.Default,
                      border: `1px solid ${Colors.Border.Neutral.Default}`,
                      color: Colors.Text.Neutral.Default, fontSize: 12,
                      cursor: 'pointer', minWidth: 140,
                    }}
                  >
                    {aiModelOptions.map(id => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </select>
                )}
                {/* Generate with AI button — AI pathway only */}
                {selectedPathway === 'ai' && (
                <Button
                  variant="accent"
                  disabled={!companyName || !domain || !ghCopilotConfigured || ghGeneratingAll}
                  onClick={() => runAiGenerationPipeline()}
                  title={!ghCopilotConfigured ? 'Configure an AI provider in Settings → AI Provider first' : `Generate, validate & deploy with AI using ${ghCopilotModel}`}
                  style={{
                    padding: '10px 24px', opacity: !ghCopilotConfigured ? 0.4 : 1,
                    fontWeight: 700, fontSize: 14,
                    background: ghCopilotConfigured ? 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,161,201,0.9))' : undefined,
                    color: ghCopilotConfigured ? 'white' : undefined,
                    border: ghCopilotConfigured ? 'none' : undefined,
                    borderRadius: 10,
                    boxShadow: ghCopilotConfigured ? '0 4px 16px rgba(115,190,40,0.3)' : undefined,
                  }}
                >
                  ✨ Generate with AI
                </Button>
                )}
                {/* Manual pathway: show "Next: Generate Prompts →" instead */}
                {selectedPathway === 'manual' && (
                  <Button 
                    color="primary"
                    variant="emphasized"
                    onClick={() => { setStep2Phase('prompts'); setActiveTab('step2'); }}
                    disabled={!companyName || !domain}
                    style={{ padding: '8px 20px' }}
                  >
                    Next: Generate Prompts →
                  </Button>
                )}
              </Flex>
            </Flex>
          </Flex>
        </div>

        {/* Right Column: Instructions & Stats */}
        <div style={{ flex: '2 1 320px', minWidth: 0 }}>
          <div style={{ 
            padding: 20, 
            background: `linear-gradient(135deg, ${Colors.Background.Surface.Default}, rgba(0, 161, 201, 0.05))`,
            borderRadius: 12,
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
            marginBottom: 16
          }}>
            <Heading level={4} style={{ marginBottom: 16 }}>📊 Template Statistics</Heading>
            <Flex gap={12}>
              <div style={{ 
                flex: 1,
                padding: 16,
                background: 'linear-gradient(135deg, rgba(108, 44, 156, 0.2), rgba(108, 44, 156, 0.1))',
                borderRadius: 10,
                textAlign: 'center',
                border: '2px solid rgba(108, 44, 156, 0.4)'
              }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: Colors.Theme.Primary['70'] }}>{savedTemplates.length}</div>
                <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 4 }}>Saved Templates</Paragraph>
              </div>
              <div style={{ 
                flex: 1,
                padding: 16,
                background: 'linear-gradient(135deg, rgba(115, 190, 40, 0.2), rgba(115, 190, 40, 0.1))',
                borderRadius: 10,
                textAlign: 'center',
                border: '2px solid rgba(115, 190, 40, 0.4)'
              }}>
                <div style={{ fontSize: 28, fontWeight: 700, color: Colors.Theme.Success['70'] }}>{companyName && domain ? '✓' : '○'}</div>
                <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 4 }}>Form Complete</Paragraph>
              </div>
            </Flex>
          </div>

          <div style={{ padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
            <Heading level={4} style={{ marginBottom: 12 }}>📋 What We'll Create</Heading>
            <Flex flexDirection="column" gap={12}>
              <div style={{ padding: 14, background: 'rgba(0, 161, 201, 0.15)', borderRadius: 8, border: '2px solid rgba(0, 161, 201, 0.5)' }}>
                <Flex alignItems="center" gap={8} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 20 }}>🤖</div>
                  <Heading level={5} style={{ marginBottom: 0 }}>AI-Generated Journey</Heading>
                </Flex>
                <ul style={{ fontSize: 13, lineHeight: 1.6, margin: 0, paddingLeft: 20 }}>
                  <li>Realistic customer interaction patterns</li>
                  <li>Business intelligence & revenue metrics</li>
                  <li>Industry-specific journey steps</li>
                  <li>Performance testing configurations</li>
                </ul>
              </div>

              <div style={{ padding: 14, background: 'rgba(255, 210, 63, 0.15)', borderRadius: 8, border: '2px solid rgba(255, 210, 63, 0.5)' }}>
                <Flex alignItems="center" gap={8} style={{ marginBottom: 8 }}>
                  <div style={{ fontSize: 20 }}>🚀</div>
                  <Heading level={5} style={{ marginBottom: 0 }}>Next Steps</Heading>
                </Flex>
                <Paragraph style={{ fontSize: 13, lineHeight: 1.5, marginBottom: 0 }}>
                  Generate tailored AI prompts to create realistic business scenarios.
                </Paragraph>
              </div>
            </Flex>
          </div>
        </div>
      </Flex>
    </Flex>
  );

  const step2Phases = [
    { key: 'prompts' as const, label: 'Copy Prompts', icon: '📝', number: 1 },
    { key: 'response' as const, label: 'Paste Response', icon: '📥', number: 2 },
    { key: 'generate' as const, label: 'Generate Services', icon: '🚀', number: 3 },
  ];

  const step2PhaseIndex = step2Phases.findIndex(p => p.key === step2Phase);

  const renderStep2Tab = () => (
    <Flex flexDirection="column" gap={16}>
      <div style={{ padding: 20, background: Colors.Background.Surface.Default, borderRadius: 12, boxShadow: '0 2px 8px rgba(0,0,0,0.1)' }}>
        {/* Header */}
        <Flex alignItems="center" gap={12} style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 28 }}>🤖</div>
          <div style={{ flex: 1 }}>
            <Heading level={3} style={{ marginBottom: 0 }}>Step 2 — AI Prompt Generation</Heading>
            <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 2, opacity: 0.7 }}>
              {companyName} • {domain}
            </Paragraph>
          </div>
        </Flex>

        {/* ── Sub-step progress bar ─── */}
        <Flex gap={0} style={{ marginBottom: 24 }}>
          {step2Phases.map((phase, idx) => {
            const isActive = phase.key === step2Phase;
            const isCompleted = idx < step2PhaseIndex;
            const isClickable = idx <= step2PhaseIndex || (idx === step2PhaseIndex + 1);
            return (
              <div
                key={phase.key}
                onClick={() => isClickable && setStep2Phase(phase.key)}
                style={{
                  flex: 1,
                  padding: '12px 16px',
                  cursor: isClickable ? 'pointer' : 'default',
                  background: isActive
                    ? 'linear-gradient(135deg, rgba(108,44,156,0.2), rgba(0,212,255,0.15))'
                    : isCompleted
                    ? 'rgba(115,190,40,0.1)'
                    : 'rgba(0,0,0,0.02)',
                  borderBottom: isActive ? '3px solid #6c2c9c' : isCompleted ? '3px solid rgba(115,190,40,0.5)' : '3px solid transparent',
                  borderRadius: idx === 0 ? '10px 0 0 0' : idx === step2Phases.length - 1 ? '0 10px 0 0' : 0,
                  transition: 'all 0.2s ease',
                  opacity: (!isActive && !isCompleted && !isClickable) ? 0.4 : 1,
                }}
              >
                <Flex alignItems="center" gap={8}>
                  <div style={{
                    width: 28, height: 28, borderRadius: '50%',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 13, fontWeight: 700,
                    background: isCompleted ? Colors.Theme.Success['70'] : isActive ? '#6c2c9c' : 'rgba(0,0,0,0.1)',
                    color: (isCompleted || isActive) ? 'white' : Colors.Text.Neutral.Default,
                  }}>
                    {isCompleted ? '✓' : phase.number}
                  </div>
                  <div>
                    <Strong style={{ fontSize: 13 }}>{phase.label}</Strong>
                  </div>
                </Flex>
              </div>
            );
          })}
        </Flex>

        {/* ════════ SUB-STEP 1: Copy Prompts ════════ */}
        {step2Phase === 'prompts' && (
          <div>
            <Paragraph style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
              Copy each prompt below into an <Strong>external AI assistant</Strong> (e.g. ChatGPT, Gemini, or Microsoft Copilot — <em>not</em> Dynatrace Copilot). Run Prompt 1 first, then Prompt 2 in the <Strong>same conversation</Strong>.
              {ghCopilotConfigured && <> Or use <Strong>✨ Generate with AI</Strong> to run them directly using your configured AI provider.</>}
            </Paragraph>

            {/* AI provider not configured banner */}
            {!ghCopilotConfigured && !ghCopilotChecking && (
              <div style={{
                padding: 10, marginBottom: 12, borderRadius: 8,
                background: 'rgba(0,161,201,0.06)', border: '1px solid rgba(0,161,201,0.2)',
                cursor: 'pointer',
              }} onClick={() => { setShowSettingsModal(true); setSettingsTab('ai'); }}>
                <Flex alignItems="center" gap={8}>
                  <span style={{ fontSize: 16 }}>💡</span>
                  <Paragraph style={{ fontSize: 12, marginBottom: 0, lineHeight: 1.4 }}>
                    <Strong>Tip:</Strong> Add an AI provider key in <Strong>Settings → AI Provider</Strong> to generate AI responses directly in the app, with no copy/paste needed.
                  </Paragraph>
                </Flex>
              </div>
            )}

            {/* Prompt 1 */}
            <div style={{
              marginBottom: 16, padding: 16,
              background: 'linear-gradient(135deg, rgba(0,161,201,0.08), rgba(0,161,201,0.03))',
              borderRadius: 10, border: '2px solid rgba(0,161,201,0.4)',
              overflow: 'hidden',
            }}>
              <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                <Flex alignItems="center" gap={8} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 18 }}>💼</div>
                  <Strong style={{ fontSize: 14 }}>Prompt 1 — C-suite Analysis</Strong>
                </Flex>
                <Flex gap={8} style={{ flexWrap: 'wrap' }}>
                  <Button onClick={() => copyToClipboard(prompt1, 'Prompt 1')} variant="emphasized">📋 Copy</Button>
                  <Button
                    disabled={!ghCopilotConfigured || ghGenerating1}
                    variant="accent"
                    onClick={async () => {
                      setGhGenerating1(true);
                      setGhResult1('');
                      try {
                        const res = await callDynatraceAssistGenerateWithBackoff(
                          prompt1,
                          undefined,
                          'C-Suite generation'
                        );
                        if (res.success) {
                          setGhResult1(res.data.content);
                          showToast(`✅ C-suite analysis generated (${res.data.model})`, 'success');
                        } else {
                          setGhResult1('');
                          if (res.code === 'NO_CREDENTIAL') {
                            setShowSettingsModal(true);
                            setSettingsTab('ai');
                          }
                          showToast(`❌ ${res.error}`, 'error', 6000);
                        }
                      } catch (err: any) {
                        showToast(`❌ ${err.message}`, 'error');
                      }
                      setGhGenerating1(false);
                    }}
                    title={!ghCopilotConfigured ? 'Configure an AI provider in Settings → AI Provider first' : 'Generate with your configured AI provider'}
                    style={{ opacity: !ghCopilotConfigured ? 0.5 : 1 }}
                  >
                    {ghGenerating1 ? '⏳ Generating...' : '✨ Generate with AI'}
                  </Button>
                </Flex>
              </Flex>
              <Paragraph style={{ fontSize: 12, marginBottom: 8, opacity: 0.8, padding: '6px 10px', background: 'rgba(0,161,201,0.12)', borderRadius: 6 }}>
                {PROMPT_DESCRIPTIONS.csuite.description}
              </Paragraph>
              <textarea
                readOnly value={prompt1}
                style={{
                  width: '100%', height: 130, padding: 12,
                  boxSizing: 'border-box',
                  background: Colors.Background.Base.Default,
                  border: '1px solid rgba(0,161,201,0.4)', borderRadius: 8,
                  color: Colors.Text.Neutral.Default, fontFamily: 'monospace', fontSize: 12,
                  resize: 'vertical', lineHeight: 1.5,
                }}
              />
              {/* AI Generated Result */}
              {ghResult1 && (
                <div style={{ marginTop: 12 }}>
                  <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
                    <Flex alignItems="center" gap={6} style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 14 }}>🤖</span>
                      <Strong style={{ fontSize: 12, color: 'rgba(115,190,40,0.9)' }}>AI-Generated Response</Strong>
                    </Flex>
                    <Button onClick={() => copyToClipboard(ghResult1, 'AI Response 1')} variant="default" style={{ fontSize: 11 }}>📋 Copy Result</Button>
                  </Flex>
                  <textarea
                    readOnly value={ghResult1}
                    style={{
                      width: '100%', height: 200, padding: 12,
                      boxSizing: 'border-box',
                      background: 'rgba(115,190,40,0.04)',
                      border: '1px solid rgba(115,190,40,0.3)', borderRadius: 8,
                      color: Colors.Text.Neutral.Default, fontFamily: 'monospace', fontSize: 12,
                      resize: 'vertical', lineHeight: 1.5,
                    }}
                  />
                </div>
              )}
            </div>

            {/* Prompt 2 */}
            <div style={{
              marginBottom: 16, padding: 16,
              background: 'linear-gradient(135deg, rgba(108,44,156,0.08), rgba(108,44,156,0.03))',
              borderRadius: 10, border: '2px solid rgba(108,44,156,0.4)',
              overflow: 'hidden',
            }}>
              <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 8, flexWrap: 'wrap', gap: 8 }}>
                <Flex alignItems="center" gap={8} style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 18 }}>🗺️</div>
                  <Strong style={{ fontSize: 14 }}>Prompt 2 — Customer Journey</Strong>
                </Flex>
                <Flex gap={8} style={{ flexWrap: 'wrap' }}>
                  <Button onClick={() => copyToClipboard(prompt2, 'Prompt 2')} variant="emphasized">📋 Copy</Button>
                  <Button
                    disabled={!ghCopilotConfigured || ghGenerating2}
                    variant="accent"
                    onClick={async () => {
                      setGhGenerating2(true);
                      setGhResult2('');
                      try {
                        // Include the C-suite result as context so Prompt 2 builds on Prompt 1
                        const contextPrefix = ghResult1 ? `Here is the C-suite analysis from the previous step:\n\n${ghResult1}\n\nNow, based on that context:\n\n` : '';
                        const res = await callGithubCopilotGenerateWithBackoff(
                          contextPrefix + prompt2,
                          'gpt-4.1',
                          undefined,
                          'Journey generation'
                        );
                        if (res.success) {
                          setGhResult2(res.data.content);
                          showToast(`✅ Journey config generated (${res.data.model})`, 'success');
                        } else {
                          setGhResult2('');
                          if (res.code === 'NO_CREDENTIAL') {
                            setShowSettingsModal(true);
                            setSettingsTab('ai');
                          }
                          showToast(`❌ ${res.error}`, 'error', 6000);
                        }
                      } catch (err: any) {
                        showToast(`❌ ${err.message}`, 'error');
                      }
                      setGhGenerating2(false);
                    }}
                    title={!ghCopilotConfigured ? 'Configure an AI provider in Settings → AI Provider first' : 'Generate with your configured AI provider'}
                    style={{ opacity: !ghCopilotConfigured ? 0.5 : 1 }}
                  >
                    {ghGenerating2 ? '⏳ Generating...' : '✨ Generate with AI'}
                  </Button>
                </Flex>
              </Flex>
              <Paragraph style={{ fontSize: 12, marginBottom: 8, opacity: 0.8, padding: '6px 10px', background: 'rgba(108,44,156,0.12)', borderRadius: 6 }}>
                {PROMPT_DESCRIPTIONS.journey.description}
              </Paragraph>
              <textarea
                readOnly value={prompt2}
                style={{
                  width: '100%', height: 130, padding: 12,
                  boxSizing: 'border-box',
                  background: Colors.Background.Base.Default,
                  border: '1px solid rgba(108,44,156,0.4)', borderRadius: 8,
                  color: Colors.Text.Neutral.Default, fontFamily: 'monospace', fontSize: 12,
                  resize: 'vertical', lineHeight: 1.5,
                }}
              />
              {/* AI Generated Result */}
              {ghResult2 && (
                <div style={{ marginTop: 12 }}>
                  <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 6, flexWrap: 'wrap', gap: 8 }}>
                    <Flex alignItems="center" gap={6} style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 14 }}>🤖</span>
                      <Strong style={{ fontSize: 12, color: 'rgba(115,190,40,0.9)' }}>AI-Generated Response</Strong>
                    </Flex>
                    <Flex gap={8} style={{ flexWrap: 'wrap' }}>
                      <Button onClick={() => copyToClipboard(ghResult2, 'AI Response 2')} variant="default" style={{ fontSize: 11 }}>📋 Copy Result</Button>
                      <Button
                        variant="emphasized"
                        style={{ fontSize: 11 }}
                        onClick={() => {
                          // Strip markdown code fences if present
                          let cleanJson = ghResult2.trim();
                          if (cleanJson.startsWith('```')) {
                            cleanJson = cleanJson.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
                          }
                          setCopilotResponse(cleanJson);
                          setStep2Phase('response');
                          showToast('✅ AI response loaded into paste area — click Validate', 'success');
                        }}
                      >
                        📥 Use as Journey Response
                      </Button>
                    </Flex>
                  </Flex>
                  <textarea
                    readOnly value={ghResult2}
                    style={{
                      width: '100%', height: 200, padding: 12,
                      boxSizing: 'border-box',
                      background: 'rgba(115,190,40,0.04)',
                      border: '1px solid rgba(115,190,40,0.3)', borderRadius: 8,
                      color: Colors.Text.Neutral.Default, fontFamily: 'monospace', fontSize: 12,
                      resize: 'vertical', lineHeight: 1.5,
                    }}
                  />
                </div>
              )}
            </div>

            <Flex justifyContent="space-between" style={{ marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
              <Button onClick={() => setActiveTab('step1')}>← Back to Details</Button>
              <Button variant="emphasized" onClick={() => setStep2Phase('response')} style={{ padding: '10px 24px', fontWeight: 600 }}>
                Continue to Paste Response →
              </Button>
            </Flex>
          </div>
        )}

        {/* ════════ SUB-STEP 2: Paste Response ════════ */}
        {step2Phase === 'response' && (
          <div>
            <Paragraph style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
              Paste the <Strong>JSON response</Strong> from your AI assistant below, then click <Strong>Validate</Strong> to check the format.
            </Paragraph>

            <div style={{
              padding: 16, borderRadius: 10,
              border: `2px solid ${copilotResponse.trim() ? Colors.Theme.Success['70'] : Colors.Border.Neutral.Default}`,
              background: Colors.Background.Surface.Default,
              boxShadow: copilotResponse.trim() ? '0 2px 8px rgba(115,190,40,0.15)' : 'none',
            }}>
              <Flex alignItems="center" gap={8} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 16 }}>{copilotResponse.trim() ? '✅' : '📝'}</div>
                <Strong style={{ fontSize: 13 }}>
                  {copilotResponse.trim() ? 'Response Received' : 'Awaiting Response'}
                </Strong>
                {copilotResponse.trim() && (
                  <Button onClick={() => setCopilotResponse('')} style={{ marginLeft: 'auto', fontSize: 11, padding: '2px 8px' }}>🗑️ Clear</Button>
                )}
              </Flex>
              <textarea
                value={copilotResponse}
                onChange={(e) => setCopilotResponse(e.target.value)}
                placeholder="Paste the JSON response from the AI assistant here..."
                style={{
                  width: '100%', height: 260, padding: 16,
                  boxSizing: 'border-box',
                  background: Colors.Background.Base.Default,
                  border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 8,
                  color: Colors.Text.Neutral.Default, fontFamily: 'monospace', fontSize: 12,
                  resize: 'vertical', lineHeight: 1.5,
                }}
              />

              {generationStatus && (
                <div style={{
                  marginTop: 10, padding: 10, borderRadius: 6, fontSize: 13, fontFamily: 'monospace',
                  background: generationStatus.includes('✅') ? 'rgba(115,190,40,0.1)' : generationStatus.includes('❌') ? 'rgba(220,50,47,0.1)' : 'rgba(0,161,201,0.1)',
                  border: `1px solid ${generationStatus.includes('✅') ? Colors.Theme.Success['70'] : generationStatus.includes('❌') ? '#dc322f' : Colors.Theme.Primary['70']}`,
                }}>
                  {generationStatus}
                </div>
              )}
            </div>

            <Flex justifyContent="space-between" style={{ marginTop: 16, flexWrap: 'wrap', gap: 8 }}>
              <Button onClick={() => setStep2Phase('prompts')}>← Back to Prompts</Button>
              <Flex gap={8} style={{ flexWrap: 'wrap' }}>
                <Button variant="emphasized" onClick={processResponse} disabled={!copilotResponse.trim()} style={{ padding: '10px 20px', fontWeight: 600 }}>
                  ⚡ Validate Response
                </Button>
                <Button onClick={() => setStep2Phase('generate')} disabled={!copilotResponse.trim()} style={{ padding: '10px 24px', fontWeight: 600 }}>
                  Continue to Generate →
                </Button>
              </Flex>
            </Flex>
          </div>
        )}

        {/* ════════ SUB-STEP 3: Generate Services ════════ */}
        {step2Phase === 'generate' && (
          <div>
            <Paragraph style={{ fontSize: 13, marginBottom: 16, lineHeight: 1.6 }}>
              Everything is ready. Click <Strong>Generate Services</Strong> to create live services on your configured host.
            </Paragraph>

            {/* Summary card */}
            <div style={{
              padding: 16, marginBottom: 20, borderRadius: 10,
              background: 'linear-gradient(135deg, rgba(115,190,40,0.1), rgba(0,212,255,0.08))',
              border: `1px solid ${Colors.Theme.Success['70']}`,
            }}>
              <Flex gap={20}>
                <div>
                  <Strong style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase' as const }}>Company</Strong>
                  <Paragraph style={{ fontSize: 14, marginBottom: 0, marginTop: 2 }}>{companyName}</Paragraph>
                </div>
                <div>
                  <Strong style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase' as const }}>Domain</Strong>
                  <Paragraph style={{ fontSize: 14, marginBottom: 0, marginTop: 2 }}>{domain}</Paragraph>
                </div>
                <div>
                  <Strong style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase' as const }}>Target</Strong>
                  <Paragraph style={{ fontSize: 14, marginBottom: 0, marginTop: 2 }}>{apiSettings.host}:{apiSettings.port}</Paragraph>
                </div>
                <div>
                  <Strong style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase' as const }}>Response</Strong>
                  <Paragraph style={{ fontSize: 14, marginBottom: 0, marginTop: 2, color: Colors.Theme.Success['70'] }}>✓ Pasted</Paragraph>
                </div>
              </Flex>
            </div>

            <Flex justifyContent="center" style={{ marginBottom: 16 }}>
              <Button
                onClick={generateServices}
                disabled={!copilotResponse.trim() || isGeneratingServices}
                style={{
                  padding: '14px 40px', fontWeight: 700, fontSize: 15,
                  background: isGeneratingServices ? 'rgba(0,161,201,0.2)' : 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,161,201,0.9))',
                  color: 'white', borderRadius: 10, border: 'none',
                }}
              >
                {isGeneratingServices ? '🔄 Generating...' : '🚀 Generate Services'}
              </Button>
            </Flex>

            {generationStatus && (
              <div style={{
                padding: 12, borderRadius: 8, fontSize: 13, fontFamily: 'monospace', textAlign: 'center' as const,
                background: generationStatus.includes('✅') ? 'rgba(115,190,40,0.1)' : generationStatus.includes('❌') ? 'rgba(220,50,47,0.1)' : 'rgba(0,161,201,0.1)',
                border: `1px solid ${generationStatus.includes('✅') ? Colors.Theme.Success['70'] : generationStatus.includes('❌') ? '#dc322f' : Colors.Theme.Primary['70']}`,
              }}>
                {generationStatus}
              </div>
            )}

            <Flex justifyContent="space-between" style={{ marginTop: 20 }}>
              <Button onClick={() => setStep2Phase('response')}>← Back to Response</Button>
              <Button onClick={openSettingsModal}>⚙️ API Settings</Button>
            </Flex>
          </div>
        )}
      </div>
    </Flex>
  );

  return (
    <Page>
      <Page.Header>
        <TitleBar>
          <TitleBar.Title>
            <Flex alignItems="center" gap={8}>
              <img src={DEMONSTRATOR_LOGO} alt="BizObs Demonstrator" style={{ width: 32, height: 32, borderRadius: 6 }} />
              <span style={{ background: 'linear-gradient(135deg, #6c2c9c, #00d4ff)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', fontWeight: 700 }}>
                Business Observability Demonstrator
              </span>
            </Flex>
          </TitleBar.Title>
          <TitleBar.Subtitle>
            <span>AI-powered journey simulation &amp; observability — built on </span>
            <span style={{ fontWeight: 700 }}>Dynatrace SaaS</span>
            <span>, </span>
            <span style={{ fontWeight: 700 }}>Grail</span>
            <span>, </span>
            <span style={{ fontWeight: 700 }}>DPS</span>
            <span> &amp; </span>
            <span style={{ fontWeight: 700 }}>Dynatrace Intelligence</span>
          </TitleBar.Subtitle>
          <TitleBar.Action>
            <Flex gap={8} alignItems="center">
              {/* Connection Status Indicator — always visible */}
              {(() => {
                const isConnected = connectionTestedOk || builtinSettingsDetected['test-connection'];
                const hasIp = apiSettings.host && apiSettings.host !== 'localhost' && apiSettings.host !== '';
                return (
                  <div
                    onClick={openSettingsModal}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 6,
                      minHeight: 36,
                      padding: '7px 12px', borderRadius: 12,
                      background: isConnected
                        ? 'linear-gradient(135deg, rgba(0,180,0,0.10), rgba(115,190,40,0.06))'
                        : hasIp
                          ? 'linear-gradient(135deg, rgba(220,160,0,0.10), rgba(220,160,0,0.05))'
                          : 'linear-gradient(135deg, rgba(120,120,120,0.10), rgba(120,120,120,0.05))',
                      border: isConnected
                        ? '1px solid rgba(0,180,0,0.35)'
                        : hasIp
                          ? '1px solid rgba(220,160,0,0.35)'
                          : '1px solid rgba(120,120,120,0.28)',
                      cursor: 'pointer',
                      transition: 'all 0.2s ease',
                    }}
                    title={isConnected ? `Connected to ${apiSettings.host}:${apiSettings.port}` : hasIp ? `Configured: ${apiSettings.host} — not verified` : 'No server configured'}
                  >
                    <span style={{
                      width: 8, height: 8, borderRadius: '50%',
                      background: isConnected ? '#00b400' : hasIp ? '#dca000' : '#888',
                      boxShadow: isConnected ? '0 0 6px rgba(0,180,0,0.6)' : 'none',
                    }} />
                    <span style={{
                      fontSize: 11, fontWeight: 600, fontFamily: 'monospace',
                      color: isConnected ? '#2e7d32' : hasIp ? '#b58900' : '#888',
                    }}>
                      {hasIp ? apiSettings.host : 'Not configured'}
                    </span>
                    <span style={{
                      fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 0.6,
                      color: isConnected ? '#2e7d32' : hasIp ? '#b58900' : '#888',
                    }}>
                      {isConnected ? 'Online' : hasIp ? 'Unverified' : 'Offline'}
                    </span>
                  </div>
                );
              })()}

              {/* === Uniform header buttons — each 140px wide, same height, consistent style === */}

              {/* Get Started */}
              <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <button
                  onClick={() => setShowGetStartedModal(true)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    minHeight: 36,
                    width: 178, padding: '8px 12px', borderRadius: 10,
                    background: completedCount === totalSteps
                      ? 'linear-gradient(135deg, rgba(0,180,0,0.14), rgba(115,190,40,0.08))'
                      : 'linear-gradient(135deg, rgba(108,44,156,0.22), rgba(0,161,201,0.12))',
                    border: completedCount === totalSteps
                      ? '1px solid rgba(0,180,0,0.45)'
                      : '1px solid rgba(108,44,156,0.55)',
                    color: completedCount === totalSteps ? '#2e7d32' : '#d8e9ff',
                    fontWeight: 600, fontSize: 12,
                    cursor: 'pointer', transition: 'all 0.2s ease',
                    boxShadow: '0 2px 10px rgba(6,10,24,0.25)',
                  }}
                  onMouseOver={e => { e.currentTarget.style.transform = 'translateY(-1px)'; }}
                  onMouseOut={e => { e.currentTarget.style.transform = 'none'; }}
                >
                  <span style={{ fontSize: 13 }}>{completedCount === totalSteps ? '✅' : '🚀'}</span>
                  Get Started
                  <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 999, background: completedCount === totalSteps ? 'rgba(0,180,0,0.16)' : 'rgba(255,255,255,0.16)', fontWeight: 700 }}>{completedCount}/{totalSteps}</span>
                </button>
                <div style={{ position: 'relative', display: 'inline-block' }}
                  onMouseEnter={() => setShowGetStartedTooltip(true)}
                  onMouseLeave={() => setShowGetStartedTooltip(false)}
                >
                  <div style={{ width: 16, height: 16, borderRadius: '50%', background: 'rgba(108,44,156,0.12)', border: '1px solid rgba(108,44,156,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'help', fontSize: 9, fontWeight: 700, color: Colors.Theme.Primary['70'] }}>?</div>
                  {showGetStartedTooltip && (
                    <div style={{ position: 'absolute', top: 24, right: 0, width: 260, padding: 12, borderRadius: 10, background: Colors.Background.Surface.Default, border: `1.5px solid ${Colors.Border.Neutral.Default}`, boxShadow: '0 8px 24px rgba(0,0,0,0.25)', zIndex: 10000, fontSize: 12, lineHeight: 1.6 }}>
                      <Strong style={{ fontSize: 13, marginBottom: 6, display: 'block' }}>🚀 Get Started Checklist</Strong>
                      <div>Step-by-step guide to configure your BizObs Demonstrator environment.</div>
                      <div style={{ marginTop: 6 }}><Strong>Server</Strong> — Connect to your BizObs backend</div>
                      <div><Strong>EdgeConnect</Strong> — Set up Dynatrace connectivity</div>
                      <div><Strong>Settings</Strong> — Deploy capture rules &amp; feature flags</div>
                      <div style={{ marginTop: 6, opacity: 0.6 }}>Complete all steps for full functionality.</div>
                    </div>
                  )}
                </div>
              </div>

              {/* Navigation Dropdown */}
              <div ref={navMenuRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                <button
                  onClick={() => setShowNavMenu(prev => !prev)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                    minHeight: 36,
                    padding: '8px 14px', borderRadius: 10,
                    background: showNavMenu
                      ? 'linear-gradient(135deg, rgba(108,44,156,0.22), rgba(0,161,201,0.12))'
                      : 'linear-gradient(135deg, rgba(108,44,156,0.12), rgba(0,161,201,0.06))',
                    border: '1px solid rgba(108,44,156,0.5)',
                    color: '#c8d8ff', fontWeight: 600, fontSize: 12,
                    cursor: 'pointer', transition: 'all 0.2s ease',
                  }}
                  onMouseOver={e => { if (!showNavMenu) e.currentTarget.style.transform = 'translateY(-1px)'; }}
                  onMouseOut={e => { e.currentTarget.style.transform = 'none'; }}
                >
                  <span style={{ fontSize: 14 }}>☰</span>
                  Navigate
                  <span style={{
                    fontSize: 10, transition: 'transform 0.2s ease',
                    display: 'inline-block',
                    transform: showNavMenu ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}>▼</span>
                </button>

                {showNavMenu && (
                  <div style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 6,
                    width: 260, borderRadius: 12,
                    background: Colors.Background.Surface.Default,
                    border: `1.5px solid ${Colors.Border.Neutral.Default}`,
                    boxShadow: '0 12px 40px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.05)',
                    zIndex: 10001, overflow: 'hidden',
                    animation: 'navMenuSlideIn 0.15s ease-out',
                  }}>
                    <div style={{ padding: '10px 14px 6px', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
                      <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1.2, color: Colors.Theme.Primary['70'], opacity: 0.7 }}>Navigation</span>
                    </div>
                    {[
                      { icon: '🗺️', label: 'Journeys', color: '#00a1c9', action: () => { openJourneysModal(); setShowNavMenu(false); } },
                      { icon: '📖', label: 'Demo Guide', color: '#00b4dc', route: '/demo-guide' },
                      { icon: '📊', label: 'Dashboards', color: '#3498db', route: '/demonstrator-dashboards' },
                      { icon: '👹', label: 'Nemesis', color: '#b58900', badge: activeFaults.length > 0 ? activeFaults.length : undefined, action: () => { openChaosModal(); setShowNavMenu(false); } },
                      { icon: '📄', label: 'Executive Summary', color: '#00a1c9', action: () => { openGenerateDashboardModal(); setShowNavMenu(false); } },
                      { icon: '🏢', label: 'Solutions', color: '#27ae60', route: '/solutions' },
                      { icon: '⚙️', label: 'Settings', color: Colors.Theme.Primary['70'] as string, action: () => { openSettingsModal(); setShowNavMenu(false); } },
                      {
                        icon: '📅',
                        label: 'Demo Calendar',
                        color: '#00a1c9',
                        action: () => {
                          setShowScheduleMenu(true);
                          setShowNavMenu(false);
                          setScheduleStatus('');
                          setScheduleForm((prev) => {
                            const defaultCompany = prev.companyName || runningCustomerCompanyOptions[0] || companyName;
                            const defaultJourney = prev.journeyType
                              || scheduleJourneyOptions.find((option) => option.companyName === defaultCompany)?.journeyType
                              || requirements;
                            const now = new Date();
                            setScheduleCalendarMonth(new Date(now.getFullYear(), now.getMonth(), 1));
                            if (!prev.fromAt) {
                              setScheduleDate(toLocalDateInput(now));
                              const h = String(now.getHours()).padStart(2, '0');
                              const m = String(now.getMinutes()).padStart(2, '0');
                              setScheduleFromTime(`${h}:${m}`);
                              setScheduleToTime(`${String((now.getHours() + 1) % 24).padStart(2, '0')}:${m}`);
                            }
                            return {
                              ...prev,
                              customerName: prev.customerName || defaultCompany,
                              companyName: defaultCompany,
                              journeyType: defaultJourney,
                            };
                          });
                        }
                      },
                    ].map((item, idx) => (
                      <div
                        key={idx}
                        onClick={() => {
                          if (item.route) {
                            void trackUiUsage(`open-link-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, 'navigation', {
                              pagePath: '/',
                              targetPath: item.route,
                            });
                            navigate(item.route);
                            setShowNavMenu(false);
                          }
                          else if (item.action) {
                            void trackUiUsage(`open-panel-${item.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, 'navigation', {
                              pagePath: '/',
                            });
                            item.action();
                          }
                        }}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 12,
                          padding: '10px 16px', cursor: 'pointer',
                          transition: 'background 0.15s ease',
                          borderBottom: idx < 7 ? `1px solid rgba(255,255,255,0.04)` : 'none',
                        }}
                        onMouseOver={e => { e.currentTarget.style.background = `linear-gradient(90deg, ${item.color}18, transparent)`; }}
                        onMouseOut={e => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <span style={{
                          width: 32, height: 32, borderRadius: 8,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: `${item.color}18`,
                          border: `1px solid ${item.color}40`,
                          fontSize: 16,
                        }}>{item.icon}</span>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: item.color }}>{item.label}</div>
                        </div>
                        {item.badge && (
                          <span style={{
                            background: '#dc322f', color: 'white', borderRadius: 8,
                            padding: '2px 7px', fontSize: 10, fontWeight: 700,
                          }}>{item.badge}</span>
                        )}
                        <span style={{ fontSize: 12, opacity: 0.3 }}>›</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div ref={scheduleMenuRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
                {showScheduleMenu && (
                  <div style={{
                    position: 'absolute', top: '100%', right: 0, marginTop: 8,
                    width: 'min(640px, 94vw)', borderRadius: 12,
                    background: Colors.Background.Surface.Default,
                    border: `1.5px solid ${Colors.Border.Neutral.Default}`,
                    boxShadow: '0 12px 40px rgba(0,0,0,0.3)',
                    zIndex: 10002,
                    maxHeight: '82vh',
                    overflowY: 'auto',
                    overflowX: 'hidden',
                    overscrollBehavior: 'contain',
                  }}>
                    <div style={{ padding: '10px 14px', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
                      <Flex alignItems="center" justifyContent="space-between">
                        <Strong style={{ fontSize: 13 }}>📅 Demo Calendar Availability Window</Strong>
                        <button
                          onClick={() => void loadScheduleOptionsFromBizEvents(false)}
                          disabled={isLoadingScheduleOptions}
                          style={{
                            padding: '4px 8px', borderRadius: 6, fontSize: 11,
                            border: `1px solid ${Colors.Border.Neutral.Default}`,
                            background: isLoadingScheduleOptions ? 'rgba(128,128,128,0.12)' : 'rgba(0,161,201,0.08)',
                            color: '#00a1c9', cursor: isLoadingScheduleOptions ? 'not-allowed' : 'pointer',
                          }}
                        >
                          {isLoadingScheduleOptions ? '⏳ Refreshing…' : '🔄 Refresh'}
                        </button>
                      </Flex>
                      <div style={{ fontSize: 11, opacity: 0.7, marginTop: 4 }}>Use this to tell the app when your demo is happening so the selected journey is up and available before start time.</div>
                      {lastScheduleOptionsRefresh && (
                        <div style={{ fontSize: 10, opacity: 0.55, marginTop: 3 }}>
                          Last refresh: {new Date(lastScheduleOptionsRefresh).toLocaleTimeString()}
                        </div>
                      )}
                    </div>

                    <div style={{ padding: 14, display: 'grid', gap: 10 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: '#dbe9ff', letterSpacing: 0.2 }}>Customer Name</label>
                      <select
                        value={scheduleForm.customerName || scheduleForm.companyName}
                        onChange={(e) => {
                          const selected = e.target.value;
                          const nextJourney = scheduleJourneyOptions.find((option) => option.companyName === selected)?.journeyType || '';
                          setScheduleForm((prev) => ({
                            ...prev,
                            customerName: selected,
                            companyName: selected,
                            journeyType: nextJourney,
                          }));
                        }}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          padding: '8px 10px', borderRadius: 8,
                          border: '1px solid rgba(112,150,205,0.45)',
                          background: 'rgba(8,13,33,0.95)',
                          color: '#e6f0ff',
                          fontSize: 12,
                          colorScheme: 'dark',
                        }}
                      >
                        <option value="" style={{ background: '#0b132f', color: '#e6f0ff' }}>Select BizEvents customer</option>
                        {runningCustomerCompanyOptions.map((customer) => (
                          <option key={customer} value={customer} style={{ background: '#0b132f', color: '#e6f0ff' }}>{customer}</option>
                        ))}
                      </select>

                      <label style={{ fontSize: 11, fontWeight: 700, color: '#dbe9ff', letterSpacing: 0.2 }}>Company Name</label>
                      <select
                        value={scheduleForm.companyName}
                        onChange={(e) => {
                          const selected = e.target.value;
                          const nextJourney = scheduleJourneyOptions.find((option) => option.companyName === selected)?.journeyType || '';
                          setScheduleForm((prev) => ({
                            ...prev,
                            customerName: selected,
                            companyName: selected,
                            journeyType: nextJourney,
                          }));
                        }}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          padding: '8px 10px', borderRadius: 8,
                          border: '1px solid rgba(112,150,205,0.45)',
                          background: 'rgba(8,13,33,0.95)',
                          color: '#e6f0ff',
                          fontSize: 12,
                          colorScheme: 'dark',
                        }}
                      >
                        <option value="" style={{ background: '#0b132f', color: '#e6f0ff' }}>Select BizEvents company</option>
                        {runningCustomerCompanyOptions.map((companyOption) => (
                          <option key={companyOption} value={companyOption} style={{ background: '#0b132f', color: '#e6f0ff' }}>{companyOption}</option>
                        ))}
                      </select>

                      <label style={{ fontSize: 11, fontWeight: 700, color: '#dbe9ff', letterSpacing: 0.2 }}>Journey Type</label>
                      <select
                        value={scheduleForm.journeyType}
                        onChange={(e) => setScheduleForm((prev) => ({ ...prev, journeyType: e.target.value }))}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          padding: '8px 10px', borderRadius: 8,
                          border: '1px solid rgba(112,150,205,0.45)',
                          background: 'rgba(8,13,33,0.95)',
                          color: '#e6f0ff',
                          fontSize: 12,
                          colorScheme: 'dark',
                        }}
                        disabled={!scheduleForm.companyName}
                      >
                        <option value="" style={{ background: '#0b132f', color: '#e6f0ff' }}>Select BizEvents journey type</option>
                        {runningJourneyTypesForSelectedCompany.map((journeyOption) => (
                          <option key={journeyOption} value={journeyOption} style={{ background: '#0b132f', color: '#e6f0ff' }}>{journeyOption}</option>
                        ))}
                      </select>

                      <label style={{ fontSize: 11, fontWeight: 700, color: '#dbe9ff', letterSpacing: 0.2 }}>Timezone</label>
                      <select
                        value={scheduleTimezone || tenantCalendarTimezone}
                        onChange={(e) => setScheduleTimezone(e.target.value)}
                        style={{
                          width: '100%',
                          boxSizing: 'border-box',
                          padding: '8px 10px', borderRadius: 8,
                          border: '1px solid rgba(112,150,205,0.45)',
                          background: 'rgba(8,13,33,0.95)',
                          color: '#e6f0ff',
                          fontSize: 12,
                          colorScheme: 'dark',
                        }}
                      >
                        {[tenantCalendarTimezone, 'UTC', 'Europe/London', 'America/New_York', 'Asia/Singapore'].filter((v, i, arr) => arr.indexOf(v) === i).map((tz) => (
                          <option key={tz} value={tz} style={{ background: '#0b132f', color: '#e6f0ff' }}>{tz}{tz === tenantCalendarTimezone ? ' (tenant)' : ''}</option>
                        ))}
                      </select>

                      <label style={{ fontSize: 11, fontWeight: 700, color: '#dbe9ff', letterSpacing: 0.2 }}>Date & time window</label>
                      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 120px', gap: 8, width: '100%', minWidth: 0 }}>
                        <div style={{ border: '1px solid rgba(112,150,205,0.35)', borderRadius: 10, padding: 8, background: 'rgba(8,13,33,0.55)', minWidth: 0 }}>
                          <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 8 }}>
                            <button
                              onClick={() => setScheduleCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() - 1, 1))}
                              style={{ border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', borderRadius: 6, cursor: 'pointer', padding: '2px 8px' }}
                            >
                              ←
                            </button>
                            <Strong style={{ fontSize: 12 }}>{scheduleCalendarMonth.toLocaleString(undefined, { month: 'long', year: 'numeric' })}</Strong>
                            <button
                              onClick={() => setScheduleCalendarMonth((prev) => new Date(prev.getFullYear(), prev.getMonth() + 1, 1))}
                              style={{ border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', borderRadius: 6, cursor: 'pointer', padding: '2px 8px' }}
                            >
                              →
                            </button>
                          </Flex>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, fontSize: 10, opacity: 0.65, marginBottom: 4 }}>
                            {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} style={{ textAlign: 'center' }}>{d}</div>)}
                          </div>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
                            {scheduleCalendarDays.map(({ date, inCurrentMonth }) => {
                              const dateKey = toLocalDateInput(date);
                              const isSelected = scheduleDate === dateKey;
                              return (
                                <button
                                  key={date.toISOString()}
                                  onClick={() => setScheduleDate(dateKey)}
                                  style={{
                                    borderRadius: 6,
                                    border: isSelected ? '1px solid rgba(0,161,201,0.8)' : '1px solid rgba(112,150,205,0.32)',
                                    background: isSelected ? 'rgba(0,161,201,0.2)' : 'rgba(6,10,28,0.45)',
                                    color: inCurrentMonth ? '#e6f0ff' : 'rgba(142,162,198,0.55)',
                                    fontSize: 11,
                                    padding: '5px 0',
                                    cursor: 'pointer',
                                  }}
                                >
                                  {date.getDate()}
                                </button>
                              );
                            })}
                          </div>
                        </div>
                        <div style={{ border: '1px solid rgba(112,150,205,0.35)', borderRadius: 10, padding: 8, background: 'rgba(8,13,33,0.55)' }}>
                          <label style={{ fontSize: 11, fontWeight: 700, color: '#dbe9ff' }}>From</label>
                          <input
                            type="time"
                            value={scheduleFromTime}
                            onChange={(e) => setScheduleFromTime(e.target.value)}
                            style={{ marginTop: 4, width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(112,150,205,0.45)', background: 'rgba(8,13,33,0.95)', color: '#e6f0ff', fontSize: 11, colorScheme: 'dark', minWidth: 0 }}
                          />
                          <label style={{ marginTop: 8, display: 'block', fontSize: 11, fontWeight: 700, color: '#dbe9ff' }}>To</label>
                          <input
                            type="time"
                            value={scheduleToTime}
                            onChange={(e) => setScheduleToTime(e.target.value)}
                            style={{ marginTop: 4, width: '100%', boxSizing: 'border-box', padding: '5px 8px', borderRadius: 6, border: '1px solid rgba(112,150,205,0.45)', background: 'rgba(8,13,33,0.95)', color: '#e6f0ff', fontSize: 11, colorScheme: 'dark', minWidth: 0 }}
                          />
                          <div style={{ marginTop: 8, fontSize: 10, color: 'rgba(220,235,255,0.75)' }}>
                            <div style={{ fontWeight: 600, color: '#e6f0ff', fontSize: 10, marginBottom: 3 }}>{scheduleDate}</div>
                            <div style={{ fontWeight: 600, color: '#e6f0ff', fontSize: 10, marginBottom: 3 }}>{scheduleFromTime}–{scheduleToTime}</div>
                            <div style={{ opacity: 0.6, fontSize: 9 }}>{tenantCalendarTimezone}</div>
                          </div>
                        </div>
                      </div>

                      <label style={{ fontSize: 11, fontWeight: 700, color: '#dbe9ff', letterSpacing: 0.2 }}>Readiness notes (optional)</label>
                      <textarea
                        value={scheduleForm.notes}
                        onChange={(e) => setScheduleForm((prev) => ({ ...prev, notes: e.target.value }))}
                        placeholder="Anything needed to ensure app and journey readiness"
                        rows={2}
                        style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(112,150,205,0.45)', background: 'rgba(8,13,33,0.95)', color: '#e6f0ff', fontSize: 12, resize: 'vertical' }}
                      />

                      <Flex justifyContent="space-between" alignItems="center" style={{ marginTop: 4, flexWrap: 'wrap', gap: 8 }}>
                        <button
                          onClick={scheduleDemo}
                          style={{
                            padding: '7px 12px', borderRadius: 8, border: 'none',
                            background: 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,161,201,0.9))',
                            color: 'white', fontWeight: 600, fontSize: 12, cursor: 'pointer',
                          }}
                        >
                          Save Readiness Window
                        </button>
                        <span style={{ fontSize: 11, opacity: 0.7 }}>{getAuditUser().userEmail || 'user email unavailable'}</span>
                      </Flex>

                      {scheduleStatus && (
                        <div style={{
                          padding: '6px 8px', borderRadius: 8, fontSize: 11,
                          background: scheduleStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : 'rgba(220,50,47,0.12)',
                          border: `1px solid ${scheduleStatus.includes('✅') ? 'rgba(115,190,40,0.35)' : 'rgba(220,50,47,0.35)'}`,
                        }}>
                          {scheduleStatus}
                        </div>
                      )}

                      <div style={{ borderTop: `1px solid ${Colors.Border.Neutral.Default}`, paddingTop: 10 }}>
                        <Flex alignItems="center" justifyContent="space-between">
                          <Strong style={{ fontSize: 12 }}>Audit Calendar</Strong>
                          <Flex gap={6}>
                            {(['day', 'week', 'month'] as const).map((view) => (
                              <button
                                key={view}
                                onClick={() => setScheduleAuditView(view)}
                                style={{
                                  padding: '2px 8px', borderRadius: 10, fontSize: 10, fontWeight: 700,
                                  border: scheduleAuditView === view ? '1px solid rgba(0,161,201,0.65)' : '1px solid rgba(112,150,205,0.35)',
                                  background: scheduleAuditView === view ? 'rgba(0,161,201,0.18)' : 'rgba(8,13,33,0.65)',
                                  color: '#e6f0ff', cursor: 'pointer', textTransform: 'uppercase',
                                }}
                              >
                                {view}
                              </button>
                            ))}
                          </Flex>
                        </Flex>
                        <div style={{ marginTop: 8, maxHeight: 170, overflow: 'auto', display: 'grid', gap: 6 }}>
                          {filteredDemoSchedules.slice(0, 24).map((entry) => {
                            const readiness = getScheduleReadiness(entry);
                            return (
                              <div key={entry.id} style={{ padding: 8, borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,161,201,0.04)' }}>
                                <Flex alignItems="center" justifyContent="space-between" style={{ gap: 8 }}>
                                  <div style={{ fontSize: 12, fontWeight: 600 }}>{entry.customerName} · {entry.companyName} · {entry.journeyType}</div>
                                  <div style={{
                                    fontSize: 10,
                                    fontWeight: 700,
                                    letterSpacing: 0.3,
                                    color: readiness.color,
                                    background: readiness.bg,
                                    border: `1px solid ${readiness.border}`,
                                    padding: '2px 8px',
                                    borderRadius: 999,
                                    whiteSpace: 'nowrap',
                                  }}>
                                    {readiness.label}
                                  </div>
                                </Flex>
                                <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                                  {formatScheduleRange(entry.fromAt, entry.toAt)} · by {entry.schedulerEmail || entry.schedulerName || 'unknown'}
                                </div>
                                <div style={{ fontSize: 10, marginTop: 2, color: readiness.color }}>
                                  Runtime check: {readiness.detail}
                                </div>
                                {entry.notes && <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>{entry.notes}</div>}
                                <button
                                  onClick={() => removeScheduledDemo(entry.id)}
                                  style={{ marginTop: 6, padding: '2px 8px', borderRadius: 6, border: '1px solid rgba(220,50,47,0.3)', background: 'rgba(220,50,47,0.08)', color: '#dc322f', fontSize: 10, cursor: 'pointer' }}
                                >
                                  Remove
                                </button>
                              </div>
                            );
                          })}
                          {filteredDemoSchedules.length === 0 && (
                            <div style={{ fontSize: 11, opacity: 0.6, padding: 6 }}>No demo slots for this {scheduleAuditView} view.</div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div ref={supportMenuRef} style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <button
                onClick={() => setShowSupportMenu(prev => !prev)}
                title="Open support options"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                  minHeight: 36,
                  width: 148, padding: '8px 12px', borderRadius: 10,
                  background: showSupportMenu
                    ? 'linear-gradient(135deg, rgba(220,50,47,0.24), rgba(243,156,18,0.12))'
                    : 'linear-gradient(135deg, rgba(220,50,47,0.18), rgba(243,156,18,0.08))',
                  border: '1px solid rgba(220,50,47,0.45)',
                  color: '#ff9f8f', fontWeight: 700, fontSize: 12,
                  cursor: 'pointer', transition: 'all 0.2s ease',
                  textDecoration: 'none',
                  boxShadow: '0 4px 14px rgba(220,50,47,0.12)',
                }}
                onMouseOver={e => { if (!showSupportMenu) e.currentTarget.style.transform = 'translateY(-1px)'; }}
                onMouseOut={e => { e.currentTarget.style.transform = 'none'; }}
              >
                <span style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'rgba(220,50,47,0.18)',
                  border: '1px solid rgba(220,50,47,0.35)',
                  fontSize: 13,
                }}>🐞</span>
                Support
                <span style={{
                  fontSize: 10,
                  transition: 'transform 0.2s ease',
                  display: 'inline-block',
                  transform: showSupportMenu ? 'rotate(180deg)' : 'rotate(0deg)',
                }}>▼</span>
              </button>

              {showSupportMenu && (
                <div style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 6,
                  width: 220, borderRadius: 12,
                  background: Colors.Background.Surface.Default,
                  border: `1.5px solid ${Colors.Border.Neutral.Default}`,
                  boxShadow: '0 12px 40px rgba(0,0,0,0.3), 0 0 0 1px rgba(255,255,255,0.05)',
                  zIndex: 10001, overflow: 'hidden',
                  animation: 'navMenuSlideIn 0.15s ease-out',
                }}>
                  <div style={{ padding: '10px 14px 6px', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
                    <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: 1.2, color: '#ff9f8f', opacity: 0.8 }}>Support</span>
                  </div>
                  {[
                    {
                      icon: '💬',
                      label: 'Feedback Form',
                      color: '#ffbf66',
                      action: () => {
                        void trackUiUsage('open-support-form', 'feedback', {
                          pagePath: '/',
                          destination: 'microsoft-forms',
                        });
                        window.open('https://forms.office.com/r/bTZPypxQh9', '_blank', 'noopener,noreferrer');
                        setShowSupportMenu(false);
                      },
                    },
                    {
                      icon: '🐞',
                      label: 'Report a Bug',
                      color: '#ff9f8f',
                      action: openBugReportModal,
                    },
                  ].map((item, idx, arr) => (
                    <div
                      key={item.label}
                      onClick={item.action}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '10px 16px', cursor: 'pointer',
                        transition: 'background 0.15s ease',
                        borderBottom: idx < arr.length - 1 ? '1px solid rgba(255,255,255,0.04)' : 'none',
                      }}
                      onMouseOver={e => { e.currentTarget.style.background = `linear-gradient(90deg, ${item.color}18, transparent)`; }}
                      onMouseOut={e => { e.currentTarget.style.background = 'transparent'; }}
                    >
                      <span style={{
                        width: 32, height: 32, borderRadius: 8,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: `${item.color}18`,
                        border: `1px solid ${item.color}40`,
                        fontSize: 16,
                      }}>{item.icon}</span>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 13, fontWeight: 600, color: item.color }}>{item.label}</div>
                      </div>
                      <span style={{ fontSize: 12, opacity: 0.3 }}>›</span>
                    </div>
                  ))}
                </div>
              )}
              </div>


            </Flex>
          </TitleBar.Action>
        </TitleBar>
      </Page.Header>

      <Page.Main>
        <Flex style={{ height: '100%' }}>
          {/* Sidebar */}
          {renderSidebar()}

          {/* Main Content */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          {/* Progress Indicator - compact, fixed at top */}
          <div style={{ 
            padding: '12px 24px',
            flexShrink: 0,
            background: 'linear-gradient(135deg, rgba(108, 44, 156, 0.08), rgba(0, 212, 255, 0.08))',
            borderBottom: `1px solid ${Colors.Border.Neutral.Default}`
          }}>
            <Flex justifyContent="center" alignItems="center" gap={0}>
              {(selectedPathway === 'ai'
                ? [
                    { id: 'welcome', label: 'Welcome', icon: '🏠', step: 0 },
                    { id: 'step1', label: 'Customer Details', icon: '📝', step: 1 },
                  ]
                : selectedPathway === 'manual'
                ? [
                    { id: 'welcome', label: 'Welcome', icon: '🏠', step: 0 },
                    { id: 'step1', label: 'Customer Details', icon: '📝', step: 1 },
                    { id: 'step2', label: 'Generate Prompts', icon: '📋', step: 2 },
                  ]
                : [
                    { id: 'welcome', label: 'Welcome', icon: '🏠', step: 0 },
                  ]
              ).map((item, index, arr) => (
                <React.Fragment key={item.id}>
                  <Flex 
                    alignItems="center" 
                    gap={8}
                    style={{ 
                      cursor: (item.id === 'step2' && (!companyName || !domain)) ? 'not-allowed' : 'pointer',
                      opacity: (item.id === 'step2' && (!companyName || !domain)) ? 0.5 : 1,
                      padding: '8px 20px',
                      borderRadius: 8,
                      background: activeTab === item.id 
                        ? `linear-gradient(135deg, ${Colors.Theme.Primary['70']}, rgba(0, 212, 255, 0.8))` 
                        : 'transparent',
                      transition: 'all 0.3s ease',
                    }}
                    onClick={() => {
                      if (item.id !== 'step2' || (companyName && domain)) {
                        setActiveTab(item.id);
                      }
                    }}
                  >
                    <div style={{ fontSize: 18 }}>{item.icon}</div>
                    <Strong style={{ 
                      fontSize: 13,
                      color: activeTab === item.id ? 'white' : Colors.Text.Neutral.Default
                    }}>
                      {item.label}
                    </Strong>
                  </Flex>
                  {index < arr.length - 1 && (
                    <div style={{ 
                      width: 40, 
                      height: 2, 
                      background: index < arr.findIndex(t => t.id === activeTab)
                        ? Colors.Theme.Primary['70'] 
                        : Colors.Border.Neutral.Default,
                      margin: '0 4px',
                      transition: 'all 0.3s ease'
                    }} />
                  )}
                </React.Fragment>
              ))}
            </Flex>
          </div>

          {/* Tab Content - fills remaining space */}
          <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
          {activeTab === 'welcome' && renderWelcomeTab()}
          {activeTab === 'step1' && renderStep1Tab()}
          {activeTab === 'ownai' && renderOwnAiTab()}
          {activeTab === 'step2' && renderStep2Tab()}
          </div>
          </div>
        </Flex>
      </Page.Main>

      {/* ── Settings Modal ─────────────────────────────── */}
      {showSettingsModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowSettingsModal(false)} />
          <div style={{ position: 'relative', width: 860, maxHeight: '85vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: `2px solid ${Colors.Border.Neutral.Default}`, boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: `linear-gradient(135deg, ${Colors.Theme.Primary['70']}, rgba(108,44,156,0.9))`, borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <span style={{ fontSize: 24 }}>⚙️</span>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Settings</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Configuration & System Maintenance</div>
                  </div>
                </Flex>
                <Flex alignItems="center" gap={8}>
                  <button onClick={() => setShowSettingsModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4, marginLeft: 8 }}>✕</button>
                </Flex>
              </Flex>
            </div>

            {/* Tab Navigation */}
            <div style={{ padding: '0 24px', borderBottom: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,0,0,0.02)' }}>
              <Flex gap={0}>
                {([
                  { id: 'config', icon: '🔌', label: 'API Config' },
                  { id: 'ai', icon: '🤖', label: 'AI Provider' },
                  { id: 'system', icon: '💾', label: 'System' },
                ] as const).map(tab => (
                  <button
                    key={tab.id}
                    onClick={() => {
                      setSettingsTab(tab.id);
                      if (tab.id === 'system') {
                        if (!systemHealth) loadSystemHealth();
                        loadGeneratedDashboards();
                      }
                    }}
                    style={{
                      padding: '12px 20px', border: 'none', cursor: 'pointer',
                      background: settingsTab === tab.id ? 'transparent' : 'transparent',
                      borderBottom: settingsTab === tab.id ? `2px solid ${Colors.Theme.Primary['70']}` : '2px solid transparent',
                      color: settingsTab === tab.id ? Colors.Theme.Primary['70'] : Colors.Text.Neutral.Default,
                      fontWeight: settingsTab === tab.id ? 700 : 400,
                      fontSize: 13, transition: 'all 0.2s ease',
                    }}
                  >
                    <span style={{ marginRight: 6 }}>{tab.icon}</span>{tab.label}
                  </button>
                ))}
              </Flex>
            </div>

            {/* Config Tab */}
            {settingsTab === 'config' && (
            <div style={{ padding: 24 }}>
              {/* Status */}
              {settingsStatus && (
                <div style={{ padding: 10, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                  background: settingsStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : settingsStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.12)',
                  border: `1px solid ${settingsStatus.includes('✅') ? Colors.Theme.Success['70'] : settingsStatus.includes('❌') ? '#dc322f' : Colors.Theme.Primary['70']}` }}>
                  {settingsStatus}
                </div>
              )}

              {/* Protocol */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Protocol</label>
                <Flex gap={8}>
                  <Button variant={settingsForm.apiProtocol === 'http' ? 'emphasized' : 'default'} onClick={() => setSettingsForm(p => ({ ...p, apiProtocol: 'http' }))} style={{ flex: 1 }}>HTTP</Button>
                  <Button variant={settingsForm.apiProtocol === 'https' ? 'emphasized' : 'default'} onClick={() => setSettingsForm(p => ({ ...p, apiProtocol: 'https' }))} style={{ flex: 1 }}>HTTPS</Button>
                </Flex>
              </div>

              {/* Host */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Host / IP Address</label>
                <TextInput value={settingsForm.apiHost} onChange={(v: string) => setSettingsForm(p => ({ ...p, apiHost: v }))} placeholder="localhost or IP address" />
              </div>

              {/* Port */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Port</label>
                <TextInput value={settingsForm.apiPort} onChange={(v: string) => setSettingsForm(p => ({ ...p, apiPort: v }))} placeholder="8080" />
              </div>

              {/* URL Preview */}
              <div style={{ padding: 12, background: 'rgba(0,161,201,0.08)', border: `1px solid ${Colors.Theme.Primary['70']}`, borderRadius: 8, marginBottom: 16 }}>
                <Strong style={{ fontSize: 11, marginBottom: 4, display: 'block' }}>Full API URL:</Strong>
                <code style={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                  {settingsForm.apiProtocol}://{settingsForm.apiHost}:{settingsForm.apiPort}/api/journey-simulation/simulate-journey
                </code>
              </div>

              {/* Actions */}
              <Flex gap={8}>
                <Button variant="emphasized" onClick={saveSettingsFromModal} disabled={isSavingSettings} style={{ flex: 2, fontWeight: 600 }}>
                  {isSavingSettings ? '💾 Saving...' : '💾 Save'}
                </Button>
                <Button onClick={testConnectionFromModal} disabled={isTestingConnection} style={{ flex: 1 }}>
                  {isTestingConnection ? '🔄...' : '🔌 Test'}
                </Button>
                <Button onClick={() => { setSettingsForm(DEFAULT_SETTINGS); setSettingsStatus('🔄 Reset to defaults'); }} style={{ flex: 1 }}>🔄 Reset</Button>
              </Flex>

              {/* ── Business Flow Management ── */}
              <div style={{ marginTop: 24, padding: 16, background: 'rgba(0,161,201,0.06)', border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 10 }}>
                <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 12 }}>
                  <Strong style={{ fontSize: 13 }}>🔄 Business Flows</Strong>
                  <button onClick={loadBizFlows} disabled={isLoadingBizFlows} style={{ padding: '3px 10px', borderRadius: 6, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', cursor: isLoadingBizFlows ? 'wait' : 'pointer', fontSize: 11, fontWeight: 600 }}>
                    {isLoadingBizFlows ? '⏳ Loading...' : '📋 List Flows'}
                  </button>
                </Flex>
                {bizFlowStatus && (
                  <div style={{ padding: 8, marginBottom: 10, borderRadius: 6, fontSize: 12, fontFamily: 'monospace',
                    background: bizFlowStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : bizFlowStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.08)',
                    border: `1px solid ${bizFlowStatus.includes('✅') ? Colors.Theme.Success['70'] : bizFlowStatus.includes('❌') ? '#dc322f' : Colors.Border.Neutral.Default}` }}>
                    {bizFlowStatus}
                  </div>
                )}
                {bizFlows.length > 0 && (
                  <>
                    <div style={{ maxHeight: 200, overflow: 'auto', marginBottom: 10 }}>
                      {bizFlows.map(f => (
                        <div key={f.objectId} style={{ padding: '6px 10px', marginBottom: 4, borderRadius: 6, fontSize: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                          background: f.isSmartscapeTopologyEnabled ? 'rgba(115,190,40,0.1)' : 'rgba(220,50,47,0.06)',
                          border: `1px solid ${f.isSmartscapeTopologyEnabled ? 'rgba(115,190,40,0.3)' : 'rgba(220,50,47,0.2)'}` }}>
                          <span>{f.isSmartscapeTopologyEnabled ? '🟢' : '⚪'} <strong>{f.name}</strong> ({f.stepsCount} steps)</span>
                          <span style={{ fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                            background: f.isSmartscapeTopologyEnabled ? 'rgba(115,190,40,0.2)' : 'transparent',
                            color: f.isSmartscapeTopologyEnabled ? '#2e7d32' : '#888' }}>
                            {f.isSmartscapeTopologyEnabled ? 'ENTITY' : 'non-entity'}
                          </span>
                        </div>
                      ))}
                    </div>
                    <Flex gap={8}>
                      <button onClick={deleteNonEntityBizFlows} disabled={isDeletingBizFlows || bizFlows.filter(f => !f.isSmartscapeTopologyEnabled).length === 0}
                        style={{ flex: 1, padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(220,50,47,0.4)', background: 'rgba(220,50,47,0.08)', cursor: isDeletingBizFlows ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600, color: '#dc322f' }}>
                        {isDeletingBizFlows ? '🗑️ Deleting...' : `🗑️ Delete ${bizFlows.filter(f => !f.isSmartscapeTopologyEnabled).length} Non-Entity Flow(s)`}
                      </button>
                      <button
                        onClick={() => setConfirmDialog({
                          message: `⚠️ Delete ALL ${bizFlows.length} business flows? This will remove both entity and non-entity business flows from Dynatrace.`,
                          onConfirm: () => deleteAllBizFlows(),
                        })}
                        disabled={isDeletingBizFlows || bizFlows.length === 0}
                        style={{ flex: 1, padding: '6px 12px', borderRadius: 6, border: '1px solid rgba(220,50,47,0.6)', background: 'rgba(220,50,47,0.14)', cursor: isDeletingBizFlows ? 'wait' : 'pointer', fontSize: 12, fontWeight: 700, color: '#b71c1c' }}
                      >
                        {isDeletingBizFlows ? '🗑️ Deleting...' : `🧨 Delete All ${bizFlows.length} Flow(s)`}
                      </button>
                    </Flex>
                  </>
                )}
              </div>
            </div>
            )}

            {/* AI Provider Tab */}
            {settingsTab === 'ai' && (
            <div style={{ padding: 24 }}>
              <Strong style={{ fontSize: 15, display: 'block', marginBottom: 4 }}>🤖 AI Provider</Strong>
              <Paragraph style={{ fontSize: 12, marginBottom: 16, opacity: 0.7, lineHeight: 1.5 }}>
                Bring your own AI. Pick a provider, enter a key, and the app generates executive summaries,
                journeys, and dashboards directly. Your key is stored in the Dynatrace Credential Vault,
                never in the app or in a document.
              </Paragraph>

              {/* Status indicator */}
              {(() => {
                const def = aiProviderDef(aiProvider);
                const ready = ghCopilotConfigured && (!def.needsBaseUrl || Boolean(aiBaseUrl.trim()));
                return (
                  <div style={{
                    padding: 12, marginBottom: 16, borderRadius: 8,
                    background: ready ? 'rgba(115,190,40,0.1)' : 'rgba(220,50,47,0.08)',
                    border: `1px solid ${ready ? 'rgba(115,190,40,0.4)' : 'rgba(220,50,47,0.3)'}`,
                  }}>
                    <Flex alignItems="center" gap={8}>
                      <span style={{ fontSize: 18 }}>{ghCopilotChecking ? '⏳' : ready ? '✅' : '⚠️'}</span>
                      <div>
                        <Strong style={{ fontSize: 13 }}>
                          {ghCopilotChecking
                            ? 'Checking provider configuration...'
                            : ready
                              ? `${def.label} ready via ${aiRouteViaVm || def.alwaysViaVm ? 'the demo host' : 'Dynatrace'} using ${ghCopilotModel}`
                              : 'Not configured. Generate with AI buttons will be disabled.'}
                        </Strong>
                        {!ghCopilotChecking && (
                          <Paragraph style={{ fontSize: 11, marginBottom: 0, marginTop: 2, opacity: 0.8 }}>
                            {!ready
                              ? (def.needsKey && !ghCopilotConfigured
                                  ? `Add a ${def.label} API key below to enable AI generation.`
                                  : 'Add the base URL below to enable AI generation.')
                              : aiProviderHost
                                ? (aiHostAllowed
                                    ? `Outbound to ${aiProviderHost} is allowlisted.`
                                    : `⚠️ ${aiProviderHost} is not in the outbound allowlist yet. Re-save the key to add it.`)
                                : 'Calls route through the demo host, so no outbound allowlist entry is needed.'}
                          </Paragraph>
                        )}
                      </div>
                    </Flex>
                  </div>
                );
              })()}

              {/* Provider selector */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Provider</label>
                <select
                  value={aiProvider}
                  onChange={(e: any) => {
                    const nextId = e.target.value as AiProviderId;
                    const nextDef = aiProviderDef(nextId);
                    setAiProvider(nextId);
                    setGhCopilotModel(nextDef.defaultModel);
                    setAiBaseUrl('');
                    setAiProviderHost('');
                    setGhCopilotStatus('');
                    // Ollama needs no key, so it counts as configured the moment
                    // it's picked. Keyed providers share one vault credential, so
                    // whatever was already stored still applies.
                    if (!nextDef.needsKey) setGhCopilotConfigured(true);
                    // Ollama runs on the host, so it can only be reached via the host.
                    if (nextDef.alwaysViaVm) setAiRouteViaVm(true);
                  }}
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 6,
                    background: Colors.Background.Base.Default,
                    border: `1px solid ${Colors.Border.Neutral.Default}`,
                    color: Colors.Text.Neutral.Default, fontSize: 13,
                    cursor: 'pointer',
                  }}
                >
                  {AI_PROVIDER_CATALOG.map(p => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
                {aiProviderDef(aiProvider).note && (
                  <Paragraph style={{ fontSize: 11, marginTop: 4, marginBottom: 0, opacity: 0.7 }}>
                    {aiProviderDef(aiProvider).note}
                  </Paragraph>
                )}
              </div>

              {/* Base URL (only for providers that need one) */}
              {aiProviderDef(aiProvider).needsBaseUrl && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Base URL</label>
                  <input
                    type="text"
                    placeholder="https://your-gateway.example.com/v1"
                    value={aiBaseUrl}
                    onChange={(e: any) => setAiBaseUrl(e.target.value)}
                    style={{
                      width: '100%', padding: '8px 12px', borderRadius: 6,
                      background: Colors.Background.Base.Default,
                      border: `1px solid ${Colors.Border.Neutral.Default}`,
                      color: Colors.Text.Neutral.Default, fontSize: 13,
                      fontFamily: 'monospace',
                    }}
                  />
                </div>
              )}

              {/* Model */}
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Model</label>
                <input
                  type="text"
                  placeholder={aiProviderDef(aiProvider).defaultModel}
                  value={ghCopilotModel}
                  onChange={(e: any) => setGhCopilotModel(e.target.value)}
                  style={{
                    width: '100%', padding: '8px 12px', borderRadius: 6,
                    background: Colors.Background.Base.Default,
                    border: `1px solid ${Colors.Border.Neutral.Default}`,
                    color: Colors.Text.Neutral.Default, fontSize: 13,
                    fontFamily: 'monospace',
                  }}
                />
                {(() => {
                  const suggestions = aiProviderDef(aiProvider).suggestedModels;
                  if (suggestions.length === 0) return null;
                  return (
                    <div style={{ marginTop: 6 }}>
                      <Flex gap={6} style={{ flexWrap: 'wrap' }}>
                        {suggestions.slice(0, 12).map(id => (
                          <button
                            key={id}
                            onClick={() => setGhCopilotModel(id)}
                            style={{
                              padding: '2px 8px', borderRadius: 10, cursor: 'pointer', fontSize: 11,
                              fontFamily: 'monospace',
                              background: ghCopilotModel === id ? 'rgba(0,161,201,0.18)' : 'transparent',
                              border: `1px solid ${ghCopilotModel === id ? 'rgba(0,161,201,0.5)' : Colors.Border.Neutral.Default}`,
                              color: Colors.Text.Neutral.Default,
                            }}
                          >
                            {id}
                          </button>
                        ))}
                      </Flex>
                      <Paragraph style={{ fontSize: 11, marginTop: 4, marginBottom: 0, opacity: 0.6 }}>
                        Suggestions only. Any model your provider supports will work.
                      </Paragraph>
                    </div>
                  );
                })()}
              </div>

              {/* Trace AI calls through the host */}
              <div style={{
                padding: 12, marginBottom: 16, borderRadius: 8,
                background: 'rgba(0,161,201,0.06)', border: '1px solid rgba(0,161,201,0.2)',
              }}>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: aiProviderDef(aiProvider).alwaysViaVm ? 'not-allowed' : 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={aiRouteViaVm || aiProviderDef(aiProvider).alwaysViaVm}
                    disabled={aiProviderDef(aiProvider).alwaysViaVm}
                    onChange={(e: any) => setAiRouteViaVm(e.target.checked)}
                    style={{ marginTop: 2 }}
                  />
                  <div>
                    <Strong style={{ fontSize: 13 }}>Trace AI calls through the demo host</Strong>
                    <Paragraph style={{ fontSize: 11, marginTop: 2, marginBottom: 0, opacity: 0.8, lineHeight: 1.5 }}>
                      {aiProviderDef(aiProvider).alwaysViaVm
                        ? 'Always on for Ollama, since it runs on the host and Dynatrace cannot reach it directly.'
                        : 'Routes generation through the host so it emits OpenTelemetry GenAI spans. Turn this on to demo AI observability, off for the lowest latency and no host dependency.'}
                    </Paragraph>
                  </div>
                </label>
              </div>

              {/* API key */}
              {aiProviderDef(aiProvider).needsKey && (
                <div style={{ marginBottom: 16 }}>
                  <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                    API key{ghCopilotConfigured ? ' (one is already stored, enter a new one to replace it)' : ''}
                  </label>
                  <Flex gap={8}>
                    <input
                      type="password"
                      placeholder={aiProviderDef(aiProvider).keyHint}
                      value={ghCopilotToken}
                      onChange={(e: any) => setGhCopilotToken(e.target.value)}
                      style={{
                        flex: 1, padding: '8px 12px', borderRadius: 6,
                        background: Colors.Background.Base.Default,
                        border: `1px solid ${Colors.Border.Neutral.Default}`,
                        color: Colors.Text.Neutral.Default, fontSize: 13,
                        fontFamily: 'monospace',
                      }}
                    />
                    <Button
                      variant="emphasized"
                      disabled={!ghCopilotToken.trim() || ghCopilotSaving}
                      onClick={async () => {
                        const def = aiProviderDef(aiProvider);
                        if (def.needsBaseUrl && !aiBaseUrl.trim()) {
                          setGhCopilotStatus('❌ Base URL is required for this provider.');
                          return;
                        }
                        setGhCopilotSaving(true);
                        setGhCopilotStatus('⏳ Saving key to Credential Vault...');
                        try {
                          const res = await callProxyWithRetry({
                            action: 'ai-provider-save-key',
                            apiHost: '', apiPort: '', apiProtocol: '',
                            body: { provider: aiProvider, apiKey: ghCopilotToken.trim(), baseUrl: aiBaseUrl.trim() },
                          });
                          if (res.success) {
                            setGhCopilotToken('');
                            setGhCopilotConfigured(true);
                            setAiProviderHost(String(res.data?.host || ''));
                            setAiHostAllowed(res.data?.hostAllowed !== false);
                            const saved = await persistAiConfig();
                            setGhCopilotStatus(saved
                              ? `✅ Key stored in Credential Vault${res.data?.host ? `, ${res.data.host} allowlisted` : ''}`
                              : `⚠️ Key stored, but saving provider settings failed: ${getLastAppSettingsSaveError() || 'unknown error'}`);
                            await refreshAiProviderStatus();
                          } else {
                            setGhCopilotStatus(`❌ ${res.error}`);
                          }
                        } catch (err: any) {
                          setGhCopilotStatus(`❌ ${err.message}`);
                        }
                        setGhCopilotSaving(false);
                      }}
                    >
                      {ghCopilotSaving ? '⏳ Saving...' : '🔐 Save to Vault'}
                    </Button>
                  </Flex>
                  {aiProviderDef(aiProvider).keyUrl && (
                    <Paragraph style={{ fontSize: 11, marginTop: 4, marginBottom: 0, opacity: 0.7 }}>
                      Create a key at{' '}
                      <a
                        href={aiProviderDef(aiProvider).keyUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: Colors.Theme.Primary['70'] }}
                      >
                        {aiProviderDef(aiProvider).keyUrl}
                      </a>
                    </Paragraph>
                  )}
                </div>
              )}

              {/* Save config / refresh */}
              <Flex gap={8} style={{ marginBottom: 16 }}>
                <Button
                  variant="emphasized"
                  disabled={aiConfigSaving}
                  onClick={async () => {
                    const def = aiProviderDef(aiProvider);
                    if (def.needsBaseUrl && !aiBaseUrl.trim()) {
                      setGhCopilotStatus('❌ Base URL is required for this provider.');
                      return;
                    }
                    setAiConfigSaving(true);
                    setGhCopilotStatus('⏳ Saving provider settings...');
                    try {
                      const saved = await persistAiConfig();
                      setGhCopilotStatus(saved
                        ? '✅ Provider settings saved for everyone on this tenant'
                        : `❌ Save failed: ${getLastAppSettingsSaveError() || 'unknown error'}`);
                      if (saved) await refreshAiProviderStatus();
                    } catch (err: any) {
                      setGhCopilotStatus(`❌ ${err.message}`);
                    }
                    setAiConfigSaving(false);
                  }}
                >
                  {aiConfigSaving ? '⏳ Saving...' : '💾 Save configuration'}
                </Button>
                <Button
                  variant="default"
                  disabled={ghCopilotChecking}
                  onClick={() => { void refreshAiProviderStatus(); }}
                >
                  {ghCopilotChecking ? '⏳ Checking...' : '🔄 Refresh status'}
                </Button>
              </Flex>

              {/* Status message */}
              {ghCopilotStatus && (
                <div style={{
                  padding: 10, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                  background: ghCopilotStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : ghCopilotStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.12)',
                  border: `1px solid ${ghCopilotStatus.includes('✅') ? 'rgba(115,190,40,0.4)' : ghCopilotStatus.includes('❌') ? 'rgba(220,50,47,0.4)' : 'rgba(0,161,201,0.4)'}`,
                }}>
                  {ghCopilotStatus}
                </div>
              )}

              {/* Where things are stored */}
              <div style={{
                padding: 12, borderRadius: 8,
                background: 'rgba(255,255,255,0.03)', border: `1px solid ${Colors.Border.Neutral.Default}`,
              }}>
                <Strong style={{ fontSize: 12, display: 'block', marginBottom: 4 }}>Where this is stored</Strong>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, lineHeight: 1.7, opacity: 0.8 }}>
                  <li>API key: Dynatrace Credential Vault, as <code>bizobs-ai-provider-key</code>.</li>
                  <li>Provider, model, base URL, tracing: the shared app settings document, so the whole team sees the same config.</li>
                  <li>An existing <code>bizobs-github-pat</code> credential is still honoured if no provider key is set, so older setups keep working.</li>
                </ul>
              </div>
            </div>
            )}

            {/* System Maintenance Tab */}
            {settingsTab === 'system' && (
            <div style={{ padding: 24 }}>
              <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 16 }}>
                <div>
                  <Strong style={{ fontSize: 15, display: 'block' }}>💾 System Health & Disk Cleanup</Strong>
                  <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 4, opacity: 0.7 }}>
                    Cross-platform — works on Linux, macOS & Windows. Auto-cleans on server boot when disk {'>'} 90%.
                  </Paragraph>
                </div>
                <button onClick={loadSystemHealth} disabled={isLoadingHealth}
                  style={{ padding: '6px 14px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', cursor: isLoadingHealth ? 'wait' : 'pointer', fontSize: 12, fontWeight: 600 }}>
                  {isLoadingHealth ? '⏳ Scanning...' : '🔍 Scan'}
                </button>
              </Flex>

              {/* Cleanup Result */}
              {cleanupResult && (
                <div style={{ padding: 12, marginBottom: 16, borderRadius: 8, fontSize: 12, fontFamily: 'monospace',
                  background: cleanupResult.success ? 'rgba(115,190,40,0.12)' : 'rgba(220,50,47,0.12)',
                  border: `1px solid ${cleanupResult.success ? Colors.Theme.Success['70'] : '#dc322f'}` }}>
                  {cleanupResult.success
                    ? `✅ Cleanup complete — freed ${cleanupResult.totalFreedFormatted}`
                    : `❌ ${cleanupResult.error}`}
                  {cleanupResult.cleaned && cleanupResult.cleaned.length > 0 && (
                    <div style={{ marginTop: 8 }}>
                      {cleanupResult.cleaned.map((c: any, i: number) => (
                        <div key={i} style={{ marginTop: 2, fontSize: 11 }}>
                          {c.success ? '✅' : '⚠️'} {c.message}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {systemHealth?.error && (
                <div style={{ padding: 12, borderRadius: 8, background: 'rgba(220,50,47,0.08)', border: '1px solid rgba(220,50,47,0.3)', fontSize: 13, marginBottom: 16 }}>
                  ❌ {systemHealth.error}
                </div>
              )}

              {systemHealth && !systemHealth.error && (
                <>
                  {/* Disk Usage Bar */}
                  <div style={{ marginBottom: 20, padding: 16, borderRadius: 10, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,0,0,0.02)' }}>
                    <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 8 }}>
                      <Strong style={{ fontSize: 13 }}>Disk Usage</Strong>
                      <span style={{ fontSize: 12, fontFamily: 'monospace',
                        color: systemHealth.disk?.percent >= 95 ? '#dc322f' : systemHealth.disk?.percent >= 85 ? '#f39c12' : Colors.Theme.Success['70'],
                        fontWeight: 700 }}>
                        {systemHealth.disk?.percent}%
                      </span>
                    </Flex>
                    <div style={{ width: '100%', height: 12, borderRadius: 6, background: 'rgba(0,0,0,0.08)', overflow: 'hidden' }}>
                      <div style={{
                        width: `${Math.min(systemHealth.disk?.percent || 0, 100)}%`, height: '100%', borderRadius: 6,
                        background: systemHealth.disk?.percent >= 95 ? 'linear-gradient(90deg, #dc322f, #ff4136)'
                          : systemHealth.disk?.percent >= 85 ? 'linear-gradient(90deg, #f39c12, #e67e22)'
                          : `linear-gradient(90deg, ${Colors.Theme.Success['70']}, #2ecc71)`,
                        transition: 'width 0.5s ease',
                      }} />
                    </div>
                    <Flex justifyContent="space-between" style={{ marginTop: 6, fontSize: 11, opacity: 0.6 }}>
                      <span>Free: {systemHealth.disk?.free ? (systemHealth.disk.free / 1024 / 1024 / 1024).toFixed(1) + ' GB' : '?'}</span>
                      <span>Total: {systemHealth.disk?.total ? (systemHealth.disk.total / 1024 / 1024 / 1024).toFixed(1) + ' GB' : '?'}</span>
                    </Flex>
                    {systemHealth.criticalThreshold && (
                      <div style={{ marginTop: 8, padding: 8, borderRadius: 6, background: 'rgba(220,50,47,0.1)', border: '1px solid rgba(220,50,47,0.3)', fontSize: 12, fontWeight: 600, color: '#dc322f' }}>
                        ⚠️ CRITICAL — Disk nearly full! Run cleanup immediately.
                      </div>
                    )}
                  </div>

                  {/* System Info */}
                  <Flex gap={12} style={{ marginBottom: 20 }}>
                    <div style={{ flex: 1, padding: 12, borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,0,0,0.02)' }}>
                      <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>Platform</div>
                      <Strong style={{ fontSize: 13 }}>{systemHealth.platform === 'linux' ? '🐧 Linux' : systemHealth.platform === 'darwin' ? '🍎 macOS' : systemHealth.platform === 'win32' ? '🪟 Windows' : systemHealth.platform}</Strong>
                    </div>
                    <div style={{ flex: 1, padding: 12, borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,0,0,0.02)' }}>
                      <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>Memory</div>
                      <Strong style={{ fontSize: 13 }}>{systemHealth.memory?.usedPercent}% used</Strong>
                    </div>
                    <div style={{ flex: 1, padding: 12, borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,0,0,0.02)' }}>
                      <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 4 }}>Reclaimable</div>
                      <Strong style={{ fontSize: 13, color: Colors.Theme.Success['70'] }}>{systemHealth.totalCleanableFormatted}</Strong>
                    </div>
                  </Flex>

                  {/* Cleanable Items */}
                  {systemHealth.cleanable && systemHealth.cleanable.length > 0 && (
                    <div style={{ marginBottom: 16 }}>
                      <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 10 }}>
                        <Strong style={{ fontSize: 13 }}>🗂️ Cleanable Items</Strong>
                        <button onClick={() => runSystemCleanup()} disabled={isRunningCleanup}
                          style={{
                            padding: '8px 20px', borderRadius: 8, border: 'none',
                            background: isRunningCleanup ? 'rgba(115,190,40,0.3)' : `linear-gradient(135deg, ${Colors.Theme.Success['70']}, #2ecc71)`,
                            color: 'white', fontWeight: 700, fontSize: 13, cursor: isRunningCleanup ? 'wait' : 'pointer',
                            boxShadow: '0 2px 8px rgba(115,190,40,0.2)', transition: 'all 0.2s ease',
                          }}>
                          {isRunningCleanup ? '🧹 Cleaning...' : `🧹 Clean All Safe (${systemHealth.totalCleanableFormatted})`}
                        </button>
                      </Flex>
                      <div style={{ maxHeight: 300, overflow: 'auto' }}>
                        {systemHealth.cleanable.map((item: any) => (
                          <Flex key={item.id} alignItems="center" justifyContent="space-between"
                            style={{ padding: '8px 12px', marginBottom: 4, borderRadius: 8,
                              border: `1px solid ${item.safe ? 'rgba(115,190,40,0.2)' : 'rgba(220,160,0,0.3)'}`,
                              background: item.safe ? 'rgba(115,190,40,0.04)' : 'rgba(220,160,0,0.04)' }}>
                            <Flex alignItems="center" gap={8}>
                              <span style={{ fontSize: 14 }}>
                                {item.category === 'logs' ? '📋' : item.category === 'cache' ? '💽' : item.category === 'temp' ? '🗑️' : item.category === 'build' ? '🔨' : '📦'}
                              </span>
                              <div>
                                <div style={{ fontSize: 13, fontWeight: 600 }}>{item.label}</div>
                                {item.note && <div style={{ fontSize: 10, opacity: 0.5 }}>{item.note}</div>}
                              </div>
                            </Flex>
                            <Flex alignItems="center" gap={8}>
                              <span style={{ fontSize: 12, fontFamily: 'monospace', fontWeight: 600 }}>
                                {item.size > 0 ? (item.size >= 1073741824 ? (item.size / 1073741824).toFixed(1) + ' GB' : item.size >= 1048576 ? (item.size / 1048576).toFixed(1) + ' MB' : (item.size / 1024).toFixed(0) + ' KB') : '—'}
                              </span>
                              {item.safe ? (
                                <button onClick={() => runSystemCleanup([item.id])} disabled={isRunningCleanup}
                                  style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${Colors.Theme.Success['70']}`, background: 'rgba(115,190,40,0.08)', cursor: isRunningCleanup ? 'wait' : 'pointer', fontSize: 11, fontWeight: 600, color: Colors.Theme.Success['70'] }}>
                                  Clean
                                </button>
                              ) : (
                                <span style={{ fontSize: 11, opacity: 0.4, fontStyle: 'italic' }}>manual</span>
                              )}
                            </Flex>
                          </Flex>
                        ))}
                      </div>
                    </div>
                  )}

                  {systemHealth.cleanable && systemHealth.cleanable.length === 0 && (
                    <div style={{ textAlign: 'center', padding: 32, opacity: 0.5 }}>
                      <div style={{ fontSize: 40, marginBottom: 12 }}>✨</div>
                      <Paragraph>System is clean — nothing to reclaim.</Paragraph>
                    </div>
                  )}

                  {/* Generated Dashboard Management */}
                  <div style={{ marginTop: 20, padding: 16, borderRadius: 10, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(0,0,0,0.02)' }}>
                    <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 10 }}>
                      <div>
                        <Strong style={{ fontSize: 13 }}>📊 Generated Dashboards</Strong>
                        <div style={{ fontSize: 11, opacity: 0.6 }}>Delete one-by-one and repair sharing for tenant edit access.</div>
                      </div>
                      <Flex gap={8}>
                        <button
                          onClick={repairGeneratedDashboardSharing}
                          style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${Colors.Theme.Primary['70']}`, background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: Colors.Theme.Primary['70'] }}
                        >🔧 Repair Sharing</button>
                        <button
                          onClick={loadGeneratedDashboards}
                          disabled={isLoadingGeneratedDashboards}
                          style={{ padding: '6px 10px', borderRadius: 6, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', cursor: isLoadingGeneratedDashboards ? 'wait' : 'pointer', fontSize: 11, fontWeight: 600 }}
                        >{isLoadingGeneratedDashboards ? '⏳ Refreshing...' : '🔄 Refresh'}</button>
                      </Flex>
                    </Flex>

                    {dashboardMgmtStatus && (
                      <div style={{ padding: 10, marginBottom: 10, borderRadius: 8, fontSize: 12, fontFamily: 'monospace',
                        background: dashboardMgmtStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : dashboardMgmtStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.12)',
                        border: `1px solid ${dashboardMgmtStatus.includes('✅') ? Colors.Theme.Success['70'] : dashboardMgmtStatus.includes('❌') ? '#dc322f' : Colors.Theme.Primary['70']}` }}>
                        {dashboardMgmtStatus}
                      </div>
                    )}

                    {isLoadingGeneratedDashboards ? (
                      <div style={{ padding: 14, textAlign: 'center', opacity: 0.7 }}>⏳ Loading generated dashboards...</div>
                    ) : generatedDashboards.length === 0 ? (
                      <div style={{ padding: 14, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>No generated dashboards found.</div>
                    ) : (
                      <div style={{ maxHeight: 280, overflow: 'auto' }}>
                        {generatedDashboards.map((d: any) => (
                          <Flex key={d.id} justifyContent="space-between" alignItems="center"
                            style={{ padding: '8px 10px', marginBottom: 6, borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(255,255,255,0.02)' }}>
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <div style={{ fontSize: 12, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.name || d.id}</div>
                              <div style={{ fontSize: 10, opacity: 0.6, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{d.id}</div>
                              {d.canDelete === false && (
                                <div style={{ fontSize: 10, opacity: 0.7, color: '#dc322f', marginTop: 2 }}>
                                  🔒 Not deletable by current deploy token{d.owner ? ` (owner: ${d.owner})` : ''}
                                </div>
                              )}
                            </div>
                            <button
                              onClick={() => deleteGeneratedDashboard(d.id)}
                              disabled={deletingDashboardId === d.id || d.canDelete === false}
                              style={{ marginLeft: 10, padding: '4px 10px', borderRadius: 6, border: '1px solid #dc322f', background: d.canDelete === false ? 'rgba(220,50,47,0.03)' : 'rgba(220,50,47,0.08)', cursor: deletingDashboardId === d.id ? 'wait' : (d.canDelete === false ? 'not-allowed' : 'pointer'), fontSize: 11, fontWeight: 700, color: d.canDelete === false ? 'rgba(220,50,47,0.45)' : '#dc322f' }}
                            >{deletingDashboardId === d.id ? '⏳ Deleting...' : d.canDelete === false ? '🔒 Owner Only' : '🗑️ Delete'}</button>
                          </Flex>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              )}

              {!systemHealth && !isLoadingHealth && (
                <div style={{ textAlign: 'center', padding: 32, opacity: 0.5 }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>💾</div>
                  <Paragraph>Click <strong>Scan</strong> to analyze server disk usage and find reclaimable space.</Paragraph>
                </div>
              )}

              {isLoadingHealth && (
                <div style={{ textAlign: 'center', padding: 32 }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div>
                  <Paragraph>Scanning file system...</Paragraph>
                </div>
              )}
            </div>
            )}

          </div>
        </div>
      )}

      {/* ── Services Modal ─────────────────────────────── */}
      {showServicesModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowServicesModal(false)} />
          <div style={{ position: 'relative', width: 720, maxHeight: '85vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: `2px solid ${Colors.Border.Neutral.Default}`, boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: 'linear-gradient(135deg, rgba(220,50,47,0.9), rgba(180,30,30,0.95))', borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <span style={{ fontSize: 24 }}>🖥️</span>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Running Services</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Manage active child services</div>
                  </div>
                </Flex>
                <button onClick={() => setShowServicesModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4 }}>✕</button>
              </Flex>
            </div>

            <div style={{ padding: 24 }}>
              {/* Status */}
              {servicesStatus && (
                <div style={{ padding: 10, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                  background: servicesStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : servicesStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.12)',
                  border: `1px solid ${servicesStatus.includes('✅') ? Colors.Theme.Success['70'] : servicesStatus.includes('❌') ? '#dc322f' : Colors.Theme.Primary['70']}` }}>
                  {servicesStatus}
                </div>
              )}

              {isLoadingServices ? (
                <Flex justifyContent="center" style={{ padding: 32 }}><span style={{ fontSize: 32 }}>⏳</span></Flex>
              ) : runningServices.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 32, opacity: 0.6 }}>
                  <div style={{ fontSize: 40, marginBottom: 12 }}>🟢</div>
                  <Paragraph>No services currently running.</Paragraph>
                </div>
              ) : (
                <>
                  {/* Group by company */}
                  {(() => {
                    const groups: Record<string, RunningService[]> = {};
                    runningServices.forEach(s => {
                      const company = s.companyName || (s.service.includes('-') ? s.service.split('-').pop()! : 'Unknown');
                      if (!groups[company]) groups[company] = [];
                      groups[company].push(s);
                    });
                    return Object.entries(groups).map(([company, services]) => (
                      <div key={company} style={{ marginBottom: 16, border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 12, overflow: 'hidden' }}>
                        <div style={{ padding: '10px 16px', background: 'rgba(0,161,201,0.08)', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
                          <Flex alignItems="center" justifyContent="space-between">
                            <Flex alignItems="center" gap={8}>
                              <span style={{ fontSize: 16 }}>🏢</span>
                              <a href={getServicesUiUrl(company, services[0]?.journeyType)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
                                <Strong style={{ fontSize: 14, cursor: 'pointer', borderBottom: '1px dashed rgba(0,161,201,0.5)' }}>{company}</Strong>
                              </a>
                              <span style={{ fontSize: 12, opacity: 0.6 }}>({services.length} service{services.length !== 1 ? 's' : ''})</span>
                              {services[0]?.releaseStage && (
                                <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 4, background: 'rgba(108,44,156,0.15)', color: '#6c2c9c', fontFamily: 'monospace' }}>
                                  stage:{services[0].releaseStage}
                                </span>
                              )}
                            </Flex>
                            <Flex gap={4}>
                              <Button onClick={() => stopCompanyServices(company)} disabled={isStoppingServices} style={{ fontSize: 12, padding: '4px 12px' }}>
                                {stoppingCompany === company ? `⏳ Stopping ${company}...` : `🛑 Stop ${company}`}
                              </Button>
                            </Flex>
                          </Flex>
                        </div>
                        <div style={{ padding: 12 }}>
                          {services.map(s => (
                            <Flex key={s.pid} alignItems="center" justifyContent="space-between" style={{ padding: '6px 8px', borderRadius: 6, marginBottom: 4, background: s.running ? 'rgba(115,190,40,0.06)' : 'rgba(220,50,47,0.06)' }}>
                              <Flex alignItems="center" gap={8}>
                                <span style={{ fontSize: 10, color: s.running ? Colors.Theme.Success['70'] : '#dc322f' }}>●</span>
                                <span style={{ fontSize: 13 }}>{s.baseServiceName || s.service}</span>
                                {s.serviceVersion && (
                                  <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: 'rgba(115,190,40,0.15)', color: Colors.Theme.Success['70'], fontFamily: 'monospace', fontWeight: 600 }}>
                                    v{s.serviceVersion}.0.0
                                  </span>
                                )}
                              </Flex>
                              <Flex alignItems="center" gap={8}>
                                <span style={{ fontSize: 10, opacity: 0.4, fontFamily: 'monospace' }}>:{s.port || '?'}</span>
                                <span style={{ fontSize: 11, opacity: 0.5, fontFamily: 'monospace' }}>PID {s.pid}</span>
                              </Flex>
                            </Flex>
                          ))}
                        </div>
                      </div>
                    ));
                  })()}
                </>
              )}

              {/* Actions */}
              <Flex gap={8} style={{ marginTop: 16 }}>
                <Button onClick={() => { loadRunningServices(); loadDormantServices(); }} disabled={isLoadingServices} style={{ flex: 1 }}>🔄 Refresh</Button>
                {runningServices.length > 0 && (
                  <Button onClick={stopAllServices} disabled={isStoppingServices} style={{ flex: 1, background: 'rgba(220,50,47,0.15)', color: '#dc322f' }}>
                    {isStoppingServices ? '🛑 Stopping...' : '🛑 Stop All Services'}
                  </Button>
                )}
              </Flex>

              {/* ── Dormant Services Section ──── */}
              <div style={{ marginTop: 24, borderTop: `1px solid ${Colors.Border.Neutral.Default}`, paddingTop: 20 }}>
                <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 12 }}>
                  <Flex alignItems="center" gap={8}>
                    <span style={{ fontSize: 18 }}>💤</span>
                    <Strong style={{ fontSize: 14 }}>Dormant Services</Strong>
                    <span style={{ fontSize: 12, opacity: 0.5 }}>({dormantServices.length})</span>
                  </Flex>
                  {dormantServices.length > 0 && (
                    <Button onClick={() => setShowDormantWarning('all')} disabled={isClearingDormant} style={{ fontSize: 12, padding: '4px 14px', background: 'rgba(220,160,0,0.12)', color: '#b58900' }}>
                      {isClearingDormant ? '🧹 Clearing...' : '🧹 Clear All Dormant'}
                    </Button>
                  )}
                </Flex>

                {isLoadingDormant ? (
                  <Flex justifyContent="center" style={{ padding: 16 }}><span style={{ fontSize: 20 }}>⏳</span></Flex>
                ) : dormantServices.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 16, opacity: 0.5, fontSize: 13 }}>
                    No dormant services. Services that are stopped will appear here for quick restart.
                  </div>
                ) : (
                  <>
                    {/* Group dormant by company */}
                    {(() => {
                      const groups: Record<string, any[]> = {};
                      dormantServices.forEach((s: any) => {
                        const company = s.companyName || 'Unknown';
                        if (!groups[company]) groups[company] = [];
                        groups[company].push(s);
                      });
                      return Object.entries(groups).map(([company, services]) => (
                        <div key={`dormant-${company}`} style={{ marginBottom: 12, border: `1px dashed rgba(181,137,0,0.4)`, borderRadius: 10, overflow: 'hidden' }}>
                          <div style={{ padding: '8px 14px', background: 'rgba(181,137,0,0.06)', borderBottom: `1px dashed rgba(181,137,0,0.3)` }}>
                            <Flex alignItems="center" justifyContent="space-between">
                              <Flex alignItems="center" gap={8}>
                                <span style={{ fontSize: 14 }}>💤</span>
                                <a href={getServicesUiUrl(company, services[0]?.journeyType)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', color: 'inherit' }}>
                                  <Strong style={{ fontSize: 13, cursor: 'pointer', borderBottom: '1px dashed rgba(181,137,0,0.5)' }}>{company}</Strong>
                                </a>
                                <span style={{ fontSize: 11, opacity: 0.5 }}>({services.length} dormant)</span>
                              </Flex>
                              <Button onClick={() => setShowDormantWarning(company)} disabled={clearingDormantCompany === company} style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(220,160,0,0.1)', color: '#b58900' }}>
                                {clearingDormantCompany === company ? '⏳...' : '🧹 Clear'}
                              </Button>
                            </Flex>
                          </div>
                          <div style={{ padding: 10 }}>
                            {services.map((s: any, idx: number) => (
                              <Flex key={idx} alignItems="center" justifyContent="space-between" style={{ padding: '5px 8px', borderRadius: 6, marginBottom: 3, background: 'rgba(181,137,0,0.04)' }}>
                                <Flex alignItems="center" gap={8}>
                                  <span style={{ fontSize: 10, color: '#b58900' }}>○</span>
                                  <span style={{ fontSize: 12 }}>{s.baseServiceName || s.serviceName}</span>
                                  {s.serviceVersion && (
                                    <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: 'rgba(181,137,0,0.1)', color: '#b58900', fontFamily: 'monospace' }}>
                                      v{s.serviceVersion}
                                    </span>
                                  )}
                                </Flex>
                                <span style={{ fontSize: 10, opacity: 0.4, fontFamily: 'monospace' }}>port {s.previousPort}</span>
                              </Flex>
                            ))}
                          </div>
                        </div>
                      ));
                    })()}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Journeys Modal ─────────────────────────────── */}
      {showJourneysModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowJourneysModal(false)} />
          <div style={{ position: 'relative', width: '95vw', maxWidth: 1200, maxHeight: '92vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: `2px solid ${Colors.Border.Neutral.Default}`, boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: 'linear-gradient(135deg, rgba(0,161,201,0.9), rgba(0,140,180,0.95))', borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <span style={{ fontSize: 24 }}>🗺️</span>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Active Journeys</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Running journeys grouped by company &amp; journey type</div>
                  </div>
                </Flex>
                <Flex alignItems="center" gap={8}>
                  <button onClick={() => { loadJourneysData(); loadDormantServices(); }} disabled={isLoadingJourneys} style={{ background: 'rgba(255,255,255,0.2)', border: '1px solid rgba(255,255,255,0.3)', color: 'white', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer' }}>🔄 Refresh</button>
                  <button onClick={() => setShowJourneysModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4 }}>✕</button>
                </Flex>
              </Flex>
            </div>

            <div style={{ padding: 24 }}>
              {/* Status bar */}
              {journeysStatus && (
                <div style={{ padding: 10, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                  background: journeysStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.08)',
                  border: `1px solid ${journeysStatus.includes('❌') ? '#dc322f' : 'rgba(0,161,201,0.3)'}` }}>
                  {journeysStatus}
                </div>
              )}

              {isLoadingJourneys ? (
                <Flex justifyContent="center" style={{ padding: 32 }}><span style={{ fontSize: 32 }}>⏳</span></Flex>
              ) : journeysData.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, opacity: 0.6 }}>
                  <div style={{ fontSize: 48, marginBottom: 12 }}>🗺️</div>
                  <Paragraph style={{ fontSize: 14 }}>No active journeys. Generate services in Step 3 to see journeys here.</Paragraph>
                </div>
              ) : (
                <>
                  {/* Summary cards */}
                  {(() => {
                    // Group by company and journey identity. If a journey bucket grows beyond
                    // 6 services (legacy stale metadata), split into journey batches for clarity.
                    const grouped: Record<string, Array<{ label: string; journeyType: string; services: RunningService[] }>> = {};
                    const splitJourneyBuckets = (services: RunningService[]) => {
                      if (services.length <= 6) return [services];

                      const withStart = services.filter((s) => Number.isFinite(Number(s.startTime)) && Number(s.startTime) > 0);
                      if (withStart.length === services.length) {
                        const windows = new Map<number, RunningService[]>();
                        services.forEach((s) => {
                          const win = Math.floor(Number(s.startTime) / 120000);
                          const arr = windows.get(win) || [];
                          arr.push(s);
                          windows.set(win, arr);
                        });
                        if (windows.size > 1) {
                          return Array.from(windows.entries())
                            .sort((a, b) => a[0] - b[0])
                            .map(([, bucket]) => bucket);
                        }
                      }

                      const sorted = [...services].sort((a, b) => {
                        const aPort = Number(a.port || 0);
                        const bPort = Number(b.port || 0);
                        return aPort - bPort;
                      });
                      const chunks: RunningService[][] = [];
                      for (let i = 0; i < sorted.length; i += 6) {
                        chunks.push(sorted.slice(i, i + 6));
                      }
                      return chunks;
                    };

                    const byCompanyAndType: Record<string, Record<string, RunningService[]>> = {};
                    journeysData.forEach((s) => {
                      const company = s.companyName || 'Unknown';
                      const jType = s.journeyType || s.journeyDetail || 'Unknown';
                      if (!byCompanyAndType[company]) byCompanyAndType[company] = {};
                      if (!byCompanyAndType[company][jType]) byCompanyAndType[company][jType] = [];
                      byCompanyAndType[company][jType].push(s);
                    });

                    Object.entries(byCompanyAndType).forEach(([company, journeyTypes]) => {
                      grouped[company] = [];
                      Object.entries(journeyTypes).forEach(([jType, services]) => {
                        const buckets = splitJourneyBuckets(services);
                        buckets.forEach((bucket, idx) => {
                          const label = buckets.length > 1 ? `${jType} (${idx + 1})` : jType;
                          grouped[company].push({ label, journeyType: jType, services: bucket });
                        });
                      });
                    });

                    const totalJourneys = Object.values(grouped).reduce((sum, companyGroups) => sum + companyGroups.length, 0);
                    const totalCompanies = Object.keys(grouped).length;

                    return (
                      <div>
                        {/* Overview summary */}
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 20 }}>
                          <div style={{ padding: 14, borderRadius: 10, background: 'linear-gradient(135deg, rgba(0,161,201,0.1), rgba(0,212,255,0.06))', border: '1px solid rgba(0,161,201,0.25)', textAlign: 'center' }}>
                            <div style={{ fontSize: 28, fontWeight: 700, color: '#00a1c9' }}>{totalCompanies}</div>
                            <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', fontWeight: 600, letterSpacing: 0.5 }}>Companies</div>
                          </div>
                          <div style={{ padding: 14, borderRadius: 10, background: 'linear-gradient(135deg, rgba(115,190,40,0.1), rgba(0,212,255,0.06))', border: '1px solid rgba(115,190,40,0.25)', textAlign: 'center' }}>
                            <div style={{ fontSize: 28, fontWeight: 700, color: Colors.Theme.Success['70'] }}>{totalJourneys}</div>
                            <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', fontWeight: 600, letterSpacing: 0.5 }}>Journeys</div>
                          </div>
                          <div style={{ padding: 14, borderRadius: 10, background: 'linear-gradient(135deg, rgba(108,44,156,0.1), rgba(0,212,255,0.06))', border: '1px solid rgba(108,44,156,0.25)', textAlign: 'center' }}>
                            <div style={{ fontSize: 28, fontWeight: 700, color: '#6c2c9c' }}>{journeysData.length}</div>
                            <div style={{ fontSize: 11, opacity: 0.6, textTransform: 'uppercase', fontWeight: 600, letterSpacing: 0.5 }}>Total Services</div>
                          </div>
                        </div>

                        {/* Company → Journey Type breakdown */}
                        {Object.entries(grouped).map(([company, companyGroups]) => (
                          <div key={company} style={{ marginBottom: 16, border: `1px solid ${Colors.Border.Neutral.Default}`, borderRadius: 12, overflow: 'hidden' }}>
                            {/* Company header */}
                            <div style={{ padding: '12px 16px', background: 'linear-gradient(135deg, rgba(0,161,201,0.08), rgba(0,212,255,0.04))', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
                              <Flex alignItems="center" justifyContent="space-between">
                                <Flex alignItems="center" gap={8}>
                                  <span style={{ fontSize: 18 }}>🏢</span>
                                  <Strong style={{ fontSize: 15 }}>{company}</Strong>
                                  <span style={{ fontSize: 12, opacity: 0.5 }}>
                                    ({companyGroups.length} journey{companyGroups.length !== 1 ? 's' : ''}, {companyGroups.reduce((sum, g) => sum + g.services.length, 0)} services)
                                  </span>
                                </Flex>
                                <Flex gap={6}>
                                  <button
                                    onClick={() => stopCompanyServices(company)}
                                    disabled={isStoppingServices}
                                    style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                                      background: 'rgba(220,50,47,0.08)', border: '1px solid rgba(220,50,47,0.25)', color: '#dc322f',
                                      cursor: isStoppingServices ? 'not-allowed' : 'pointer',
                                    }}
                                  >
                                    {stoppingCompany === company ? '⏳ Stopping...' : `🛑 Stop ${company}`}
                                  </button>
                                  <a
                                    href={getServicesUiUrl(company)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                                      background: 'rgba(0,161,201,0.08)', border: '1px solid rgba(0,161,201,0.25)', color: '#00a1c9',
                                      textDecoration: 'none', cursor: 'pointer',
                                    }}
                                  >
                                    🖥️ Services
                                  </a>
                                  <a
                                    href={getDashboardSearchUrl(company)}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{
                                      display: 'inline-flex', alignItems: 'center', gap: 4,
                                      padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                                      background: 'rgba(108,44,156,0.08)', border: '1px solid rgba(108,44,156,0.25)', color: '#6c2c9c',
                                      textDecoration: 'none', cursor: 'pointer',
                                    }}
                                  >
                                    📊 Dashboards
                                  </a>
                                </Flex>
                              </Flex>
                            </div>

                            {/* Journey types within this company */}
                            <div style={{ padding: 12 }}>
                              {companyGroups.map(({ label, journeyType, services }) => {
                                const creatorCounts = new Map<string, number>();
                                services.forEach((svc) => {
                                  const label = getServiceCreatorLabel(svc);
                                  if (!label || label === 'unknown creator') return;
                                  creatorCounts.set(label, (creatorCounts.get(label) || 0) + 1);
                                });
                                const creatorDisplay = creatorCounts.size > 0
                                  ? [...creatorCounts.entries()].sort((a, b) => b[1] - a[1])[0][0]
                                  : null;

                                return (
                                <div key={`${journeyType}-${label}-${services[0]?.port || 'na'}`} style={{ marginBottom: 10, padding: 10, borderRadius: 8, background: 'rgba(115,190,40,0.04)', border: '1px dashed rgba(115,190,40,0.2)' }}>
                                  <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 6 }}>
                                    <Flex alignItems="center" gap={8}>
                                      <span style={{ fontSize: 14 }}>🗺️</span>
                                      <Strong style={{ fontSize: 13 }}>{label}</Strong>
                                      <span style={{ fontSize: 11, opacity: 0.5 }}>({services.length} service{services.length !== 1 ? 's' : ''})</span>
                                      {creatorDisplay && <span style={{ fontSize: 11, opacity: 0.7 }}>• by {creatorDisplay}</span>}
                                    </Flex>
                                    <a
                                      href={getServicesUiUrl(company, journeyType)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      style={{
                                        fontSize: 10, padding: '2px 8px', borderRadius: 4,
                                        background: 'rgba(0,161,201,0.08)', border: '1px solid rgba(0,161,201,0.2)', color: '#00a1c9',
                                        textDecoration: 'none', cursor: 'pointer',
                                      }}
                                    >
                                      View in DT →
                                    </a>
                                  </Flex>
                                  {/* Service list */}
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                                    {services.map(s => (
                                      <Flex key={s.pid} alignItems="center" gap={6} style={{ padding: '5px 12px', borderRadius: 6, background: s.running ? 'rgba(115,190,40,0.06)' : 'rgba(220,50,47,0.06)', whiteSpace: 'nowrap' }}>
                                        <span style={{ fontSize: 8, color: s.running ? Colors.Theme.Success['70'] : '#dc322f' }}>●</span>
                                        <span style={{ fontSize: 12 }}>{s.baseServiceName || s.service}</span>
                                        {s.serviceVersion && (
                                          <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: 'rgba(115,190,40,0.12)', color: Colors.Theme.Success['70'], fontFamily: 'monospace', fontWeight: 600 }}>
                                            v{s.serviceVersion}.0.0
                                          </span>
                                        )}
                                        <span style={{ fontSize: 9, opacity: 0.4, fontFamily: 'monospace' }}>:{s.port || '?'}</span>
                                      </Flex>
                                    ))}
                                  </div>

                                  {/* ── Deployment Status ── */}
                                  {(() => {
                                    const assetKey = `${company}::${journeyType}`;
                                    const asset = journeyAssets[assetKey];
                                    if (!asset) return null;
                                    return (
                                      <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 8 }}>
                                        {/* Services link */}
                                        <a
                                          href={getServicesUiUrl(company, journeyType)}
                                          target="_blank"
                                          rel="noopener noreferrer"
                                          style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 4,
                                            padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 600,
                                            background: 'rgba(115,190,40,0.1)', border: '1px solid rgba(115,190,40,0.3)', color: Colors.Theme.Success['70'],
                                            textDecoration: 'none',
                                          }}
                                        >
                                          <span style={{ fontSize: 8 }}>●</span> Services active
                                        </a>

                                        {/* Dashboard status */}
                                        {asset.dashboard.exists ? (
                                          <a
                                            href={`${TENANT_URL}${asset.dashboard.url}`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            title={asset.dashboard.name || asset.dashboard.id}
                                            style={{
                                              display: 'inline-flex', alignItems: 'center', gap: 4,
                                              padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 600,
                                              background: 'rgba(108,44,156,0.1)', border: '1px solid rgba(108,44,156,0.3)', color: '#9b59b6',
                                              textDecoration: 'none',
                                            }}
                                          >
                                            📊 Dashboard deployed
                                          </a>
                                        ) : (
                                          <span style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 4,
                                            padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 600,
                                            background: 'rgba(220,50,47,0.06)', border: '1px dashed rgba(220,50,47,0.25)', color: '#dc322f',
                                            opacity: 0.85,
                                          }}>
                                            📊 Dashboard not deployed
                                          </span>
                                        )}

                                        {/* BizFlow status */}
                                        {asset.bizflow.exists ? (
                                          <a
                                            href={`${TENANT_URL}/ui/apps/dynatrace.biz.flow/`}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            style={{
                                              display: 'inline-flex', alignItems: 'center', gap: 4,
                                              padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 600,
                                              background: 'rgba(0,161,201,0.1)', border: '1px solid rgba(0,161,201,0.3)', color: '#00a1c9',
                                              textDecoration: 'none',
                                            }}
                                          >
                                            🔄 BizFlow deployed
                                          </a>
                                        ) : (
                                          <span style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 4,
                                            padding: '3px 10px', borderRadius: 14, fontSize: 11, fontWeight: 600,
                                            background: 'rgba(220,50,47,0.06)', border: '1px dashed rgba(220,50,47,0.25)', color: '#dc322f',
                                            opacity: 0.85,
                                          }}>
                                            🔄 BizFlow not deployed
                                          </span>
                                        )}
                                      </div>
                                    );
                                  })()}
                                </div>
                                );
                              })}
                            </div>
                          </div>
                        ))}
                      </div>
                    );
                  })()}
                </>
              )}

              {/* ── Actions: Stop All ── */}
              {journeysData.length > 0 && (
                <Flex gap={8} style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${Colors.Border.Neutral.Default}` }}>
                  <Button onClick={stopAllServices} disabled={isStoppingServices} style={{ flex: 1, background: 'rgba(220,50,47,0.15)', color: '#dc322f' }}>
                    {isStoppingServices ? '🛑 Stopping...' : '🛑 Stop All Services'}
                  </Button>
                </Flex>
              )}

              {/* ── Dormant Services Section ── */}
              <div style={{ marginTop: 24, borderTop: `1px solid ${Colors.Border.Neutral.Default}`, paddingTop: 20 }}>
                <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 12 }}>
                  <Flex alignItems="center" gap={8}>
                    <span style={{ fontSize: 18 }}>💤</span>
                    <Strong style={{ fontSize: 14 }}>Dormant Services</Strong>
                    <span style={{ fontSize: 12, opacity: 0.5 }}>({dormantServices.length})</span>
                  </Flex>
                  {dormantServices.length > 0 && (
                    <Button onClick={() => setShowDormantWarning('all')} disabled={isClearingDormant} style={{ fontSize: 12, padding: '4px 14px', background: 'rgba(220,160,0,0.12)', color: '#b58900' }}>
                      {isClearingDormant ? '🧹 Clearing...' : '🧹 Clear All Dormant'}
                    </Button>
                  )}
                </Flex>

                {isLoadingDormant ? (
                  <Flex justifyContent="center" style={{ padding: 16 }}><span style={{ fontSize: 20 }}>⏳</span></Flex>
                ) : dormantServices.length === 0 ? (
                  <div style={{ textAlign: 'center', padding: 16, opacity: 0.5, fontSize: 13 }}>
                    No dormant services. Services that are stopped will appear here for quick restart.
                  </div>
                ) : (
                  <>
                    {(() => {
                      const groups: Record<string, any[]> = {};
                      dormantServices.forEach((s: any) => {
                        const company = s.companyName || 'Unknown';
                        if (!groups[company]) groups[company] = [];
                        groups[company].push(s);
                      });
                      return Object.entries(groups).map(([company, services]) => (
                        <div key={`dormant-${company}`} style={{ marginBottom: 12, border: `1px dashed rgba(181,137,0,0.4)`, borderRadius: 10, overflow: 'hidden' }}>
                          <div style={{ padding: '8px 14px', background: 'rgba(181,137,0,0.06)', borderBottom: `1px dashed rgba(181,137,0,0.3)` }}>
                            <Flex alignItems="center" justifyContent="space-between">
                              <Flex alignItems="center" gap={8}>
                                <span style={{ fontSize: 14 }}>💤</span>
                                <Strong style={{ fontSize: 13 }}>{company}</Strong>
                                <span style={{ fontSize: 11, opacity: 0.5 }}>({services.length} dormant)</span>
                              </Flex>
                              <Button onClick={() => setShowDormantWarning(company)} disabled={clearingDormantCompany === company} style={{ fontSize: 10, padding: '2px 8px', background: 'rgba(220,160,0,0.1)', color: '#b58900' }}>
                                {clearingDormantCompany === company ? '⏳...' : '🧹 Clear'}
                              </Button>
                            </Flex>
                          </div>
                          <div style={{ padding: 10 }}>
                            {services.map((s: any, idx: number) => (
                              <Flex key={idx} alignItems="center" justifyContent="space-between" style={{ padding: '5px 8px', borderRadius: 6, marginBottom: 3, background: 'rgba(181,137,0,0.04)' }}>
                                <Flex alignItems="center" gap={8}>
                                  <span style={{ fontSize: 10, color: '#b58900' }}>○</span>
                                  <span style={{ fontSize: 12 }}>{s.baseServiceName || s.serviceName}</span>
                                  {s.serviceVersion && (
                                    <span style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, background: 'rgba(181,137,0,0.1)', color: '#b58900', fontFamily: 'monospace' }}>
                                      v{s.serviceVersion}
                                    </span>
                                  )}
                                </Flex>
                                <span style={{ fontSize: 10, opacity: 0.4, fontFamily: 'monospace' }}>port {s.previousPort}</span>
                              </Flex>
                            ))}
                          </div>
                        </div>
                      ));
                    })()}
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Dormant Warning Confirmation Modal ──── */}
      {showDormantWarning && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10001, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.5)' }} onClick={() => setShowDormantWarning(null)} />
          <div style={{ position: 'relative', width: 440, background: Colors.Background.Surface.Default, borderRadius: 14, border: `2px solid #b58900`, boxShadow: '0 16px 40px rgba(0,0,0,0.3)' }}>
            <div style={{ padding: '16px 20px', background: 'linear-gradient(135deg, rgba(181,137,0,0.15), rgba(220,160,0,0.1))', borderRadius: '12px 12px 0 0', borderBottom: `1px solid rgba(181,137,0,0.3)` }}>
              <Flex alignItems="center" gap={8}>
                <span style={{ fontSize: 22 }}>⚠️</span>
                <Strong style={{ fontSize: 15 }}>Clear Dormant Services</Strong>
              </Flex>
            </div>
            <div style={{ padding: 20 }}>
              <Paragraph style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.6 }}>
                {showDormantWarning === 'all'
                  ? 'You are about to clear ALL dormant services.'
                  : `You are about to clear dormant services for "${showDormantWarning}".`}
              </Paragraph>
              <div style={{ padding: 12, borderRadius: 8, background: 'rgba(220,50,47,0.08)', border: '1px solid rgba(220,50,47,0.3)', marginBottom: 16 }}>
                <Strong style={{ fontSize: 12, color: '#dc322f', display: 'block', marginBottom: 6 }}>⚠️ Duplicate Service Warning</Strong>
                <Paragraph style={{ fontSize: 12, opacity: 0.85, lineHeight: 1.5, margin: 0 }}>
                  If you re-enable these services within <Strong>24 hours</Strong>, Dynatrace may detect them as <Strong>duplicate services</Strong> because OneAgent remembers the previous process group. This can cause:
                </Paragraph>
                <ul style={{ fontSize: 11, opacity: 0.8, margin: '6px 0 0 0', paddingLeft: 20, lineHeight: 1.6 }}>
                  <li>Split service metrics (old vs new instance)</li>
                  <li>Confusing service topology in Smartscape</li>
                  <li>Duplicate entries in the Services screen</li>
                </ul>
                <Paragraph style={{ fontSize: 12, opacity: 0.85, marginTop: 8, marginBottom: 0 }}>
                  <Strong>Tip:</Strong> Use the <code style={{ fontSize: 11, background: 'rgba(0,0,0,0.1)', padding: '1px 4px', borderRadius: 3 }}>version</code> and <code style={{ fontSize: 11, background: 'rgba(0,0,0,0.1)', padding: '1px 4px', borderRadius: 3 }}>stage</code> tags in Dynatrace to filter by generation.
                </Paragraph>
              </div>
              <Flex gap={8}>
                <Button onClick={() => setShowDormantWarning(null)} style={{ flex: 1 }}>Cancel</Button>
                <Button onClick={() => showDormantWarning === 'all' ? clearAllDormantServices() : clearCompanyDormantServices(showDormantWarning)} style={{ flex: 1, background: 'rgba(220,50,47,0.15)', color: '#dc322f', fontWeight: 600 }}>
                  🗑️ Clear {showDormantWarning === 'all' ? 'All' : showDormantWarning} Dormant
                </Button>
              </Flex>
            </div>
          </div>
        </div>
      )}

      {/* ── Chaos Nemesis Agent Modal ─────────────────────────────── */}
      {showChaosModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowChaosModal(false)} />
          <div style={{ position: 'relative', width: 760, maxHeight: '85vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: '2px solid rgba(181,137,0,0.5)', boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: 'linear-gradient(135deg, rgba(107,142,35,0.85), rgba(181,137,0,0.9))', borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <svg width="32" height="32" viewBox="0 0 64 64">
                    <circle cx="32" cy="34" r="22" fill="#6b8e23"/>
                    <ellipse cx="22" cy="28" rx="6" ry="7" fill="white"/>
                    <ellipse cx="42" cy="28" rx="6" ry="7" fill="white"/>
                    <circle cx="23" cy="28" r="3.5" fill="#dc322f"/>
                    <circle cx="43" cy="28" r="3.5" fill="#dc322f"/>
                    <path d="M22 42 Q32 50 42 42" stroke="white" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
                    <rect x="24" y="42" width="3" height="4" rx="1" fill="white" transform="rotate(-8 25.5 44)"/>
                    <rect x="30.5" y="43" width="3" height="4.5" rx="1" fill="white"/>
                    <rect x="37" y="42" width="3" height="4" rx="1" fill="white" transform="rotate(8 38.5 44)"/>
                    <path d="M14 16 Q18 24 22 22" stroke="#6b8e23" strokeWidth="3" fill="none" strokeLinecap="round"/>
                    <path d="M50 16 Q46 24 42 22" stroke="#6b8e23" strokeWidth="3" fill="none" strokeLinecap="round"/>
                    <ellipse cx="12" cy="14" rx="4" ry="5" fill="#6b8e23"/>
                    <ellipse cx="52" cy="14" rx="4" ry="5" fill="#6b8e23"/>
                  </svg>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Chaos Nemesis Agent</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Inject faults · Test resilience · Observe recovery</div>
                  </div>
                </Flex>
                <Flex alignItems="center" gap={8}>
                  <button onClick={loadChaosData} disabled={isLoadingChaos} style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: 'white', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 12 }}>
                    {isLoadingChaos ? '⏳' : '🔄'} Refresh
                  </button>
                  <button onClick={() => setShowChaosModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4 }}>✕</button>
                </Flex>
              </Flex>
            </div>

            {/* Tabs */}
            <div style={{ display: 'flex', borderBottom: `1px solid ${Colors.Border.Neutral.Default}`, background: 'rgba(181,137,0,0.04)' }}>
              {([
                { key: 'active', label: '🔥 Active Faults', badge: activeFaults.length },
                { key: 'inject', label: '💉 Inject' },
                { key: 'targeted', label: '🎯 Targeted', badge: Object.keys(targetedServices).length },
                { key: 'smart', label: '🤖 Smart Chaos' },
              ] as { key: typeof chaosTab; label: string; badge?: number }[]).map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setChaosTab(tab.key)}
                  style={{
                    flex: 1, padding: '10px 0', border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: chaosTab === tab.key ? 700 : 500,
                    background: chaosTab === tab.key ? 'rgba(181,137,0,0.12)' : 'transparent',
                    borderBottom: chaosTab === tab.key ? '2px solid #b58900' : '2px solid transparent',
                    color: chaosTab === tab.key ? '#b58900' : 'inherit',
                    transition: 'all 0.15s ease',
                  }}
                >
                  {tab.label}
                  {tab.badge != null && tab.badge > 0 && (
                    <span style={{ marginLeft: 6, background: '#dc322f', color: 'white', borderRadius: 8, padding: '1px 6px', fontSize: 10, fontWeight: 700 }}>{tab.badge}</span>
                  )}
                </button>
              ))}
            </div>

            {/* Status bar */}
            {chaosStatus && (
              <div style={{ padding: '8px 24px', fontSize: 12, fontFamily: 'monospace',
                background: chaosStatus.includes('✅') ? 'rgba(115,190,40,0.1)' : chaosStatus.includes('❌') ? 'rgba(220,50,47,0.1)' : chaosStatus.includes('⚠️') ? 'rgba(181,137,0,0.1)' : 'rgba(0,161,201,0.08)',
                borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
                {chaosStatus}
              </div>
            )}

            <div style={{ padding: 24 }}>
              {isLoadingChaos ? (
                <Flex justifyContent="center" style={{ padding: 32 }}><span style={{ fontSize: 32 }}>⏳</span></Flex>
              ) : (
                <>
                  {/* ─── Tab 1: Active Faults ─── */}
                  {chaosTab === 'active' && (
                    <div>
                      {activeFaults.length === 0 ? (
                        <div style={{ textAlign: 'center', padding: 40, opacity: 0.5 }}>
                          <div style={{ fontSize: 48, marginBottom: 12 }}>😇</div>
                          <Paragraph>No active faults. All services running clean.</Paragraph>
                        </div>
                      ) : (
                        <>
                          {activeFaults.map((fault: any, idx: number) => (
                            <div key={fault.id || idx} style={{ marginBottom: 12, border: `1px solid rgba(220,50,47,0.3)`, borderRadius: 10, overflow: 'hidden' }}>
                              <div style={{ padding: '10px 16px', background: 'rgba(220,50,47,0.06)' }}>
                                <Flex alignItems="center" justifyContent="space-between">
                                  <Flex alignItems="center" gap={8}>
                                    <span style={{ fontSize: 16 }}>🔥</span>
                                    <div>
                                      <Strong style={{ fontSize: 13 }}>{fault.type || 'unknown'}</Strong>
                                      {fault.target && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>→ {fault.target}</span>}
                                    </div>
                                  </Flex>
                                  <button
                                    onClick={() => revertFault(fault.id || fault.chaosId)}
                                    disabled={isRevertingChaos}
                                    style={{ background: 'rgba(115,190,40,0.12)', border: '1px solid rgba(115,190,40,0.4)', color: Colors.Theme.Success['70'], borderRadius: 6, padding: '4px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                                  >
                                    {isRevertingChaos ? '⏳' : '↩️'} Revert
                                  </button>
                                </Flex>
                              </div>
                              <div style={{ padding: '8px 16px', display: 'flex', gap: 16, fontSize: 11, opacity: 0.7, fontFamily: 'monospace' }}>
                                {fault.intensity != null && <span>intensity: {fault.intensity}</span>}
                                {fault.durationMs != null && <span>duration: {Math.round(fault.durationMs / 1000)}s</span>}
                                {fault.injectedAt && <span>injected: {new Date(fault.injectedAt).toLocaleTimeString()}</span>}
                                {fault.status && <span>status: {fault.status}</span>}
                              </div>
                            </div>
                          ))}
                          <div style={{ marginTop: 16 }}>
                            <button
                              onClick={revertAllFaults}
                              disabled={isRevertingChaos}
                              style={{ width: '100%', padding: '10px 0', borderRadius: 8, border: '2px solid rgba(220,50,47,0.5)', background: 'rgba(220,50,47,0.08)', color: '#dc322f', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}
                            >
                              {isRevertingChaos ? '⏳ Reverting...' : '🚨 Revert All Faults (Panic)'}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  )}

                  {/* ─── Tab 2: Inject ─── */}
                  {chaosTab === 'inject' && (
                    <div>
                      <div style={{ marginBottom: 12 }}>
                        <Strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>🏢 Company Filter</Strong>
                        <select
                          value={chaosFilterCompany}
                          onChange={e => { setChaosFilterCompany(e.target.value); setInjectForm(prev => ({ ...prev, target: '' })); }}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Surface.Default, color: 'inherit', fontSize: 13 }}
                        >
                          <option value="all">All companies</option>
                          {chaosCompanyOptions.map(company => (
                            <option key={company} value={company}>{company}</option>
                          ))}
                        </select>
                      </div>

                      <div style={{ marginBottom: 16 }}>
                        <Strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>👤 Creator Filter</Strong>
                        <select
                          value={chaosFilterCreator}
                          onChange={e => { setChaosFilterCreator(e.target.value); setInjectForm(prev => ({ ...prev, target: '' })); }}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Surface.Default, color: 'inherit', fontSize: 13 }}
                        >
                          <option value="all">All creators</option>
                          {chaosCreatorOptions.map(creator => (
                            <option key={creator} value={creator}>{creator}</option>
                          ))}
                        </select>
                      </div>

                      {/* Target Service Dropdown */}
                      <div style={{ marginBottom: 16 }}>
                        <Strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>🔧 Target Service</Strong>
                        <select
                          value={injectForm.target}
                          onChange={e => setInjectForm(prev => ({ ...prev, target: e.target.value }))}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Surface.Default, color: 'inherit', fontSize: 13 }}
                        >
                          <option value="">— Select a service —</option>
                          {chaosTargetServices.map((s: any) => (
                            <option key={`${s.pid || s.service}-${s.companyName || 'unknown'}`} value={s.baseServiceName || s.service}>{s.baseServiceName || s.service} ({s.companyName || 'unknown'})</option>
                          ))}
                        </select>
                        {chaosTargetServices.length === 0 && (
                          <div style={{ marginTop: 6, fontSize: 11, opacity: 0.7 }}>No running services match the selected company/creator filters.</div>
                        )}
                      </div>

                      {/* Chaos Type */}
                      <div style={{ marginBottom: 16 }}>
                        <Strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>⚡ Chaos Type</Strong>
                        <select
                          value={injectForm.type}
                          onChange={e => setInjectForm(prev => ({ ...prev, type: e.target.value }))}
                          style={{ width: '100%', padding: '8px 12px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Surface.Default, color: 'inherit', fontSize: 13 }}
                        >
                          <option value="enable_errors">🔴 Enable Errors — Turn on error injection</option>
                          <option value="increase_error_rate">📈 Increase Error Rate — Raise error rate</option>
                          <option value="slow_responses">🐌 Slow Responses — Add latency</option>
                          <option value="disable_circuit_breaker">💥 Disable Circuit Breaker — Remove protection</option>
                          <option value="disable_cache">🗑️ Disable Cache — Increase load</option>
                          <option value="custom_flag">🏴 Custom Flag — Set any feature flag</option>
                        </select>
                      </div>

                      {/* Intensity */}
                      <div style={{ marginBottom: 16 }}>
                        <Flex justifyContent="space-between" alignItems="center" style={{ marginBottom: 6 }}>
                          <Strong style={{ fontSize: 12 }}>🔥 Intensity</Strong>
                          <span style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: injectForm.intensity >= 8 ? '#dc322f' : injectForm.intensity >= 5 ? '#b58900' : Colors.Theme.Success['70'] }}>
                            {injectForm.intensity}/10 ({injectForm.intensity * 10}%)
                          </span>
                        </Flex>
                        <input
                          type="range"
                          min={1} max={10} step={1}
                          value={injectForm.intensity}
                          onChange={e => setInjectForm(prev => ({ ...prev, intensity: Number(e.target.value) }))}
                          style={{ width: '100%', accentColor: '#b58900' }}
                        />
                        <Flex justifyContent="space-between" style={{ fontSize: 10, opacity: 0.5, marginTop: 2 }}>
                          <span>1 — Low</span><span>5 — Moderate</span><span>10 — Catastrophic</span>
                        </Flex>
                      </div>

                      {/* Duration */}
                      <div style={{ marginBottom: 20 }}>
                        <Strong style={{ fontSize: 12, display: 'block', marginBottom: 6 }}>⏱️ Duration (seconds)</Strong>
                        <Flex gap={8} alignItems="center">
                          <input
                            type="number"
                            min={10} max={3600}
                            value={injectForm.duration}
                            onChange={e => setInjectForm(prev => ({ ...prev, duration: Number(e.target.value) }))}
                            style={{ width: 100, padding: '8px 12px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Surface.Default, color: 'inherit', fontSize: 13 }}
                          />
                          <Flex gap={4}>
                            {[30, 60, 120, 300].map(d => (
                              <button key={d} onClick={() => setInjectForm(prev => ({ ...prev, duration: d }))}
                                style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${injectForm.duration === d ? '#b58900' : Colors.Border.Neutral.Default}`, background: injectForm.duration === d ? 'rgba(181,137,0,0.15)' : 'transparent', color: injectForm.duration === d ? '#b58900' : 'inherit', cursor: 'pointer', fontSize: 11, fontWeight: injectForm.duration === d ? 700 : 400 }}
                              >{d < 60 ? `${d}s` : `${d / 60}m`}</button>
                            ))}
                          </Flex>
                        </Flex>
                      </div>

                      {/* Inject Button */}
                      <button
                        onClick={injectChaos}
                        disabled={isInjectingChaos || !injectForm.target || chaosTargetServices.length === 0}
                        style={{
                          width: '100%', padding: '12px 0', borderRadius: 10,
                          border: '2px solid rgba(181,137,0,0.6)',
                          background: !injectForm.target ? 'rgba(128,128,128,0.1)' : 'linear-gradient(135deg, rgba(181,137,0,0.15), rgba(220,50,47,0.1))',
                          color: !injectForm.target ? 'rgba(128,128,128,0.5)' : '#b58900',
                          fontWeight: 700, fontSize: 15, cursor: injectForm.target ? 'pointer' : 'not-allowed',
                          transition: 'all 0.2s ease',
                        }}
                      >
                        {isInjectingChaos ? '⏳ Injecting...' : '👹 Unleash Nemesis'}
                      </button>
                    </div>
                  )}

                  {/* ─── Tab 3: Targeted Services ─── */}
                  {chaosTab === 'targeted' && (
                    <div>
                      {Object.keys(targetedServices).length === 0 ? (
                        <div style={{ textAlign: 'center', padding: 40, opacity: 0.5 }}>
                          <div style={{ fontSize: 48, marginBottom: 12 }}>🎯</div>
                          <Paragraph>No per-service overrides active.</Paragraph>
                          <div style={{ fontSize: 12, marginTop: 8, opacity: 0.7 }}>When you inject faults targeting specific services, their overrides will appear here.</div>
                        </div>
                      ) : (
                        <>
                          {Object.entries(targetedServices).map(([serviceName, flags]: [string, any]) => (
                            <div key={serviceName} style={{ marginBottom: 12, border: `1px solid rgba(181,137,0,0.3)`, borderRadius: 10, overflow: 'hidden' }}>
                              <div style={{ padding: '10px 16px', background: 'rgba(181,137,0,0.06)' }}>
                                <Flex alignItems="center" justifyContent="space-between">
                                  <Flex alignItems="center" gap={8}>
                                    <span style={{ fontSize: 16 }}>🎯</span>
                                    <Strong style={{ fontSize: 13 }}>{serviceName}</Strong>
                                  </Flex>
                                  <button
                                    onClick={() => removeTargetedService(serviceName)}
                                    style={{ background: 'rgba(220,50,47,0.1)', border: '1px solid rgba(220,50,47,0.3)', color: '#dc322f', borderRadius: 6, padding: '4px 14px', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                                  >
                                    🗑️ Remove
                                  </button>
                                </Flex>
                              </div>
                              <div style={{ padding: '8px 16px' }}>
                                {typeof flags === 'object' && flags !== null ? (
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                                    {Object.entries(flags).map(([flag, value]: [string, any]) => (
                                      <span key={flag} style={{ fontSize: 11, padding: '3px 8px', borderRadius: 6, background: 'rgba(181,137,0,0.08)', border: '1px solid rgba(181,137,0,0.2)', fontFamily: 'monospace' }}>
                                        {flag}: <Strong>{String(value)}</Strong>
                                      </span>
                                    ))}
                                  </div>
                                ) : (
                                  <span style={{ fontSize: 12, opacity: 0.6, fontFamily: 'monospace' }}>{JSON.stringify(flags)}</span>
                                )}
                              </div>
                            </div>
                          ))}
                        </>
                      )}
                    </div>
                  )}

                  {/* ─── Tab 4: Smart Chaos ─── */}
                  {chaosTab === 'smart' && (
                    <div>
                      <div style={{ textAlign: 'center', marginBottom: 20 }}>
                        <span style={{ fontSize: 40 }}>🤖</span>
                        <div style={{ fontSize: 14, marginTop: 8, opacity: 0.8 }}>Describe what you want to break in plain English.</div>
                        <div style={{ fontSize: 12, marginTop: 4, opacity: 0.5 }}>The AI agent will pick the right recipe, target, intensity, and duration.</div>
                      </div>

                      <div style={{ marginBottom: 16 }}>
                        <textarea
                          value={smartChaosGoal}
                          onChange={e => setSmartChaosGoal(e.target.value)}
                          placeholder="e.g. &quot;Cause high errors on the checkout service for 2 minutes&quot; or &quot;Slow down all services to test circuit breakers&quot;"
                          rows={3}
                          style={{ width: '100%', padding: '12px 14px', borderRadius: 10, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Surface.Default, color: 'inherit', fontSize: 13, resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box' }}
                        />
                      </div>

                      <button
                        onClick={runSmartChaos}
                        disabled={isSmartChaosRunning || !smartChaosGoal.trim()}
                        style={{
                          width: '100%', padding: '12px 0', borderRadius: 10,
                          border: '2px solid rgba(0,161,201,0.5)',
                          background: !smartChaosGoal.trim() ? 'rgba(128,128,128,0.1)' : 'linear-gradient(135deg, rgba(0,161,201,0.15), rgba(108,44,156,0.1))',
                          color: !smartChaosGoal.trim() ? 'rgba(128,128,128,0.5)' : Colors.Theme.Primary['70'],
                          fontWeight: 700, fontSize: 15, cursor: smartChaosGoal.trim() ? 'pointer' : 'not-allowed',
                          transition: 'all 0.2s ease',
                        }}
                      >
                        {isSmartChaosRunning ? '⏳ AI is thinking...' : '🤖 Run Smart Chaos'}
                      </button>

                      {/* Example goals */}
                      <div style={{ marginTop: 20 }}>
                        <Strong style={{ fontSize: 11, display: 'block', marginBottom: 8, opacity: 0.5 }}>EXAMPLE GOALS</Strong>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                          {[
                            'Cause high errors on the payment service for 2 minutes',
                            'Slow down all services to test timeout handling',
                            'Disable circuit breakers to see error propagation',
                            'Target Acme Corp with intermittent errors',
                            'Run a moderate cache failure for 5 minutes',
                          ].map((example, idx) => (
                            <button
                              key={idx}
                              onClick={() => setSmartChaosGoal(example)}
                              style={{ textAlign: 'left', padding: '8px 12px', borderRadius: 8, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12, opacity: 0.7, transition: 'all 0.15s ease' }}
                              onMouseOver={e => { e.currentTarget.style.background = 'rgba(0,161,201,0.08)'; e.currentTarget.style.opacity = '1'; }}
                              onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.opacity = '0.7'; }}
                            >
                              💡 {example}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}



      {/* ── Generate Visuals Modal (Dashboard + Executive Summary) ─────────────────── */}
      {showGenerateDashboardModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowGenerateDashboardModal(false)} />
          <div style={{ position: 'relative', width: 580, maxHeight: '85vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: `2px solid ${Colors.Theme.Primary['70']}`, boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: 'linear-gradient(135deg, #00a1c9, #00d4ff)', borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <span style={{ fontSize: 24 }}>🎨</span>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Generate Visuals</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>Executive Summary Documents</div>
                  </div>
                </Flex>
                <button onClick={() => setShowGenerateDashboardModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4 }}>✕</button>
              </Flex>
            </div>

            {/* Sub-tab Selector */}
            <div style={{ display: 'flex', gap: 8, padding: '12px 24px 0 24px', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
              {(
                DASHBOARD_DTCTL_UI_ENABLED
                  ? [
                    { key: 'dashboard', label: 'Dashboard' },
                    { key: 'saved', label: 'Saved Versions' },
                    { key: 'pdf', label: 'Executive Summary' },
                  ]
                  : [{ key: 'pdf', label: 'Executive Summary' }]
              ).map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setVisualsSubTab(tab.key as 'dashboard' | 'saved' | 'pdf')}
                  style={{
                    padding: '10px 14px',
                    borderRadius: '10px 10px 0 0',
                    border: 'none',
                    borderBottom: visualsSubTab === tab.key ? `2px solid ${Colors.Theme.Primary['70']}` : '2px solid transparent',
                    background: visualsSubTab === tab.key ? 'rgba(0,161,201,0.08)' : 'transparent',
                    color: 'inherit',
                    cursor: 'pointer',
                    fontWeight: visualsSubTab === tab.key ? 700 : 500,
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Content */}
            <div style={{ padding: 24 }}>

              {visualsSubTab !== 'pdf' && (
                <div style={{
                  padding: 10,
                  marginBottom: 16,
                  borderRadius: 8,
                  fontSize: 12,
                  background: dashboardDeployPreflight.status === 'ready'
                    ? 'rgba(115,190,40,0.12)'
                    : dashboardDeployPreflight.status === 'error'
                      ? 'rgba(220,50,47,0.12)'
                      : 'rgba(0,161,201,0.12)',
                  border: `1px solid ${dashboardDeployPreflight.status === 'ready'
                    ? Colors.Theme.Success['70']
                    : dashboardDeployPreflight.status === 'error'
                      ? '#dc322f'
                      : Colors.Theme.Primary['70']}`,
                }}>
                  <Flex alignItems="center" justifyContent="space-between" gap={12}>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ display: 'block', marginBottom: 4 }}>
                        {dashboardDeployPreflight.status === 'ready' ? '🟢 Deploy Ready' : dashboardDeployPreflight.status === 'error' ? '🔴 Deploy Not Ready' : '🟡 Checking Deploy Readiness'}
                      </Strong>
                      <div>{dashboardDeployPreflight.message}</div>
                    </div>
                    <button
                      onClick={() => setShowDashboardPreflightDetails(prev => !prev)}
                      style={{
                        padding: '6px 10px',
                        borderRadius: 6,
                        border: `1px solid ${Colors.Border.Neutral.Default}`,
                        background: 'rgba(255,255,255,0.35)',
                        color: 'inherit',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontWeight: 600,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {showDashboardPreflightDetails ? 'Hide details' : 'Preflight details'}
                    </button>
                  </Flex>
                  {showDashboardPreflightDetails && (
                    <div style={{ marginTop: 10, fontSize: 11, fontFamily: 'monospace', lineHeight: 1.6, opacity: 0.9 }}>
                      <div>dtctl: {dashboardDeployPreflight.details?.dtctl?.version || 'unknown'}</div>
                      <div>Path: {dashboardDeployPreflight.details?.dtctl?.path || 'n/a'}</div>
                      <div>Environment: {dashboardDeployPreflight.details?.dynatrace?.environmentUrl || 'n/a'}</div>
                      <div>Environment configured: {String(dashboardDeployPreflight.details?.dynatrace?.environmentConfigured ?? false)}</div>
                      <div>Token configured: {String(dashboardDeployPreflight.details?.dynatrace?.tokenConfigured ?? false)}</div>
                    </div>
                  )}
                </div>
              )}

              {/* ===== Dashboard Sub-Tab ===== */}
              {DASHBOARD_DTCTL_UI_ENABLED && visualsSubTab === 'dashboard' && (
                <>
                  {/* Status Message */}
                  {dashboardGenerationStatus && (
                    <div style={{ padding: 12, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                      background: dashboardGenerationStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : dashboardGenerationStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.12)',
                      border: `1px solid ${dashboardGenerationStatus.includes('✅') ? Colors.Theme.Success['70'] : dashboardGenerationStatus.includes('❌') ? '#dc322f' : Colors.Theme.Primary['70']}` }}>
                      {dashboardGenerationStatus}
                      {dashboardUrl && dashboardGenerationStatus.includes('✅') && (
                        <div style={{ marginTop: 8 }}>
                          <a
                            href={dashboardUrl ?? undefined}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: '#00a1c9', fontWeight: 700, textDecoration: 'none', fontSize: 14 }}
                          >
                            📊 Open Dashboard in Dynatrace →
                          </a>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Company Selector */}
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8, color: Colors.Theme.Primary['70'] }}>🏢 Company</label>
                    {isLoadingDashboardData ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6 }}>⏳ Loading companies...</div>
                    ) : availableCompanies.length === 0 ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>No companies found. Deploy services first.</div>
                    ) : (
                      <select
                        value={dashboardCompanyName}
                        onChange={(e) => { setDashboardCompanyName(e.target.value); setDashboardJourneyType(''); }}
                        style={{
                          width: '100%', padding: '10px 14px', borderRadius: 8,
                          border: `1px solid ${Colors.Border.Neutral.Default}`,
                          background: Colors.Background.Surface.Default,
                          color: 'inherit', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        <option value="">-- Select a company --</option>
                        {availableCompanies.map(company => (
                          <option key={company} value={company}>{company}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Journey Type Selector */}
                  <div style={{ marginBottom: 20 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8, color: Colors.Theme.Primary['70'] }}>🗺️ Journey Type</label>
                    {isLoadingDashboardData ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6 }}>⏳ Loading journeys...</div>
                    ) : !dashboardCompanyName ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>Select a company first.</div>
                    ) : (() => {
                      const filtered = Array.from(new Set(journeyInventory.filter(s => s.companyName === dashboardCompanyName).map(s => s.journeyType).filter(Boolean))).sort();
                      return filtered.length === 0 ? (
                        <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>No journey types found for {dashboardCompanyName}.</div>
                      ) : (
                        <select
                          value={dashboardJourneyType}
                          onChange={(e) => setDashboardJourneyType(e.target.value)}
                          style={{
                            width: '100%', padding: '10px 14px', borderRadius: 8,
                            border: `1px solid ${Colors.Border.Neutral.Default}`,
                            background: Colors.Background.Surface.Default,
                            color: 'inherit', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <option value="">-- Select a journey type --</option>
                          {filtered.map(journey => (
                            <option key={journey} value={journey}>{journey}</option>
                          ))}
                        </select>
                      );
                    })()}
                  </div>

                  {/* BizEvents Availability Badge */}
                  {(dashboardCompanyName && dashboardJourneyType) && (
                    <div style={{ marginBottom: 16, padding: '10px 14px', borderRadius: 8, fontSize: 12,
                      background: isBizEventsChecking ? 'rgba(0,161,201,0.08)' : bizEventsAvailable ? 'rgba(115,190,40,0.12)' : 'rgba(220,50,47,0.10)',
                      border: `1px solid ${isBizEventsChecking ? Colors.Theme.Primary['70'] : bizEventsAvailable ? '#73be28' : '#dc322f'}`,
                      display: 'flex', alignItems: 'center', gap: 8,
                    }}>
                      {isBizEventsChecking
                        ? <><span>⏳</span><span>Checking for BizEvents...</span></>
                        : bizEventsAvailable
                          ? <><span>✅</span><Strong>BizEvents available</Strong><span style={{opacity:0.7}}>— {bizEventsCount.toLocaleString()} events found for {dashboardCompanyName} / {dashboardJourneyType}</span></>
                          : <><span>❌</span><Strong>No BizEvents found</Strong><span style={{opacity:0.7}}>— Run a journey first, then wait 30–60s for events to ingest</span></>
                      }
                    </div>
                  )}

                  {/* Dashboard Focus — free-text only, AI-driven from bizevents fields */}
                  <div style={{ marginBottom: 20 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#6c2c9c' }}>
                      🧠 Dashboard Focus <span style={{ fontWeight: 400, opacity: 0.6 }}>(optional — leave blank to auto-generate from journey data)</span>
                    </label>

                    {/* Free-text Custom Prompt */}
                    <textarea
                      value={mcpDashboardPrompt}
                      onChange={(e) => setMcpDashboardPrompt(e.target.value)}
                      placeholder="e.g. &quot;Focus on churn risk vs revenue by customer segment, with error hotspots per journey step&quot; — or leave blank to auto-generate"
                      style={{
                        width: '100%', minHeight: 80, padding: '10px 14px', borderRadius: 8,
                        border: `1px solid ${mcpDashboardPrompt ? '#6c2c9c' : Colors.Border.Neutral.Default}`,
                        background: mcpDashboardPrompt ? 'rgba(108,44,156,0.04)' : Colors.Background.Surface.Default,
                        color: 'inherit', fontSize: 13, fontFamily: 'inherit', resize: 'vertical',
                        transition: 'border-color 0.2s, background 0.2s',
                      }}
                    />
                    {mcpDashboardPrompt && (
                      <div style={{ fontSize: 11, marginTop: 4, color: '#6c2c9c', opacity: 0.8 }}>
                        🎯 AI will shape the dashboard around your focus using real bizevents fields from this journey
                      </div>
                    )}
                    {mcpDashboardPrompt && (
                      <button
                        onClick={() => setMcpDashboardPrompt('')}
                        style={{ marginTop: 6, padding: '4px 12px', fontSize: 11, borderRadius: 6, border: '1px solid #ccc', background: 'transparent', color: 'inherit', cursor: 'pointer' }}
                      >✕ Clear</button>
                    )}
                  </div>

                  {/* Generate & Deploy Button */}
                  <Flex gap={8}>
                    <Button
                      onClick={generateAndDeployDashboard}
                      disabled={isGeneratingDashboard || isLoadingDashboardData || !dashboardCompanyName || !dashboardJourneyType || isBizEventsChecking || bizEventsAvailable !== true}
                      variant="emphasized"
                      style={{ flex: 1, fontWeight: 700 }}
                    >
                      {isGeneratingDashboard ? '⏳ Deploying via dtctl...' : isBizEventsChecking ? '⏳ Checking events...' : mcpDashboardPrompt ? '🧠 Ask AI & Deploy via dtctl' : '🚀 Generate & Deploy via dtctl'}
                    </Button>
                    <Button onClick={() => setShowGenerateDashboardModal(false)} style={{ flex: 1 }}>Cancel</Button>
                  </Flex>

                  {/* Info Box */}
                  <div style={{ marginTop: 16, padding: 12, borderRadius: 8, background: 'rgba(0,161,201,0.08)', border: `1px solid ${Colors.Theme.Primary['70']}`, fontSize: 12, lineHeight: 1.6 }}>
                    <Strong style={{ color: Colors.Theme.Primary['70'], display: 'block', marginBottom: 8 }}>✨ How it works</Strong>
                    <ul style={{ margin: 0, paddingLeft: 20 }}>
                      <li><strong>Preset prompts</strong> are tuned to produce distinct dashboards — each targets a different audience and data focus</li>
                      <li>Claude first samples recent <code>bizevents</code> for the selected company and journey to discover real fields before generating DQL</li>
                      <li>Every <code>fetch bizevents</code> query is enforced to include both filters: <code>json.companyName == $EventProvider</code> and <code>json.journeyType == $JourneyType</code></li>
                      <li>Each prompt generates a <strong>unique dashboard ID</strong> — different prompts won't overwrite each other</li>
                      <li>Free-text prompts can reference discovered fields like <code>additionalfields.churnRisk</code> and <code>additionalfields.orderTotal</code></li>
                      <li>Dashboard is deployed directly to Dynatrace — click the link to open it</li>
                    </ul>
                  </div>
                </>
              )}

              {/* ===== Saved Dashboards Sub-Tab ===== */}
              {DASHBOARD_DTCTL_UI_ENABLED && visualsSubTab === 'saved' && (
                <>
                  {isLoadingSavedDashboards ? (
                    <div style={{ padding: 24, textAlign: 'center', opacity: 0.6 }}>⏳ Loading saved dashboards...</div>
                  ) : savedDashboards.length === 0 ? (
                    <div style={{ padding: 24, textAlign: 'center', opacity: 0.6, fontSize: 13 }}>
                      No saved dashboards yet. Generate a dashboard first — it will auto-save here.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10, marginBottom: 6 }}>
                        <select
                          value={savedDashboardFilterCompany}
                          onChange={(e) => setSavedDashboardFilterCompany(e.target.value)}
                          style={{
                            width: '100%', padding: '10px 12px', borderRadius: 8,
                            border: `1px solid ${Colors.Border.Neutral.Default}`,
                            background: Colors.Background.Surface.Default,
                            color: 'inherit', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <option value="all">All companies</option>
                          {savedDashboardCompanies.map((company) => (
                            <option key={company} value={company}>{company}</option>
                          ))}
                        </select>
                        <select
                          value={savedDashboardFilterJourney}
                          onChange={(e) => setSavedDashboardFilterJourney(e.target.value)}
                          style={{
                            width: '100%', padding: '10px 12px', borderRadius: 8,
                            border: `1px solid ${Colors.Border.Neutral.Default}`,
                            background: Colors.Background.Surface.Default,
                            color: 'inherit', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <option value="all">All journeys</option>
                          {savedDashboardJourneys.map((journey) => (
                            <option key={journey} value={journey}>{journey}</option>
                          ))}
                        </select>
                        <select
                          value={savedDashboardFilterSource}
                          onChange={(e) => setSavedDashboardFilterSource(e.target.value)}
                          style={{
                            width: '100%', padding: '10px 12px', borderRadius: 8,
                            border: `1px solid ${Colors.Border.Neutral.Default}`,
                            background: Colors.Background.Surface.Default,
                            color: 'inherit', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <option value="all">All sources</option>
                          {savedDashboardSources.map((source) => (
                            <option key={source} value={source}>{source}</option>
                          ))}
                        </select>
                      </div>
                      <div style={{ fontSize: 12, opacity: 0.6, marginBottom: 4 }}>
                        Showing {filteredSavedDashboards.length} of {savedDashboards.length} dashboard{savedDashboards.length !== 1 ? 's' : ''} saved on host
                      </div>
                      {filteredSavedDashboards.length === 0 ? (
                        <div style={{ padding: 18, textAlign: 'center', opacity: 0.6, fontSize: 12, borderRadius: 8, border: `1px dashed ${Colors.Border.Neutral.Default}` }}>
                          No saved dashboards match the current filters.
                        </div>
                      ) : filteredSavedDashboards.map((item: any) => (
                        <div
                          key={item.id}
                          style={{
                            padding: '12px 16px', borderRadius: 10,
                            border: `1px solid ${Colors.Border.Neutral.Default}`,
                            background: 'rgba(0,161,201,0.04)',
                            transition: 'border-color 0.2s',
                          }}
                        >
                          <Flex justifyContent="space-between" alignItems="center">
                            <div style={{ flex: 1 }}>
                              <Strong style={{ fontSize: 13 }}>{item.dashboardName || item.id}</Strong>
                              <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>
                                {item.tileCount} tiles · {item.generationMethod} · {item.savedAt ? new Date(item.savedAt).toLocaleString() : '—'}
                              </div>
                              <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                                {item.company || 'Unknown company'} · {item.journeyType || 'Unknown journey'} · {item.source === 'generated-artifact' ? `artifact v${item.artifactVersion || '?'}` : 'saved dashboard'}
                              </div>
                              {item.source === 'generated-artifact' && item.artifactPath && (
                                <div style={{ fontSize: 10, opacity: 0.6, marginTop: 2, fontFamily: 'monospace' }}>
                                  {item.artifactPath}
                                </div>
                              )}
                            </div>
                            <Flex gap={6}>
                              <button
                                onClick={() => compareSavedDashboardVersions(item)}
                                title="Compare with the latest version for this company and journey"
                                style={{
                                  padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(90,90,90,0.28)',
                                  background: 'rgba(90,90,90,0.08)', color: 'inherit',
                                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                                }}
                              >
                                ⇄ Compare
                              </button>
                              <button
                                onClick={() => loadSavedDashboardVersion(item)}
                                title="Load artifact version into dashboard view"
                                style={{
                                  padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(108,44,156,0.35)',
                                  background: selectedSavedDashboardId === item.id ? 'rgba(108,44,156,0.12)' : 'rgba(108,44,156,0.06)', color: '#6c2c9c',
                                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                                }}
                              >
                                📦 Load
                              </button>
                              <button
                                onClick={() => redeploySavedDashboardVersion(item)}
                                title="Redeploy this exact saved/generated version"
                                style={{
                                  padding: '6px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.35)',
                                  background: 'rgba(0,161,201,0.08)', color: '#00a1c9',
                                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                                }}
                              >
                                ♻️ Redeploy
                              </button>
                              <button
                                onClick={() => deploySavedDashboard(item)}
                                title="Deploy to Dynatrace"
                                style={{
                                  padding: '6px 12px', borderRadius: 6, border: '1px solid #00a1c9',
                                  background: 'rgba(0,161,201,0.1)', color: '#00a1c9',
                                  fontSize: 12, fontWeight: 600, cursor: 'pointer',
                                }}
                              >
                                🚀 Deploy
                              </button>
                              <button
                                onClick={() => deleteSavedDashboard(item.id)}
                                title="Delete from host"
                                style={{
                                  padding: '6px 8px', borderRadius: 6, border: '1px solid rgba(220,50,47,0.3)',
                                  background: 'rgba(220,50,47,0.08)', color: '#dc322f',
                                  fontSize: 12, cursor: 'pointer',
                                }}
                              >
                                🗑️
                              </button>
                            </Flex>
                          </Flex>
                        </div>
                      ))}
                      <div style={{ marginTop: 8, padding: 10, borderRadius: 8, background: 'rgba(115,190,40,0.08)', border: '1px solid rgba(115,190,40,0.3)', fontSize: 11, lineHeight: 1.5 }}>
                        💾 Dashboards are auto-saved to the host after every generation. Filter by company, journey, or source, compare against the latest version, then load or redeploy the exact artifact you want.
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* ===== Executive Summary Document Sub-Tab ===== */}
              {visualsSubTab === 'pdf' && (
                <>
                  {/* Doc Status Message */}
                  {pdfStatus && (
                    <div style={{ padding: 12, marginBottom: 16, borderRadius: 8, fontSize: 13, fontFamily: 'monospace',
                      background: pdfStatus.includes('✅') ? 'rgba(115,190,40,0.12)' : pdfStatus.includes('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(108,44,156,0.12)',
                      border: `1px solid ${pdfStatus.includes('✅') ? Colors.Theme.Success['70'] : pdfStatus.includes('❌') ? '#dc322f' : '#6c2c9c'}` }}>
                      {pdfStatus}
                    </div>
                  )}

                  <div style={{ marginBottom: 20, padding: 16, borderRadius: 10, background: 'rgba(108,44,156,0.06)', border: '1px solid rgba(108,44,156,0.2)' }}>
                    <Heading level={5} style={{ marginBottom: 8, color: '#6c2c9c' }}>📄 Executive Summary Document</Heading>
                    <Paragraph style={{ fontSize: 13, lineHeight: 1.6, marginBottom: 12 }}>
                      Generate a professional executive summary as a clean HTML document you can open in Word or Google Docs:
                    </Paragraph>
                    <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12, lineHeight: 2 }}>
                      <li><Strong>Executive Overview</Strong> — Company, industry challenges, journey scope</li>
                      <li><Strong>Step-by-Step Intelligence</Strong> — Business rationale, substeps, observability mapping</li>
                      <li><Strong>Why Dynatrace</Strong> — Platform capabilities aligned to this journey</li>
                      <li><Strong>Value Alignment</Strong> — Objectives and use cases for the account</li>
                      <li><Strong>Projected Outcomes &amp; Next Steps</Strong> — MTTR, visibility, implementation phases</li>
                    </ul>
                    <Paragraph style={{ fontSize: 11, color: '#888', marginTop: 8 }}>
                      💡 Tip: Open the downloaded .html file directly in Microsoft Word or Google Docs, then save as .docx
                    </Paragraph>
                  </div>

                  {/* Company Selector */}
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#6c2c9c' }}>🏢 Company</label>
                    {isLoadingDashboardData ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6 }}>⏳ Loading companies...</div>
                    ) : availableCompanies.length === 0 ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>No companies found. Deploy services first.</div>
                    ) : (
                      <select
                        value={dashboardCompanyName}
                        onChange={(e) => { setDashboardCompanyName(e.target.value); setDashboardJourneyType(''); }}
                        style={{
                          width: '100%', padding: '10px 14px', borderRadius: 8,
                          border: `1px solid ${Colors.Border.Neutral.Default}`,
                          background: Colors.Background.Surface.Default,
                          color: 'inherit', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        <option value="">-- Select a company --</option>
                        {availableCompanies.map(company => (
                          <option key={company} value={company}>{company}</option>
                        ))}
                      </select>
                    )}
                  </div>

                  {/* Journey Type Selector */}
                  <div style={{ marginBottom: 20 }}>
                    <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 8, color: '#6c2c9c' }}>🗺️ Journey Type</label>
                    {isLoadingDashboardData ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6 }}>⏳ Loading journeys...</div>
                    ) : !dashboardCompanyName ? (
                      <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>Select a company first.</div>
                    ) : (() => {
                      const filtered = Array.from(new Set(journeyInventory.filter(s => s.companyName === dashboardCompanyName).map(s => s.journeyType).filter(Boolean))).sort();
                      return filtered.length === 0 ? (
                        <div style={{ padding: 12, textAlign: 'center', opacity: 0.6, fontSize: 12 }}>No journey types found for {dashboardCompanyName}.</div>
                      ) : (
                        <select
                          value={dashboardJourneyType}
                          onChange={(e) => setDashboardJourneyType(e.target.value)}
                          style={{
                            width: '100%', padding: '10px 14px', borderRadius: 8,
                            border: `1px solid ${Colors.Border.Neutral.Default}`,
                            background: Colors.Background.Surface.Default,
                            color: 'inherit', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit',
                          }}
                        >
                          <option value="">-- Select a journey type --</option>
                          {filtered.map(journey => (
                            <option key={journey} value={journey}>{journey}</option>
                          ))}
                        </select>
                      );
                    })()}
                  </div>

                  {/* Generate Document Button */}
                  <Flex gap={8}>
                    <Button
                      onClick={async () => {
                        if (!dashboardCompanyName || !dashboardJourneyType) {
                          setPdfStatus('⚠️ Please select both company and journey type');
                          return;
                        }
                        setIsGeneratingPdf(true);
                        setPdfStatus('🚀 Generating executive summary document...');
                        try {
                          const result = await callProxyWithRetry({
                              action: 'generate-doc',
                              apiHost: apiSettings.host,
                              apiPort: apiSettings.port,
                              apiProtocol: apiSettings.protocol,
                              body: {
                                journeyData: {
                                  companyName: dashboardCompanyName,
                                  industryType: journeyInventory.find(s => s.companyName === dashboardCompanyName)?.industryType || 'Enterprise',
                                  journeyType: dashboardJourneyType,
                                  steps: journeyInventory
                                    .filter(s => s.companyName === dashboardCompanyName)
                                    .map(s => ({ stepName: s.stepName || s.service, name: s.service })),
                                },
                                dashboardData: generatedDashboardJson || {},
                              },
                          }, 5, 2000, setPdfStatus) as any;
                          if (result.success && result.data?.html) {
                            const blob = new Blob([result.data.html], { type: 'text/html; charset=utf-8' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = result.data.filename || `${dashboardCompanyName}-Executive-Summary.html`;
                            document.body.appendChild(a);
                            a.click();
                            document.body.removeChild(a);
                            URL.revokeObjectURL(url);
                            setPdfStatus(`✅ Downloaded ${result.data.filename} (${result.data.sizeKb}KB)`);
                            showToast(`📄 Executive Summary downloaded!`, 'success', 6000);
                          } else {
                            throw new Error(result.error || 'Document generation failed');
                          }
                        } catch (err: any) {
                          console.error('[Doc] ❌', err);
                          setPdfStatus(`❌ ${err.message}`);
                          showToast(`❌ Document generation failed: ${err.message}`, 'error', 5000);
                        } finally {
                          setIsGeneratingPdf(false);
                        }
                      }}
                      disabled={isGeneratingPdf || isLoadingDashboardData || !dashboardCompanyName || !dashboardJourneyType}
                      variant="emphasized"
                      style={{ flex: 1, fontWeight: 700 }}
                    >
                      {isGeneratingPdf ? '⏳ Generating Document...' : '📄 Download Executive Summary'}
                    </Button>
                    <Button onClick={() => setShowGenerateDashboardModal(false)} style={{ flex: 1 }}>Cancel</Button>
                  </Flex>
                </>
              )}

            </div>
          </div>
        </div>
      )}



      {/* ── Get Started Checklist Modal ─────────────────── */}
      {showGetStartedModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={() => setShowGetStartedModal(false)} />
          <div style={{ position: 'relative', width: 640, maxHeight: '85vh', overflow: 'auto', background: Colors.Background.Surface.Default, borderRadius: 16, border: '2px solid rgba(108,44,156,0.5)', boxShadow: '0 24px 48px rgba(0,0,0,0.3)' }}>
            {/* Header */}
            <div style={{ padding: '16px 24px', background: 'linear-gradient(135deg, #6c2c9c, #00a1c9)', borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <span style={{ fontSize: 24 }}>🚀</span>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Get Started</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12 }}>{completedCount}/{totalSteps} steps completed</div>
                  </div>
                </Flex>
                <Flex alignItems="center" gap={8}>
                  {/* Progress bar */}
                  <div style={{ width: 120, height: 8, borderRadius: 4, background: 'rgba(255,255,255,0.2)', overflow: 'hidden' }}>
                    <div style={{ width: `${(completedCount / totalSteps) * 100}%`, height: '100%', borderRadius: 4, background: completedCount === totalSteps ? '#73be28' : 'white', transition: 'width 0.3s ease' }} />
                  </div>
                  <button onClick={() => detectBuiltinSettings(true)} disabled={isDetecting} style={{ background: 'rgba(255,255,255,0.15)', border: '1px solid rgba(255,255,255,0.3)', color: 'white', fontSize: 11, fontWeight: 600, cursor: isDetecting ? 'wait' : 'pointer', padding: '3px 10px', borderRadius: 6, opacity: isDetecting ? 0.5 : 1, transition: 'all 0.2s' }}>{isDetecting ? '⏳ Checking...' : '🔄 Refresh'}</button>
                  <button onClick={() => setShowGetStartedModal(false)} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: 'pointer', padding: 4 }}>✕</button>
                </Flex>
              </Flex>
            </div>

            <div style={{ padding: 24 }}>
              {/* ── Section: Server Setup ── */}
              <div style={{ marginBottom: 20 }}>
                <Flex alignItems="center" gap={6} style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 14 }}>🖥️</span>
                  <Strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>Server Setup</Strong>
                </Flex>

                {/* Step: Configure Server IP */}
                <div onClick={() => toggleCheck('server-ip')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['server-ip'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['server-ip'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('server-ip') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('server-ip') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('server-ip') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('server-ip') ? 'line-through' : 'none', opacity: isStepComplete('server-ip') ? 0.6 : 1 }}>Configure Server IP & Port</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Set your BizObs Demonstrator server host and port in Settings → Config tab</div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); openSettingsModal(); setShowGetStartedModal(false); }} style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${Colors.Theme.Primary['70']}`, background: 'rgba(108,44,156,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: Colors.Theme.Primary['70'] }}>⚙️ Settings</button>
                  </Flex>
                </div>
              </div>

              {/* ── Section: Network / EdgeConnect ── */}
              <div style={{ marginBottom: 20 }}>
                <Flex alignItems="center" gap={6} style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 14 }}>🔌</span>
                  <Strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>Network — EdgeConnect</Strong>
                </Flex>

                {/* Step: Create EdgeConnect */}
                <div onClick={() => toggleCheck('edgeconnect-create')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['edgeconnect-create'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['edgeconnect-create'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('edgeconnect-create') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('edgeconnect-create') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('edgeconnect-create') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('edgeconnect-create') ? 'line-through' : 'none', opacity: isStepComplete('edgeconnect-create') ? 0.6 : 1 }}>Create EdgeConnect in Dynatrace</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Open Dynatrace Settings → External Requests → EdgeConnect → New EdgeConnect</div>
                    </div>
                    <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/external-requests/?tab=edge-connect`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>🔌 Open →</a>
                  </Flex>
                </div>

                {/* Step: Deploy EdgeConnect */}
                <div onClick={() => toggleCheck('edgeconnect-deploy')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['edgeconnect-deploy'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['edgeconnect-deploy'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('edgeconnect-deploy') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('edgeconnect-deploy') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('edgeconnect-deploy') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('edgeconnect-deploy') ? 'line-through' : 'none', opacity: isStepComplete('edgeconnect-deploy') ? 0.6 : 1 }}>Deploy EdgeConnect on Server</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Enter credentials in Settings → EdgeConnect tab, copy YAML, run <code style={{ fontSize: 10, background: 'rgba(0,0,0,0.06)', padding: '1px 4px', borderRadius: 3 }}>./run-edgeconnect.sh</code> on server</div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); setSettingsTab('edgeconnect'); openSettingsModal(); setShowGetStartedModal(false); }} style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${Colors.Theme.Primary['70']}`, background: 'rgba(108,44,156,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: Colors.Theme.Primary['70'] }}>⚙️ Setup</button>
                  </Flex>
                </div>

                {/* Step: Verify EdgeConnect Online */}
                <div onClick={() => toggleCheck('edgeconnect-online')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['edgeconnect-online'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['edgeconnect-online'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('edgeconnect-online') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('edgeconnect-online') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('edgeconnect-online') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('edgeconnect-online') ? 'line-through' : 'none', opacity: isStepComplete('edgeconnect-online') ? 0.6 : 1 }}>Verify EdgeConnect is Online</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Settings → EdgeConnect tab → Check Connection — status should show ONLINE</div>
                    </div>
                  </Flex>
                </div>
              </div>

              {/* ── Section: Monitoring ── */}
              <div style={{ marginBottom: 20 }}>
                <Flex alignItems="center" gap={6} style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 14 }}>📡</span>
                  <Strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>Monitoring</Strong>
                </Flex>

                {/* Step: OneAgent */}
                <div onClick={() => toggleCheck('oneagent')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['oneagent'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['oneagent'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('oneagent') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('oneagent') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('oneagent') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('oneagent') ? 'line-through' : 'none', opacity: isStepComplete('oneagent') ? 0.6 : 1 }}>OneAgent Installed on Host</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Ensure Dynatrace OneAgent is running on the BizObs server to monitor generated services</div>
                    </div>
                    <a href={`${TENANT_URL}/ui/apps/dynatrace.discovery.coverage/install/oneagent`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>📥 Deploy →</a>
                  </Flex>
                </div>
              </div>

              {/* ── Section: Verify ── */}
              <div style={{ marginBottom: 20 }}>
                <Flex alignItems="center" gap={6} style={{ marginBottom: 10 }}>
                  <span style={{ fontSize: 14 }}>✅</span>
                  <Strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>Verify</Strong>
                </Flex>

                {/* Step: Test Connection */}
                <div onClick={() => toggleCheck('test-connection')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${checklist['test-connection'] ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: checklist['test-connection'] ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('test-connection') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('test-connection') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('test-connection') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('test-connection') ? 'line-through' : 'none', opacity: isStepComplete('test-connection') ? 0.6 : 1 }}>Test Connection from App</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Settings → Config → click Test to verify the app can reach your server through EdgeConnect</div>
                    </div>
                    <button onClick={(e) => { e.stopPropagation(); setSettingsTab('config'); openSettingsModal(); setShowGetStartedModal(false); }} style={{ padding: '4px 10px', borderRadius: 6, border: `1px solid ${Colors.Theme.Primary['70']}`, background: 'rgba(108,44,156,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: Colors.Theme.Primary['70'] }}>🔌 Test</button>
                  </Flex>
                </div>
              </div>

              {/* ── Section: Dynatrace Configuration ── */}
              <div style={{ marginBottom: 8 }}>
                <Flex alignItems="center" justifyContent="space-between" style={{ marginBottom: 10 }}>
                  <Flex alignItems="center" gap={6}>
                    <span style={{ fontSize: 14 }}>⚙️</span>
                    <Strong style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 0.5, opacity: 0.6 }}>Dynatrace Configuration</Strong>
                  </Flex>
                  <Flex gap={6}>
                    <button onClick={() => detectBuiltinSettings(true)} disabled={isDetecting} style={{ padding: '3px 8px', borderRadius: 5, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', cursor: 'pointer', fontSize: 10, fontWeight: 600, opacity: isDetecting ? 0.4 : 0.7 }}>{isDetecting ? '⏳' : '🔄'} Refresh</button>
                    {(!isStepComplete('biz-events') || !isStepComplete('openpipeline') || !isStepComplete('openpipeline-routing') || !isStepComplete('feature-flags') || !isStepComplete('outbound-github-models')) && (
                      <button
                        onClick={() => {
                          const toDeploy: string[] = [];
                          if (!isStepComplete('biz-events')) toDeploy.push('biz-events');
                          if (!isStepComplete('feature-flags')) toDeploy.push('feature-flags');
                          if (!isStepComplete('openpipeline')) toDeploy.push('openpipeline');
                          if (!isStepComplete('openpipeline-routing')) toDeploy.push('openpipeline-routing');
                          if (!isStepComplete('outbound-github-models')) toDeploy.push('outbound-github-models');
                          deployBuiltinConfigs(toDeploy);
                        }}
                        disabled={isDeployingConfigs}
                        style={{ padding: '3px 10px', borderRadius: 5, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: isDeployingConfigs ? 'wait' : 'pointer', fontSize: 10, fontWeight: 700, color: '#00a1c9' }}
                      >
                        {isDeployingConfigs ? '⏳ Deploying...' : '🚀 Deploy All'}
                      </button>
                    )}
                  </Flex>
                </Flex>

                {deployConfigsStatus && (
                  <div style={{ padding: 8, borderRadius: 6, fontSize: 11, marginBottom: 8, background: deployConfigsStatus.startsWith('✅') ? 'rgba(0,180,0,0.06)' : deployConfigsStatus.startsWith('❌') ? 'rgba(220,50,47,0.06)' : 'rgba(0,161,201,0.06)', border: `1px solid ${deployConfigsStatus.startsWith('✅') ? 'rgba(0,180,0,0.2)' : deployConfigsStatus.startsWith('❌') ? 'rgba(220,50,47,0.2)' : 'rgba(0,161,201,0.2)'}` }}>
                    {deployConfigsStatus}
                  </div>
                )}

                {/* Step: BizEvents Capture Rule */}
                <div onClick={() => toggleCheck('biz-events')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('biz-events') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('biz-events') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('biz-events') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('biz-events') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('biz-events') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('biz-events') ? 'line-through' : 'none', opacity: isStepComplete('biz-events') ? 0.6 : 1 }}>Business Event Capture Rule</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Capture rule "BizObs App2" for HTTP incoming business events (test mode)</div>
                      {isStepComplete('biz-events') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected — <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/bizevents/incoming`} target="_blank" rel="noopener noreferrer" style={{ color: '#4169e1', fontSize: 10 }}>View in Settings →</a></div>}
                    </div>
                    {!isStepComplete('biz-events') ? (
                      <button onClick={(e) => { e.stopPropagation(); deployBuiltinConfigs(['biz-events']); }} disabled={isDeployingConfigs} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>🚀 Deploy</button>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/bizevents/incoming`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>

                {/* Step: OneAgent Feature Flag */}
                <div onClick={() => toggleCheck('feature-flags')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('feature-flags') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('feature-flags') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('feature-flags') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('feature-flags') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('feature-flags') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('feature-flags') ? 'line-through' : 'none', opacity: isStepComplete('feature-flags') ? 0.6 : 1 }}>OneAgent Feature Flag Enabled</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>SENSOR_NODEJS_BIZEVENTS_HTTP_INCOMING — enables Node.js business event capture</div>
                      {isStepComplete('feature-flags') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected — <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/oneagent-features`} target="_blank" rel="noopener noreferrer" style={{ color: '#4169e1', fontSize: 10 }}>View in Settings →</a></div>}
                    </div>
                    {!isStepComplete('feature-flags') ? (
                      <button onClick={(e) => { e.stopPropagation(); deployBuiltinConfigs(['feature-flags']); }} disabled={isDeployingConfigs} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>🚀 Deploy</button>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/oneagent-features`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>

                {/* Step: OpenPipeline Pipeline */}
                <div onClick={() => toggleCheck('openpipeline')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('openpipeline') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('openpipeline') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('openpipeline') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('openpipeline') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('openpipeline') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('openpipeline') ? 'line-through' : 'none', opacity: isStepComplete('openpipeline') ? 0.6 : 1 }}>OpenPipeline Pipeline Created</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Pipeline "BizObs Template Pipeline2" for bizevents ingestion (test mode)</div>
                      {isStepComplete('openpipeline') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected — <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/openpipeline-bizevents/pipelines?page=1&pageSize=50`} target="_blank" rel="noopener noreferrer" style={{ color: '#4169e1', fontSize: 10 }}>View in Settings →</a></div>}
                    </div>
                    {!isStepComplete('openpipeline') ? (
                      <button onClick={(e) => { e.stopPropagation(); deployBuiltinConfigs(['openpipeline']); }} disabled={isDeployingConfigs} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>🚀 Deploy</button>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/openpipeline-bizevents/pipelines?page=1&pageSize=50`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>

                {/* Step: OpenPipeline Routing */}
                <div onClick={() => toggleCheck('openpipeline-routing')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('openpipeline-routing') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('openpipeline-routing') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('openpipeline-routing') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('openpipeline-routing') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('openpipeline-routing') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('openpipeline-routing') ? 'line-through' : 'none', opacity: isStepComplete('openpipeline-routing') ? 0.6 : 1 }}>OpenPipeline Routing Configured</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Routing rule description "BizObs App2" to direct events to the pipeline (test mode)</div>
                      {isStepComplete('openpipeline-routing') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected — <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/openpipeline-bizevents/routing?page=1&pageSize=50`} target="_blank" rel="noopener noreferrer" style={{ color: '#4169e1', fontSize: 10 }}>View in Settings →</a></div>}
                    </div>
                    {!isStepComplete('openpipeline-routing') ? (
                      <button onClick={(e) => { e.stopPropagation(); deployBuiltinConfigs(['openpipeline-routing']); }} disabled={isDeployingConfigs} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>🚀 Deploy</button>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/openpipeline-bizevents/routing?page=1&pageSize=50`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>

                {/* Step: AI Provider Outbound Allowlist */}
                <div onClick={() => toggleCheck('outbound-github-models')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('outbound-github-models') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('outbound-github-models') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('outbound-github-models') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('outbound-github-models') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('outbound-github-models') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('outbound-github-models') ? 'line-through' : 'none', opacity: isStepComplete('outbound-github-models') ? 0.6 : 1 }}>AI Provider Outbound Allowed</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Allow models.inference.ai.azure.com in AppEngine outbound connections for AI generation</div>
                      {isStepComplete('outbound-github-models') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected</div>}
                    </div>
                    {!isStepComplete('outbound-github-models') ? (
                      <button onClick={(e) => { e.stopPropagation(); deployBuiltinConfigs(['outbound-github-models']); }} disabled={isDeployingConfigs} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>🚀 Deploy</button>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.settings/settings/dt-javascript-runtime.allowed-outbound-connections`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>

                {/* Step: Automation Workflow */}
                <div onClick={() => toggleCheck('automation-workflow')} style={{ padding: '12px 14px', borderRadius: 10, border: `1px solid ${isStepComplete('automation-workflow') ? 'rgba(0,180,0,0.3)' : Colors.Border.Neutral.Default}`, background: isStepComplete('automation-workflow') ? 'rgba(0,180,0,0.04)' : 'transparent', cursor: 'pointer', marginBottom: 8, transition: 'all 0.2s' }}>
                  <Flex alignItems="center" gap={12}>
                    <div style={{ width: 24, height: 24, borderRadius: 6, border: `2px solid ${isStepComplete('automation-workflow') ? '#2e7d32' : Colors.Border.Neutral.Default}`, background: isStepComplete('automation-workflow') ? '#2e7d32' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all 0.2s' }}>
                      {isStepComplete('automation-workflow') && <span style={{ color: 'white', fontSize: 14, fontWeight: 700 }}>✓</span>}
                    </div>
                    <div style={{ flex: 1 }}>
                      <Strong style={{ fontSize: 13, textDecoration: isStepComplete('automation-workflow') ? 'line-through' : 'none', opacity: isStepComplete('automation-workflow') ? 0.6 : 1 }}>Fix-It Agent Workflow Deployed</Strong>
                      <div style={{ fontSize: 11, opacity: 0.6, marginTop: 2 }}>Dynatrace Intelligence problem → analysis → autonomous remediation via HTTP</div>
                      {isStepComplete('automation-workflow') && <div style={{ fontSize: 10, marginTop: 3, color: '#2e7d32' }}>✅ Detected — <a href={`${TENANT_URL}/ui/apps/dynatrace.automations`} target="_blank" rel="noopener noreferrer" style={{ color: '#4169e1', fontSize: 10 }}>View in Workflows →</a></div>}
                      {!isStepComplete('automation-workflow') && <div style={{ fontSize: 10, marginTop: 3, opacity: 0.5 }}>Download the workflow JSON → upload in Dynatrace Workflows</div>}
                    </div>
                    {!isStepComplete('automation-workflow') ? (
                      <Flex gap={4}>
                        <button onClick={async (e) => {
                          e.stopPropagation();
                          try {
                            const result = await callProxyWithRetry(
                              { action: 'deploy-workflow', apiHost: apiSettings.host, apiPort: apiSettings.port, apiProtocol: apiSettings.protocol || 'http' }
                            ) as any;
                            if (result.success && result.data?.workflowTemplate) {
                              const json = JSON.stringify(result.data.workflowTemplate, null, 2);
                              const blob = new Blob([json], { type: 'application/json' });
                              const url = URL.createObjectURL(blob);
                              const a = document.createElement('a');
                              a.href = url;
                              a.download = 'bizobs-fix-it-agent-workflow.json';
                              document.body.appendChild(a);
                              a.click();
                              document.body.removeChild(a);
                              URL.revokeObjectURL(url);
                              showToast('Workflow JSON downloaded — upload it in Dynatrace Workflows', 'success', 5000);
                            } else {
                              showToast('Failed to generate workflow template', 'error');
                            }
                          } catch (err: any) { showToast(err.message, 'error'); }
                        }} style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(0,161,201,0.4)', background: 'rgba(0,161,201,0.08)', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: '#00a1c9' }}>⬇️ Download</button>
                        <a href={`${TENANT_URL}/ui/apps/dynatrace.automations`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                      </Flex>
                    ) : (
                      <a href={`${TENANT_URL}/ui/apps/dynatrace.automations`} target="_blank" rel="noopener noreferrer" style={{ padding: '4px 10px', borderRadius: 6, border: '1px solid rgba(65,105,225,0.3)', background: 'rgba(65,105,225,0.06)', fontSize: 11, fontWeight: 600, color: '#4169e1', textDecoration: 'none' }}>Open →</a>
                    )}
                  </Flex>
                </div>
              </div>

              {/* Reset */}
              <Flex justifyContent="flex-end" style={{ marginTop: 8 }}>
                <button onClick={() => { setChecklist({}); localStorage.removeItem('bizobs_checklist'); localStorage.removeItem('bizobs_connection_tested'); setConnectionTestedOk(false); }} style={{ padding: '4px 12px', borderRadius: 6, border: `1px solid ${Colors.Border.Neutral.Default}`, background: 'transparent', cursor: 'pointer', fontSize: 11, fontWeight: 600, opacity: 0.5 }}>🔄 Reset checklist</button>
              </Flex>
            </div>
          </div>
        </div>
      )}

      {/* ── Confirm Dialog (replaces native confirm()) ──── */}
      {confirmDialog && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10002, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.45)' }} onClick={() => setConfirmDialog(null)} />
          <div style={{ position: 'relative', width: 380, background: Colors.Background.Surface.Default, borderRadius: 14, border: `2px solid ${Colors.Theme.Primary['70']}`, boxShadow: '0 16px 40px rgba(0,0,0,0.3)' }}>
            <div style={{ padding: '16px 20px', background: 'linear-gradient(135deg, rgba(108,44,156,0.12), rgba(0,161,201,0.08))', borderRadius: '12px 12px 0 0', borderBottom: `1px solid ${Colors.Border.Neutral.Default}` }}>
              <Flex alignItems="center" gap={8}>
                <span style={{ fontSize: 20 }}>⚠️</span>
                <Strong style={{ fontSize: 15 }}>Confirm</Strong>
              </Flex>
            </div>
            <div style={{ padding: 20 }}>
              <Paragraph style={{ fontSize: 13, marginBottom: 20, lineHeight: 1.6 }}>{confirmDialog.message}</Paragraph>
              <Flex gap={8}>
                <Button onClick={() => setConfirmDialog(null)} style={{ flex: 1 }}>Cancel</Button>
                <Button onClick={() => { confirmDialog.onConfirm(); setConfirmDialog(null); }} style={{ flex: 1, background: 'rgba(220,50,47,0.15)', color: '#dc322f', fontWeight: 600 }}>Confirm</Button>
              </Flex>
            </div>
          </div>
        </div>
      )}

      {showBugReportModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10002, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.55)' }} onClick={closeBugReportModal} />
          <div style={{ position: 'relative', width: 'min(760px, 94vw)', maxHeight: '88vh', overflow: 'hidden', background: Colors.Background.Surface.Default, borderRadius: 18, border: `2px solid rgba(220,50,47,0.35)`, boxShadow: '0 24px 48px rgba(0,0,0,0.35)', display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '18px 24px', background: 'linear-gradient(135deg, rgba(220,50,47,0.92), rgba(180,30,30,0.96))', borderRadius: '14px 14px 0 0' }}>
              <Flex alignItems="center" justifyContent="space-between">
                <Flex alignItems="center" gap={12}>
                  <span style={{ fontSize: 24 }}>🐞</span>
                  <div>
                    <Strong style={{ color: 'white', fontSize: 16 }}>Report a Bug</Strong>
                    <div style={{ color: 'rgba(255,255,255,0.76)', fontSize: 12 }}>Creates a GitHub issue directly in the internal repository</div>
                  </div>
                </Flex>
                <button onClick={closeBugReportModal} disabled={isSubmittingBugReport} style={{ background: 'none', border: 'none', color: 'white', fontSize: 20, cursor: isSubmittingBugReport ? 'wait' : 'pointer', padding: 4, opacity: isSubmittingBugReport ? 0.6 : 1 }}>✕</button>
              </Flex>
            </div>

            <div style={{ padding: 24, overflowY: 'auto', overflowX: 'hidden' }}>
              <div style={{ padding: '14px 16px', marginBottom: 18, borderRadius: 12, background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(255,255,255,0.01))', border: `1px solid ${Colors.Border.Neutral.Default}` }}>
                <Paragraph style={{ fontSize: 13, marginBottom: 8, lineHeight: 1.6, opacity: 0.82 }}>
                  Submit the problem directly to LawrenceBarratt90/Business-Observability-Demonstrator-Internal using the GitHub token already configured for the app.
                </Paragraph>
                <div style={{ fontSize: 11, opacity: 0.6, letterSpacing: 0.2 }}>
                  Include a short title, what broke, and how to reproduce it.
                </div>
              </div>

              {bugReportStatus && (
                <div style={{ padding: '10px 12px', marginBottom: 16, borderRadius: 10, fontSize: 13, lineHeight: 1.5,
                  background: bugReportStatus.startsWith('✅') ? 'rgba(115,190,40,0.12)' : bugReportStatus.startsWith('❌') ? 'rgba(220,50,47,0.12)' : 'rgba(0,161,201,0.12)',
                  border: `1px solid ${bugReportStatus.startsWith('✅') ? Colors.Theme.Success['70'] : bugReportStatus.startsWith('❌') ? '#dc322f' : Colors.Theme.Primary['70']}` }}>
                  <div>{bugReportStatus}</div>
                  {bugReportIssueUrl && (
                    <a href={bugReportIssueUrl} target="_blank" rel="noopener noreferrer" style={{ display: 'inline-block', marginTop: 8, color: Colors.Theme.Primary['70'], fontWeight: 600, textDecoration: 'none' }}>
                      Open created issue →
                    </a>
                  )}
                </div>
              )}

              <div style={{ display: 'grid', gap: 16 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6, opacity: 0.8 }}>Title</label>
                  <input
                    value={bugReportForm.title}
                    onChange={(e) => setBugReportForm(prev => ({ ...prev, title: e.target.value }))}
                    placeholder="Short summary of the problem"
                    disabled={isSubmittingBugReport}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '11px 12px', borderRadius: 10, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Base.Default, color: Colors.Text.Neutral.Default, fontSize: 13 }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6, opacity: 0.8 }}>Summary</label>
                  <textarea
                    value={bugReportForm.summary}
                    onChange={(e) => setBugReportForm(prev => ({ ...prev, summary: e.target.value }))}
                    placeholder="What went wrong and where did you see it?"
                    disabled={isSubmittingBugReport}
                    style={{ width: '100%', boxSizing: 'border-box', minHeight: 104, padding: 12, borderRadius: 10, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Base.Default, color: Colors.Text.Neutral.Default, fontSize: 13, lineHeight: 1.5, resize: 'vertical' }}
                  />
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6, opacity: 0.8 }}>Steps to Reproduce</label>
                  <textarea
                    value={bugReportForm.stepsToReproduce}
                    onChange={(e) => setBugReportForm(prev => ({ ...prev, stepsToReproduce: e.target.value }))}
                    placeholder={'1. Go to...\n2. Click...\n3. Observe...'}
                    disabled={isSubmittingBugReport}
                    style={{ width: '100%', boxSizing: 'border-box', minHeight: 132, padding: 12, borderRadius: 10, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Base.Default, color: Colors.Text.Neutral.Default, fontSize: 13, lineHeight: 1.5, resize: 'vertical' }}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 16 }}>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6, opacity: 0.8 }}>Expected Behavior</label>
                    <textarea
                      value={bugReportForm.expectedBehavior}
                      onChange={(e) => setBugReportForm(prev => ({ ...prev, expectedBehavior: e.target.value }))}
                      placeholder="What should have happened?"
                      disabled={isSubmittingBugReport}
                      style={{ width: '100%', boxSizing: 'border-box', minHeight: 110, padding: 12, borderRadius: 10, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Base.Default, color: Colors.Text.Neutral.Default, fontSize: 13, lineHeight: 1.5, resize: 'vertical' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: 12, fontWeight: 700, marginBottom: 6, opacity: 0.8 }}>Actual Behavior</label>
                    <textarea
                      value={bugReportForm.actualBehavior}
                      onChange={(e) => setBugReportForm(prev => ({ ...prev, actualBehavior: e.target.value }))}
                      placeholder="What happened instead?"
                      disabled={isSubmittingBugReport}
                      style={{ width: '100%', boxSizing: 'border-box', minHeight: 110, padding: 12, borderRadius: 10, border: `1px solid ${Colors.Border.Neutral.Default}`, background: Colors.Background.Base.Default, color: Colors.Text.Neutral.Default, fontSize: 13, lineHeight: 1.5, resize: 'vertical' }}
                    />
                  </div>
                </div>
              </div>

              <Flex gap={8} justifyContent="flex-end" style={{ marginTop: 24, paddingTop: 18, borderTop: `1px solid ${Colors.Border.Neutral.Default}` }}>
                <Button onClick={closeBugReportModal} disabled={isSubmittingBugReport} style={{ minWidth: 120 }}>
                  Cancel
                </Button>
                <Button onClick={submitBugReport} disabled={isSubmittingBugReport} style={{ minWidth: 220, background: 'rgba(220,50,47,0.15)', color: '#dc322f', fontWeight: 700 }}>
                  {isSubmittingBugReport ? 'Submitting...' : 'Submit Issue to GitHub'}
                </Button>
              </Flex>
            </div>
          </div>
        </div>
      )}

      {/* ── Toast Notification ──── */}
      {toastVisible && (
        <div
          style={{
            position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
            zIndex: 10003, minWidth: 320, maxWidth: 600,
            padding: '12px 20px', borderRadius: 10,
            display: 'flex', alignItems: 'center', gap: 10,
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            background: toastType === 'success' ? 'linear-gradient(135deg, rgba(115,190,40,0.95), rgba(80,160,20,0.95))'
              : toastType === 'error' ? 'linear-gradient(135deg, rgba(220,50,47,0.95), rgba(180,30,30,0.95))'
              : toastType === 'warning' ? 'linear-gradient(135deg, rgba(181,137,0,0.95), rgba(200,160,10,0.95))'
              : 'linear-gradient(135deg, rgba(0,161,201,0.95), rgba(0,130,170,0.95))',
            color: 'white', fontSize: 13, fontWeight: 500,
            animation: 'fadeInUp 0.3s ease',
          }}
        >
          <span style={{ fontSize: 16 }}>
            {toastType === 'success' ? '✅' : toastType === 'error' ? '❌' : toastType === 'warning' ? '⚠️' : 'ℹ️'}
          </span>
          <span style={{ flex: 1 }}>{toastMessage}</span>
          <button
            onClick={() => setToastVisible(false)}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)', fontSize: 16, cursor: 'pointer', padding: '0 4px' }}
          >
            ✕
          </button>
        </div>
      )}
      {/* ── AI Generation Pipeline Modal ───────────────── */}
      {showAiGenModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10003, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.65)' }} />
          <div style={{
            position: 'relative', width: 'min(640px, 92vw)', background: Colors.Background.Surface.Default,
            borderRadius: 20, border: `2px solid ${aiGenComplete ? 'rgba(115,190,40,0.6)' : aiGenError ? 'rgba(220,50,47,0.6)' : 'rgba(0,161,201,0.4)'}`,
            boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden',
          }}>
            {/* Header */}
            <div style={{
              padding: '22px 28px',
              background: aiGenComplete
                ? 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,180,0,0.8))'
                : aiGenError
                  ? 'linear-gradient(135deg, rgba(220,50,47,0.9), rgba(180,30,30,0.8))'
                  : 'linear-gradient(135deg, rgba(0,161,201,0.9), rgba(108,44,156,0.9))',
            }}>
              <Flex alignItems="center" gap={12}>
                <div style={{ fontSize: 32 }}>{aiGenComplete ? '🎉' : aiGenError ? '⚠️' : '✨'}</div>
                <div>
                  <Strong style={{ color: 'white', fontSize: 18 }}>
                    {aiGenComplete ? 'Generation Complete!' : aiGenError ? 'Generation Failed' : 'AI Generation Pipeline'}
                  </Strong>
                  <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 2 }}>
                    {aiGenComplete ? 'Services are live and template saved' : aiGenError ? 'Check the error below and retry' : `Model: ${ghCopilotModel} • ${companyName}`}
                  </div>
                </div>
              </Flex>
            </div>

            {/* Steps */}
            <div style={{ padding: '24px 28px 22px', maxHeight: '56vh', overflowY: 'auto' }}>
              {aiGenSteps.map((step, idx) => (
                <div key={idx} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 14, marginBottom: idx < aiGenSteps.length - 1 ? 20 : 0,
                  opacity: step.status === 'pending' ? 0.4 : 1,
                  transition: 'opacity 0.3s ease',
                }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: '50%', flexShrink: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 16, fontWeight: 700,
                    background: step.status === 'done' ? 'rgba(115,190,40,0.15)' : step.status === 'error' ? 'rgba(220,50,47,0.15)' : step.status === 'running' ? 'rgba(0,161,201,0.15)' : 'rgba(120,120,120,0.1)',
                    border: `2px solid ${step.status === 'done' ? 'rgba(115,190,40,0.5)' : step.status === 'error' ? 'rgba(220,50,47,0.5)' : step.status === 'running' ? 'rgba(0,161,201,0.5)' : 'rgba(120,120,120,0.2)'}`,
                    color: step.status === 'done' ? '#73be28' : step.status === 'error' ? '#dc322f' : step.status === 'running' ? '#00a1c9' : Colors.Text.Neutral.Subdued,
                  }}>
                    {step.status === 'done' ? '✓' : step.status === 'error' ? '✕' : step.status === 'running' ? '⏳' : idx + 1}
                  </div>
                  <div style={{ flex: 1, paddingTop: 4 }}>
                    <div style={{
                      fontSize: 15, fontWeight: step.status === 'running' ? 700 : 600,
                      color: step.status === 'running' ? Colors.Text.Neutral.Default : step.status === 'done' ? Colors.Text.Neutral.Default : Colors.Text.Neutral.Subdued,
                    }}>
                      {step.label}
                      {step.status === 'running' && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.7 }}>...</span>}
                    </div>
                    {step.detail && (
                      <div style={{
                        fontSize: 12, marginTop: 5, lineHeight: 1.45,
                        color: step.status === 'error' ? '#dc322f' : 'rgba(115,190,40,0.9)',
                        fontFamily: step.status === 'error' ? 'monospace' : 'inherit',
                        wordBreak: 'break-word',
                      }}>
                        {step.detail}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {/* Progress bar */}
              {!aiGenComplete && !aiGenError && (
                <div style={{ marginTop: 20, height: 4, borderRadius: 2, background: 'rgba(120,120,120,0.15)', overflow: 'hidden' }}>
                  <div style={{
                    height: '100%', borderRadius: 2,
                    background: 'linear-gradient(90deg, #00a1c9, #73be28)',
                    width: `${(aiGenSteps.filter(s => s.status === 'done').length / aiGenSteps.length) * 100}%`,
                    transition: 'width 0.5s ease',
                  }} />
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '18px 24px', borderTop: `1px solid ${Colors.Border.Neutral.Default}`, display: 'flex', flexWrap: 'wrap', gap: 10, justifyContent: aiGenComplete || aiGenError ? 'flex-start' : 'flex-end', alignItems: 'center' }}>
              {aiGenComplete && (
                <Flex gap={12} alignItems="center" style={{ flexWrap: 'wrap' }}>
                  <Button
                    variant="emphasized"
                    onClick={() => { setShowAiGenModal(false); setActiveTab('step2'); setStep2Phase('generate'); }}
                    style={{ padding: '9px 20px' }}
                  >
                    View Results
                  </Button>
                  <a
                    href={AI_PROMPTS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      padding: '9px 16px', borderRadius: 8, fontSize: 12, fontWeight: 600,
                      background: 'linear-gradient(135deg, rgba(0,161,201,0.1), rgba(108,44,156,0.1))',
                      border: '1px solid rgba(0,161,201,0.3)',
                      color: Colors.Text.Neutral.Default,
                      textDecoration: 'none',
                      transition: 'all 0.2s ease',
                    }}
                  >
                    🔍 View AI Prompts in Dynatrace
                  </a>
                  <Button
                    onClick={() => {
                      setShowAiGenModal(false);
                      if (aiGenDashboardCompany) setDashboardCompanyName(aiGenDashboardCompany);
                      if (aiGenDashboardJourney) setDashboardJourneyType(aiGenDashboardJourney);
                      openGenerateDashboardModal();
                    }}
                    variant="emphasized"
                    style={{ padding: '9px 20px', background: 'linear-gradient(135deg, #00a1c9, #6c2c9c)', color: 'white', border: 'none' }}
                  >
                    📄 Executive Summary
                  </Button>
                </Flex>
              )}
              {aiGenError && (
                <Button
                  variant="accent"
                  onClick={() => runAiGenerationPipeline()}
                  style={{ padding: '8px 20px' }}
                >
                  🔄 Retry
                </Button>
              )}
              {(aiGenComplete || aiGenError) && (
                <Button onClick={() => setShowAiGenModal(false)} style={{ padding: '9px 16px', marginLeft: 'auto' }}>
                  Close
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── Journey Picker Modal (AI pipeline — no requirements) ─────── */}
      {showJourneyPickerModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10004, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.65)' }} />
          <div style={{
            position: 'relative', width: 560, maxHeight: '80vh', background: Colors.Background.Surface.Default,
            borderRadius: 20, border: '2px solid rgba(115,190,40,0.5)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden', display: 'flex', flexDirection: 'column',
          }}>
            {/* Header */}
            <div style={{
              padding: '20px 24px',
              background: 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,161,201,0.9))',
            }}>
              <Strong style={{ color: 'white', fontSize: 18 }}>Select a Journey</Strong>
              <Paragraph style={{ color: 'rgba(255,255,255,0.85)', fontSize: 12, marginBottom: 0, marginTop: 4 }}>
                {requirements.trim()
                  ? `Based on "${requirements.trim()}" — AI found these related journeys`
                  : 'AI analysed the company and found these journeys — pick one to generate'}
              </Paragraph>
            </div>
            {/* Journey List */}
            <div style={{ padding: 20, overflow: 'auto', flex: 1 }}>
              <Flex flexDirection="column" gap={8}>
                {extractedJourneys.map((j, i) => (
                  <div
                    key={i}
                    onClick={() => setSelectedJourneyName(j)}
                    style={{
                      padding: '14px 16px', borderRadius: 10, cursor: 'pointer',
                      background: selectedJourneyName === j
                        ? 'linear-gradient(135deg, rgba(115,190,40,0.15), rgba(0,161,201,0.1))'
                        : Colors.Background.Base.Default,
                      border: selectedJourneyName === j
                        ? '2px solid rgba(115,190,40,0.7)'
                        : `1px solid ${Colors.Border.Neutral.Default}`,
                      transition: 'all 0.15s ease',
                    }}
                  >
                    <Flex alignItems="center" gap={12}>
                      <div style={{
                        width: 28, height: 28, borderRadius: '50%', flexShrink: 0,
                        background: selectedJourneyName === j
                          ? 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,161,201,0.9))'
                          : Colors.Background.Surface.Default,
                        border: selectedJourneyName === j ? 'none' : `2px solid ${Colors.Border.Neutral.Default}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 14, color: 'white',
                      }}>
                        {selectedJourneyName === j ? '✓' : ''}
                      </div>
                      <Strong style={{ fontSize: 14 }}>{j}</Strong>
                    </Flex>
                  </div>
                ))}
              </Flex>
              {extractedJourneys.length === 0 && (
                <Paragraph style={{ textAlign: 'center', opacity: 0.5, marginTop: 20 }}>No journeys found in the analysis.</Paragraph>
              )}
            </div>
            {/* Footer */}
            <div style={{ padding: '16px 20px', borderTop: `1px solid ${Colors.Border.Neutral.Default}`, display: 'flex', justifyContent: 'flex-end', gap: 12 }}>
              <Button
                variant="accent"
                disabled={!selectedJourneyName}
                onClick={() => {
                  if (journeyPickerResolve && selectedJourneyName) {
                    journeyPickerResolve(selectedJourneyName);
                  }
                }}
                style={{
                  padding: '10px 28px', fontWeight: 700, fontSize: 14,
                  background: selectedJourneyName ? 'linear-gradient(135deg, rgba(115,190,40,0.9), rgba(0,161,201,0.9))' : undefined,
                  color: selectedJourneyName ? 'white' : undefined,
                  border: selectedJourneyName ? 'none' : undefined,
                  borderRadius: 10,
                }}
              >
                Generate "{selectedJourneyName}" →
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Paste Your Own AI Prompt Modal ───────────────── */}
      {showPasteAiModal && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 10003, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,0.65)' }} onClick={() => setShowPasteAiModal(false)} />
          <div style={{
            position: 'relative', width: 620, maxHeight: '85vh', background: Colors.Background.Surface.Default,
            borderRadius: 20, border: '2px solid rgba(108,44,156,0.4)',
            boxShadow: '0 24px 64px rgba(0,0,0,0.4)', overflow: 'hidden', display: 'flex', flexDirection: 'column',
          }}>
            {/* Header */}
            <div style={{
              padding: '20px 24px',
              background: 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))',
            }}>
              <Flex alignItems="center" gap={12}>
                <div style={{ fontSize: 32 }}>📋</div>
                <div>
                  <Strong style={{ color: 'white', fontSize: 18 }}>Use Your Own AI Prompt</Strong>
                  <div style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 2 }}>
                    Paste a C-Suite analysis from ChatGPT, Gemini, Claude, or any AI — we'll extract the journeys
                  </div>
                </div>
              </Flex>
            </div>

            {/* Body */}
            <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
              <Paragraph style={{ fontSize: 13, marginBottom: 12, lineHeight: 1.5 }}>
                Paste the AI-generated C-Suite / business analysis below. The app will look for journey names in the
                <Strong> "Journey Classification"</Strong> or <Strong>"Critical User Journeys"</Strong> section and let you pick one.
              </Paragraph>
              <textarea
                value={pastedAiResponse}
                onChange={(e) => {
                  const text = e.target.value;
                  setPastedAiResponse(text);
                  const journeys = extractJourneysFromText(text);
                  setExtractedJourneys(journeys);
                  setSelectedJourneyName(journeys[0] || '');
                }}
                placeholder={'Paste your AI response here...\n\nExample:\n### 3. Journey Classification\n- **Journey Names**:\n    - "Vehicle Purchase Journey"\n    - "Finance Application Journey"'}
                style={{
                  width: '100%', minHeight: 200, maxHeight: 300, padding: 14,
                  background: Colors.Background.Base.Default,
                  border: `1px solid ${Colors.Border.Neutral.Default}`,
                  borderRadius: 8, color: Colors.Text.Neutral.Default,
                  fontFamily: 'monospace', fontSize: 12, lineHeight: 1.5, resize: 'vertical',
                }}
              />

              {/* Extracted journeys */}
              {pastedAiResponse.length > 50 && (
                <div style={{ marginTop: 16 }}>
                  {extractedJourneys.length > 0 ? (
                    <>
                      <Flex alignItems="center" gap={8} style={{ marginBottom: 8 }}>
                        <div style={{ fontSize: 18 }}>🎯</div>
                        <Strong style={{ fontSize: 14 }}>
                          {extractedJourneys.length} Journey{extractedJourneys.length > 1 ? 's' : ''} Found
                        </Strong>
                      </Flex>
                      <Paragraph style={{ fontSize: 12, marginBottom: 10, opacity: 0.7 }}>
                        Select which journey to generate the observability configuration for:
                      </Paragraph>
                      <select
                        value={selectedJourneyName}
                        onChange={(e: any) => setSelectedJourneyName(e.target.value)}
                        style={{
                          width: '100%', padding: '10px 14px', borderRadius: 8,
                          background: Colors.Background.Base.Default,
                          border: '2px solid rgba(115,190,40,0.5)',
                          color: Colors.Text.Neutral.Default, fontSize: 14,
                          cursor: 'pointer', fontWeight: 600,
                        }}
                      >
                        {extractedJourneys.map((j, idx) => (
                          <option key={idx} value={j}>{j}</option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <div style={{
                      padding: 14, borderRadius: 8,
                      background: 'rgba(220,180,0,0.1)', border: '1px solid rgba(220,180,0,0.3)',
                    }}>
                      <Flex alignItems="center" gap={8}>
                        <div style={{ fontSize: 16 }}>⚠️</div>
                        <div>
                          <Strong style={{ fontSize: 13 }}>No journeys detected</Strong>
                          <Paragraph style={{ fontSize: 12, marginBottom: 0, marginTop: 4, opacity: 0.8 }}>
                            Make sure your analysis includes a "Journey Classification" or "Journey Names" section with named journeys.
                            You can also type a custom journey name below.
                          </Paragraph>
                        </div>
                      </Flex>
                      <TextInput
                        value={selectedJourneyName}
                        onChange={(value) => setSelectedJourneyName(value)}
                        placeholder="e.g., Purchase Journey, Subscription Flow"
                        style={{ width: '100%', marginTop: 10 }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: '16px 24px', borderTop: `1px solid ${Colors.Border.Neutral.Default}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Button onClick={() => setShowPasteAiModal(false)} style={{ padding: '8px 16px' }}>
                Cancel
              </Button>
              <Flex alignItems="center" gap={12}>
                {ghCopilotConfigured && (
                  <select
                    value={ghCopilotModel}
                    onChange={(e: any) => setGhCopilotModel(e.target.value)}
                    style={{
                      padding: '7px 10px', borderRadius: 6,
                      background: Colors.Background.Base.Default,
                      border: `1px solid ${Colors.Border.Neutral.Default}`,
                      color: Colors.Text.Neutral.Default, fontSize: 12,
                      cursor: 'pointer', minWidth: 120,
                    }}
                  >
                    {aiModelOptions.map(id => (
                      <option key={id} value={id}>{id}</option>
                    ))}
                  </select>
                )}
                <Button
                  variant="accent"
                  disabled={!selectedJourneyName || !pastedAiResponse || pastedAiResponse.length < 50 || !ghCopilotConfigured}
                  onClick={() => runPastedAiPipeline(pastedAiResponse, selectedJourneyName)}
                  title={!ghCopilotConfigured ? 'Configure an AI provider in Settings first' : `Generate "${selectedJourneyName}" config`}
                  style={{
                    padding: '10px 24px', fontWeight: 700, fontSize: 14,
                    background: ghCopilotConfigured && selectedJourneyName ? 'linear-gradient(135deg, rgba(108,44,156,0.9), rgba(0,161,201,0.9))' : undefined,
                    color: ghCopilotConfigured && selectedJourneyName ? 'white' : undefined,
                    border: ghCopilotConfigured && selectedJourneyName ? 'none' : undefined,
                    borderRadius: 10,
                    opacity: (!selectedJourneyName || !ghCopilotConfigured) ? 0.4 : 1,
                  }}
                >
                  🚀 Generate Journey Config
                </Button>
              </Flex>
            </div>
          </div>
        </div>
      )}

      <div style={{ position: 'fixed', bottom: 4, right: 8, fontSize: 9, color: 'rgba(255,255,255,0.18)', zIndex: 1, pointerEvents: 'none', fontFamily: 'monospace' }}>v{APP_VERSION}</div>
    </Page>
  );
};
