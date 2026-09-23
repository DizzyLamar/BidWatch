import { db } from './runtime';

export const OPPORTUNITY_SOURCES = [
  { id: 'pppc', name: 'PPPC procurement adverts', url: 'https://www.pppc.mw/procurement/adverts', kind: 'public' as const },
  { id: 'ppda', name: 'PPDA procurement notices', url: 'https://ppda.mw/tenders', kind: 'public' as const },
  { id: 'maneps', name: 'MANEPS OCDS procurement data', url: 'https://maneps.mw/procurement-notice', kind: 'api' as const },
  { id: 'careersmw', name: 'Careers Malawi tenders & bids', url: 'https://careersmw.com/tenders-and-non-consultancy-services/', kind: 'public' as const },
] as const;

export const OPPORTUNITY_TERMS = [
  'ict', 'ict equipment', 'ict infrastructure', 'information technology', 'information systems',
  'cybersecurity', 'cyber security', 'information security', 'penetration testing', 'penetration test',
  'vulnerability assessment', 'security assessment', 'security audit', 'soc', 'siem', 'endpoint security',
  'edr', 'xdr', 'firewall', 'network security', 'identity and access management', 'iam', 'zero trust',
  'privileged access', 'mfa', 'multi-factor authentication', 'data protection', 'privacy', 'digital forensics',
  'incident response', 'iso 27001', 'pci dss', 'dlp', 'managed detection', 'managed security', 'cloud security',
  'backup', 'disaster recovery', 'business continuity', 'cloud', 'data centre', 'data center', 'server',
  'network', 'networking', 'router', 'switch', 'wireless', 'internet', 'connectivity', 'structured cabling',
  'voip', 'telecommunications', 'software', 'software development', 'application development', 'web development',
  'mobile application', 'database', 'erp', 'crm', 'api', 'website', 'systems integration', 'digital transformation',
  'automation', 'data analytics', 'business intelligence', 'artificial intelligence', 'machine learning', 'gis',
  'it support', 'it consulting', 'it consultancy', 'ict consulting', 'ict consultancy', 'technical support',
  'helpdesk', 'managed services', 'software licence', 'software license', 'licence renewal', 'license renewal',
  'computer', 'computer equipment', 'laptop', 'desktop computer', 'printer', 'cctv', 'access control'
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

const CONSTRUCTION_TERMS = [
  'construction', 'civil works', 'building works', 'road works', 'roads', 'bridge', 'bridges',
  'water reticulation', 'plumbing', 'painting', 'roofing', 'masonry', 'carpentry', 'architectural',
  'quantity surveying', 'structural engineering', 'mixed-use development', 'ablution block',
  'rehabilitation works', 'maintenance materials', 'motor vehicles', 'motorcycles', 'stationery',
  'furniture', 'tyres', 'medical equipment', 'sports equipment', 'apparel', 'tools', 'uniforms'
];
const CYBER_TERMS = new Set([
  'cybersecurity', 'cyber security', 'information security', 'penetration testing', 'penetration test',
  'vulnerability assessment', 'security assessment', 'security audit', 'soc', 'siem', 'endpoint security',
  'edr', 'xdr', 'firewall', 'network security', 'identity and access management', 'iam', 'zero trust',
  'privileged access', 'mfa', 'multi-factor authentication', 'data protection', 'privacy', 'digital forensics',
  'incident response', 'iso 27001', 'pci dss', 'dlp', 'managed detection', 'managed security', 'cloud security'
]);
function matchTerms(value: string) {
  const haystack = value.toLowerCase();
  return OPPORTUNITY_TERMS.filter(term => {
    const escaped = term.replace(/[.*+?^()|[\]\\]/g, '\\$&');
    return new RegExp('(^|[^a-z0-9])' + escaped + '(?=$|[^a-z0-9])', 'i').test(haystack);
  }).slice(0, 12);
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

function absoluteUrl(value: string, base: string) {
  try {
    return new URL(value, base).toString();
  } catch {
    return '';
  }
}

function extractArticleTitle(html: string) {
  const og = html.match(/<meta[^>]+property=[\"']og:title[\"'][^>]+content=[\"']([^\"']+)[\"']/i)?.[1];
  if (og) return decodeHtml(og);
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  if (h1) return decodeHtml(h1);
  return '';
}

function extractArticleText(html: string) {
  return decodeHtml(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
  );
}

function extractReference(value: string) {
  const match = value.match(/(?:procurement\s+reference(?:\s+number)?|reference\s*(?:number|no\.?))\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_ .-]{3,100})/i);
  return match ? match[1].replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '') : '';
}

function extractOrganisation(value: string) {
  const patterns = [
    /(?:employer|procuring\s+entity|contracting\s+authority|procurement\s+entity|purchasing\s+entity)\s*[:\-]\s*([^.;\n]{3,160})/i,
    /(?:Malawi\s+Revenue\s+Authority|Electricity\s+Supply\s+Corporation\s+of\s+Malawi(?:\s+Limited)?|Banja\s+La\s+Mtsogolo|University\s+of\s+Malawi|National\s+Food\s+Reserve\s+Agency)/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return (match[1] || match[0]).replace(/\s+/g, ' ').trim();
  }
  return '';
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
    const details = await Promise.all(items.slice(0, 120).map(async (item: any) => {
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
    const notices = details.flatMap((payload: unknown) => extractOcdsCandidates(payload).map(candidate => normalizeCandidate(candidate, source.id, source.name, source.url, text(candidate.reference))).filter((item): item is Opportunity => Boolean(item)));
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

function decodeHtml(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|td|th|tr|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDate(value: string) {
  const normalized = value.replace(/(\d{1,2})(st|nd|rd|th)/gi, '$1');
  const patterns = [
    /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2})?)?\b/,
    /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/,
    /\b\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/i,
    /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) {
      const parsed = new Date(match[0]).getTime();
      if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
    }
  }
  return '';
}

function extractPublicRows(html: string) {
  const rows: Array<{ cells: string[]; links: string[] }> = [];
  const rowMatches = html.match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rowMatches) {
    const cells = (row.match(/<(?:td|th)[^>]*>[\s\S]*?<\/(?:td|th)>/gi) || []).map(decodeHtml).filter(Boolean);
    if (cells.length < 2) continue;
    const links = Array.from(row.matchAll(/href\s*=\s*["']([^"']+)["']/gi)).map(match => match[1]);
    rows.push({ cells, links });
  }
  return rows;
}

function publicCandidates(html: string, source: typeof OPPORTUNITY_SOURCES[number]) {
  const candidates: Array<Record<string, unknown>> = [];
  for (const row of extractPublicRows(html)) {
    const joined = row.cells.join(' ');
    const lower = joined.toLowerCase();
    if (/title|institution|reference|publish date|closing date/.test(lower) && row.cells.every(cell => /title|institution|reference|publish|closing/i.test(cell))) continue;

    const deadlineMatch = joined.match(/(?:closing|submission|deadline|due)[^.;]{0,80}/i);
    const deadline = extractDate(deadlineMatch?.[0] || row.cells[row.cells.length - 1] || '');
    const title = row.cells[0] || '';
    const organisation = row.cells[1] || '';
    const reference = row.cells[2] || '';
    const publishedAt = extractDate(row.cells[3] || '');
    const description = row.cells.slice(0, 5).join(' — ');
    const url = row.links.find(link => /pdf|doc|download|notice|tender/i.test(link)) || row.links[0] || source.url;

    candidates.push({ title, organisation, reference, deadline, publishedAt, description, noticeType: 'Procurement notice', url });
  }

  if (!candidates.length) {
    const linkMatches = Array.from(html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi));
    for (const match of linkMatches) {
      const title = decodeHtml(match[2]);
      if (title.length < 20 || title.length > 240) continue;
      candidates.push({ title, organisation: '', reference: '', deadline: extractDate(title), description: title, noticeType: 'Procurement notice', url: match[1] });
    }
  }
  return candidates;
}

