import { ai, db } from '@appdeploy/sdk';

export const OPPORTUNITY_SOURCES = [
  { id: 'pppc', name: 'PPPC procurement adverts', url: 'https://www.pppc.mw/procurement/adverts', kind: 'public' as const },
  { id: 'ppda', name: 'PPDA procurement notices', url: 'https://ppda.mw/tenders', kind: 'public' as const },
  { id: 'maneps', name: 'MANEPS OCDS procurement data', url: 'https://maneps.mw/procurement-notice', kind: 'api' as const },
] as const;

export const OPPORTUNITY_TERMS = [
  'ict', 'information technology', 'information systems', 'cybersecurity', 'cyber security', 'information security',
  'penetration testing', 'penetration test', 'vulnerability assessment', 'security assessment', 'security audit',
  'soc', 'siem', 'endpoint security', 'edr', 'xdr', 'firewall', 'network security', 'identity and access management',
  'iam', 'zero trust', 'privileged access', 'mfa', 'multi-factor authentication', 'data protection', 'privacy',
  'digital forensics', 'incident response', 'iso 27001', 'pci dss', 'dlp', 'managed detection', 'managed security',
  'cloud security', 'backup', 'disaster recovery', 'business continuity', 'cloud', 'data centre', 'data center',
  'server', 'network', 'router', 'switch', 'wireless', 'internet', 'connectivity', 'structured cabling', 'voip',
  'telecommunications', 'software', 'application development', 'web development', 'mobile application', 'database',
  'erp', 'crm', 'api', 'website', 'systems integration', 'digital transformation', 'automation', 'data analytics',
  'business intelligence', 'artificial intelligence', 'machine learning', 'gis', 'it support', 'technical support',
  'helpdesk', 'managed services', 'software licence', 'software license', 'licence renewal', 'license renewal',
  'ict equipment', 'computer', 'laptop', 'cctv', 'access control', 'consultancy', 'consulting', 'advisory',
  'request for proposal', 'request for proposals', 'request for quotation', 'request for quotations', 'rfp', 'rfq',
  'expression of interest', 'eoi', 'invitation for bids', 'tender', 'procurement notice', 'framework agreement',
  'consultation'
];

export type Opportunity = {
  title?: string;
  organisation?: string;
  reference?: string;
  deadline?: string;
  description?: string;
  noticeType?: string;
  url?: string;
  sourceId: string;
  source: string;
  sourceUrl: string;
  matchedTerms: string[];
  externalId?: string;
};

export type OpportunitySourceResult = {
  sourceId: string;
  source: string;
  sourceUrl: string;
  status: 'ok' | 'authentication_required' | 'error';
  accessMethod: 'public-page' | 'public-ocds-api';
  notices: Opportunity[];
  message: string;
};

export type OpportunityUpdate = Opportunity & {
  id: string;
  state: 'new' | 'imported' | 'dismissed';
  firstSeenAt: string;
  lastSeenAt: string;
  importedTenderId?: string;
};

const CONSTRUCTION_TERMS = ['construction', 'civil works', 'building works', 'road works', 'roads', 'bridge', 'bridges', 'water reticulation', 'plumbing', 'painting', 'roofing', 'masonry', 'carpentry', 'architectural', 'quantity surveying', 'structural engineering', 'mixed-use development'];
const CYBER_TERMS = new Set(['cybersecurity', 'cyber security', 'information security', 'penetration testing', 'penetration test', 'vulnerability assessment', 'security assessment', 'security audit', 'soc', 'siem', 'endpoint security', 'edr', 'xdr', 'firewall', 'network security', 'identity and access management', 'iam', 'zero trust', 'privileged access', 'mfa', 'multi-factor authentication', 'data protection', 'privacy', 'digital forensics', 'incident response', 'iso 27001', 'pci dss', 'dlp', 'managed detection', 'managed security', 'cloud security']);
function matchTerms(value: string) {
  const haystack = value.toLowerCase();
  return OPPORTUNITY_TERMS.filter(term => haystack.includes(term)).slice(0, 12);
}
function isRelevant(title: string, description: string, category: string) {
  const primary = `${title} ${description} ${category}`.toLowerCase();
  const matched = matchTerms(primary);
  const constructionHeavy = CONSTRUCTION_TERMS.some(term => primary.includes(term));
  const explicitCyber = matched.some(term => CYBER_TERMS.has(term));
  return { matched, accept: matched.length > 0 && (!constructionHeavy || explicitCyber) };
}

function text(value: unknown) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function firstString(...values: unknown[]) {
  return values.map(text).find(Boolean) || '';
}