async function scanCareersMw(): Promise<OpportunitySourceResult> {
  const source = OPPORTUNITY_SOURCES.find(item => item.id === 'careersmw')!;
  try {
    const html = await fetchText(source.url);
    const links = Array.from(html.matchAll(/<a[^>]+href=[\"']([^\"']+)[\"'][^>]*>([\s\S]*?)<\/a>/gi))
      .map(match => ({ url: absoluteUrl(match[1], source.url), title: decodeHtml(match[2]) }))
      .filter(item => item.url.startsWith('https://careersmw.com/') && item.url !== source.url && item.title.length >= 12)
      .filter(item => !/\/page\/\d+\/?$|\/category\/|\/tag\//i.test(item.url));
    const uniqueLinks = Array.from(new Map(links.map(item => [item.url, item])).values()).slice(0, 60);
    const pages = await Promise.all(uniqueLinks.map(async link => {
      try {
        return { link, html: await fetchText(link.url) };
      } catch {
        return null;
      }
    }));
    const notices = pages.flatMap(item => {
      if (!item) return [];
      const articleText = extractArticleText(item.html);
      const title = extractArticleTitle(item.html) || item.link.title;
      const deadline = extractDate(articleText);
      const candidate = {
        title,
        organisation: extractOrganisation(articleText),
        reference: extractReference(articleText),
        deadline,
        description: articleText.slice(0, 8000),
        noticeType: 'Tender / bid / consultancy',
        url: item.link.url,
      };
      const normalized = normalizeCandidate(candidate, source.id, source.name, source.url);
      return normalized ? [normalized] : [];
    });
    const unique = new Map<string, Opportunity>();
    for (const item of notices) unique.set((item.reference + '|' + item.url + '|' + item.title).toLowerCase(), item);
    return {
      sourceId: source.id,
      source: source.name,
      sourceUrl: source.url,
      status: 'ok',
      accessMethod: 'public-page',
      notices: Array.from(unique.values()).slice(0, 80),
      message: 'Careers Malawi exposed ' + uniqueLinks.length + ' tender/bid pages; ' + unique.size + ' matched the ICT/cybersecurity opportunity rules.',
    };
  } catch {
    return {
      sourceId: source.id,
      source: source.name,
      sourceUrl: source.url,
      status: 'error',
      accessMethod: 'public-page',
      notices: [],
      message: 'Careers Malawi could not be scanned right now.',
    };
  }
}

async function fetchText(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'text/html,application/xhtml+xml' },
    });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function scanPublicPage(source: typeof OPPORTUNITY_SOURCES[number]): Promise<OpportunitySourceResult> {
  try {
    const html = (await fetchText(source.url)).slice(0, 250000);
    if (html.length < 120) {
      return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'error', accessMethod: 'public-page', notices: [], message: 'The public page did not expose enough procurement content for extraction.' };
    }

    const raw = publicCandidates(html, source);
    const notices = raw.map(item => normalizeCandidate(item, source.id, source.name, source.url)).filter((item): item is Opportunity => Boolean(item));
    const unique = new Map<string, Opportunity>();
    for (const item of notices) unique.set((item.reference + '|' + item.url + '|' + item.title).toLowerCase(), item);

    return {
      sourceId: source.id,
      source: source.name,
      sourceUrl: source.url,
      status: 'ok',
      accessMethod: 'public-page',
      notices: Array.from(unique.values()).slice(0, 80),
      message: 'Found ' + unique.size + ' relevant opportunities using deterministic public-page extraction. Missing values are left blank rather than inferred.',
    };
  } catch {
    return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'error', accessMethod: 'public-page', notices: [], message: 'The public source could not be scanned right now.' };
  }
}