function dateString(value: unknown) {
  const candidate = text(value);
  if (!candidate) return '';
  const time = new Date(candidate).getTime();
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

function activeEnough(candidate: Record<string, unknown>) {
  const status = text(candidate.status || candidate.procurementStatus).toLowerCase();
  if (/cancel|closed|complete|terminated|awarded|contracted|finalised|finalized/.test(status)) return false;
  const deadline = dateString(candidate.deadline);
  return !deadline || new Date(deadline).getTime() >= Date.now() - 86400000;
}

function normalizeCandidate(candidate: Record<string, unknown>, sourceId: string, source: string, sourceUrl: string, externalId = ''): Opportunity | null {
  const title = firstString(candidate.title, candidate.name, candidate.description);
  const description = firstString(candidate.description, candidate.summary, candidate.scope, candidate.title);
  const category = text(candidate.category);
  const relevance = isRelevant(title, description, category);
  if (!title || !relevance.accept || !activeEnough({ ...candidate, deadline: candidate.deadline })) return null;
  const matchedTerms = relevance.matched;
  const deadline = dateString(candidate.deadline);
  const reference = firstString(candidate.reference, candidate.tenderId, candidate.id, externalId);
  return {
    title,
    organisation: firstString(candidate.organisation, candidate.buyerName, candidate.buyer),
    reference,
    deadline,
    description,
    noticeType: firstString(candidate.noticeType, candidate.procurementMethod, 'Procurement notice'),
    url: firstString(candidate.url, sourceUrl),
    sourceId,
    source,
    sourceUrl,
    matchedTerms,
    externalId: externalId || reference || title,
  };
}

function extractOcdsCandidates(payload: unknown): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const walk = (node: unknown, inheritedOcid = '') => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item, inheritedOcid);
      return;
    }
    const obj = node as Record<string, unknown>;
    const ocid = firstString(obj.ocid, inheritedOcid);
    const release = obj.compiledRelease && typeof obj.compiledRelease === 'object' ? obj.compiledRelease as Record<string, unknown> : obj;
    const tender = release.tender && typeof release.tender === 'object' ? release.tender as Record<string, unknown> : null;
    if (tender) {
      const buyer = release.buyer && typeof release.buyer === 'object' ? release.buyer as Record<string, unknown> : {};
      const key = firstString(tender.id, ocid, release.id);
      if (key && !seen.has(key)) {
        seen.add(key);
        candidates.push({
          id: tender.id,
          tenderId: tender.id,
          title: tender.title,
          description: tender.description,
          category: Array.isArray(tender.items) ? tender.items.map(item => typeof item === 'object' ? text((item as Record<string, unknown>).description) : '').join(' ') : '',
          procurementMethod: tender.procurementMethodDetails || tender.procurementMethod,
          noticeType: Array.isArray(release.tag) ? release.tag.join(', ') : '',
          deadline: typeof tender.tenderPeriod === 'object' && tender.tenderPeriod ? (tender.tenderPeriod as Record<string, unknown>).end : '',
          buyerName: buyer.name,
          url: firstString(tender.documents && Array.isArray(tender.documents) ? (tender.documents[0] as Record<string, unknown>)?.url : '', release.url),
          reference: tender.id || ocid,
          status: tender.status,
        });
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'compiledRelease' || key === 'tender' || key === 'buyer') continue;
      walk(value, ocid);
    }
  };
  walk(payload);
  return candidates;
}

async function fetchJson(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, headers: { Accept: 'application/json', ...(init.headers || {}) } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function scanManeps(): Promise<OpportunitySourceResult> {
  const source = OPPORTUNITY_SOURCES.find(item => item.id === 'maneps')!;
  const apiBase = 'https://maneps.mw/rms/api/ocds';
  try {
    const index = await fetchJson(`${apiBase}/get-records`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skip: 0, take: 250 }),
    });
    const items = Array.isArray(index?.items) ? index.items : [];
    const details = await Promise.all(items.slice(0, 120).map(async item => {
      const ocid = text(item?.ocid);
      if (!ocid) return null;
      try {
        return await fetchJson(`${apiBase}/record-package/${encodeURIComponent(ocid)}`);
      } catch {
        try {
          return await fetchJson(`${apiBase}/release-package/${encodeURIComponent(ocid)}`);
        } catch {
          return null;
        }
      }
    }));
    const notices = details.flatMap(payload => extractOcdsCandidates(payload).map(candidate => normalizeCandidate(candidate, source.id, source.name, source.url, text(candidate.reference))).filter((item): item is Opportunity => Boolean(item)));
    const unique = new Map<string, Opportunity>();
    for (const item of notices) unique.set(`${item.reference}|${item.url}|${item.title}`.toLowerCase(), item);
    return {
      sourceId: source.id,
      source: source.name,
      sourceUrl: source.url,
      status: 'ok',
      accessMethod: 'public-ocds-api',
      notices: Array.from(unique.values()).slice(0, 80),
      message: `MANEPS OCDS API returned ${items.length} records; ${unique.size} matched the ICT/cybersecurity opportunity rules.`,
    };
  } catch {
    return {
      sourceId: source.id,
      source: source.name,
      sourceUrl: source.url,
      status: 'error',
      accessMethod: 'public-ocds-api',
      notices: [],
      message: 'The MANEPS OCDS API could not be reached. BidWatch did not use a MANEPS login or browser session.',
    };
  }
}