export async function discoverPlatformOpportunities() {
  const results: OpportunitySourceResult[] = [];
  results.push(await scanManeps());
  results.push(await scanCareersMw());
  for (const source of OPPORTUNITY_SOURCES.filter(item => item.id !== 'maneps' && item.id !== 'careersmw')) results.push(await scanPublicPage(source));
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
  const current = result.items
    .map(item => {
      const relevance = isRelevant(text(item.title), text(item.description), '');
      return { ...item, matchedTerms: relevance.matched, _relevant: relevance.accept };
    })
    .filter(item => {
      if (item.state === 'dismissed' || !item._relevant) return false;
      if (!item.deadline) return true;
      const time = new Date(item.deadline).getTime();
      return Number.isFinite(time) && time >= Date.now();
    });
  const byReference = new Map<string, Set<string>>();
  for (const item of current) { const reference = text(item.reference).toLowerCase(); if (!reference) continue; const sources = byReference.get(reference) || new Set<string>(); sources.add(item.source); byReference.set(reference, sources); }
  return current.sort((a, b) => new Date(b.lastSeenAt || b.firstSeenAt).getTime() - new Date(a.lastSeenAt || a.firstSeenAt).getTime()).slice(0, limit).map(item => {
    const { _relevant: _ignored, ...clean } = item;
    const reference = text(item.reference).toLowerCase();
    const sources = reference ? Array.from(byReference.get(reference) || []).filter(source => source !== item.source) : [];
    return { ...clean, alsoListedOn: sources };
  });
}