async function scanPublicPage(source: typeof OPPORTUNITY_SOURCES[number]): Promise<OpportunitySourceResult> {
  try {
    const scraped = await ai.scrape({ url: source.url });
    const content = text(scraped.text).slice(0, 70000);
    if (content.length < 120) {
      return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'error', accessMethod: 'public-page', notices: [], message: 'The public page did not expose enough procurement content for extraction.' };
    }
    const extracted = await ai.extract({
      content,
      prompt: `Extract current procurement opportunities relevant to an ICT and cybersecurity company from ${source.name}. Include tenders, bids, RFPs, RFQs, expressions of interest, consultancy, advisory services, technology consultations, software, data, networking, infrastructure, telecommunications and security opportunities. Do not invent missing values. Exclude clearly unrelated opportunities.`,
      schema: {
        type: 'object',
        properties: {
          notices: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string' }, organisation: { type: 'string' }, reference: { type: 'string' },
                deadline: { type: 'string' }, description: { type: 'string' }, noticeType: { type: 'string' }, url: { type: 'string' },
              },
              required: ['title'],
            },
          },
        },
        required: ['notices'],
      },
      maxTokens: 6000,
      thinkingMode: 'FAST',
    });
    const extractedData = extracted.data as { notices?: unknown[] } | undefined;
    const raw = Array.isArray(extractedData?.notices) ? extractedData.notices : [];
    const notices = raw.map(item => normalizeCandidate(item as Record<string, unknown>, source.id, source.name, source.url)).filter((item): item is Opportunity => Boolean(item));
    const unique = new Map<string, Opportunity>();
    for (const item of notices) unique.set(`${item.reference}|${item.url}|${item.title}`.toLowerCase(), item);
    return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'ok', accessMethod: 'public-page', notices: Array.from(unique.values()).slice(0, 80), message: `Found ${unique.size} relevant opportunities in the accessible public page.` };
  } catch {
    return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'error', accessMethod: 'public-page', notices: [], message: 'The public source could not be scanned right now.' };
  }
}

export async function discoverPlatformOpportunities() {
  const results: OpportunitySourceResult[] = [];
  results.push(await scanManeps());
  for (const source of OPPORTUNITY_SOURCES.filter(item => item.id !== 'maneps')) results.push(await scanPublicPage(source));
  return results;
}

function updateKey(item: Opportunity) {
  return `${item.sourceId}|${item.reference || ''}|${item.url || ''}|${item.title || ''}`.toLowerCase();
}

export async function persistOpportunityUpdates(results: OpportunitySourceResult[]) {
  const existing = await db.list<OpportunityUpdate>('opportunity_updates', { limit: 1000 });
  const byKey = new Map(existing.items.map(item => [updateKey(item), item]));
  const timestamp = new Date().toISOString();
  for (const result of results) {
    for (const opportunity of result.notices) {
      const key = updateKey(opportunity);
      const current = byKey.get(key);
      if (current) {
        await db.update('opportunity_updates', [{ id: current.id, record: { ...current, ...opportunity, lastSeenAt: timestamp } }]);
      } else {
        const [id] = await db.add('opportunity_updates', [{ ...opportunity, state: 'new', firstSeenAt: timestamp, lastSeenAt: timestamp }]);
        if (id) byKey.set(key, { ...opportunity, id, state: 'new', firstSeenAt: timestamp, lastSeenAt: timestamp });
      }
    }
  }
  return timestamp;
}

export async function listOpportunityUpdates(limit = 30) {
  const result = await db.list<OpportunityUpdate>('opportunity_updates', { limit: 500 });
  const current = result.items.filter(item => { if (item.state === 'dismissed') return false; if (!item.deadline) return true; const time = new Date(item.deadline).getTime(); return Number.isFinite(time) && time >= Date.now(); });
  const byReference = new Map<string, Set<string>>();
  for (const item of current) { const reference = text(item.reference).toLowerCase(); if (!reference) continue; const sources = byReference.get(reference) || new Set<string>(); sources.add(item.source); byReference.set(reference, sources); }
  return current.sort((a, b) => new Date(b.lastSeenAt || b.firstSeenAt).getTime() - new Date(a.lastSeenAt || a.firstSeenAt).getTime()).slice(0, limit).map(item => { const reference = text(item.reference).toLowerCase(); const sources = reference ? Array.from(byReference.get(reference) || []).filter(source => source !== item.source) : []; return { ...item, alsoListedOn: sources }; });
}
