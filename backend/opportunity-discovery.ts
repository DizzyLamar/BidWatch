import { ai, db } from '@appdeploy/sdk';

export const OPPORTUNITY_SOURCES = [
  { id: 'careersmw', name: 'Careers Malawi tenders', url: 'https://careersmw.com/tenders-and-non-consultancy-services/', kind: 'public' as const },
  { id: 'pppc', name: 'PPPC procurement adverts', url: 'https://www.pppc.mw/procurement/adverts', kind: 'public' as const },
  { id: 'ppda', name: 'PPDA procurement notices', url: 'https://ppda.mw/tenders', kind: 'public' as const },
  { id: 'maneps', name: 'MANEPS OCDS procurement data', url: 'https://maneps.mw/procurement-notice', kind: 'api' as const },
] as const;

export type RelevanceLevel = 'high' | 'medium' | 'low';
export type FitLevel = 'direct' | 'partner' | 'peripheral';
export type CapabilityCategory =
  | 'Software & Development' | 'Cybersecurity' | 'IT Infrastructure' | 'ICT Hardware'
  | 'IT Support' | 'Telecommunications' | 'Data & Analytics' | 'Digital Services' | 'Consulting';

type Classification = {
  relevanceScore: number;
  relevanceLevel: RelevanceLevel;
  fitLevel: FitLevel;
  categories: CapabilityCategory[];
  matchedTerms: string[];
  matchedSections: string[];
  reason: string;
};

const CATEGORY_TERMS: Record<CapabilityCategory, string[]> = {
  'Software & Development': ['software development','application development','web development','mobile application','mobile app','software implementation','system development','information system','management information system','mis','erp','crm','api','systems integration','database','web portal','website','digital platform','automation'],
  Cybersecurity: ['cybersecurity','cyber security','information security','penetration testing','penetration test','vulnerability assessment','security assessment','security audit','soc','siem','endpoint security','edr','xdr','firewall','network security','identity and access management','iam','zero trust','privileged access','mfa','multi-factor authentication','data protection','privacy','digital forensics','incident response','iso 27001','pci dss','dlp','managed detection','managed security','cloud security','access control','biometric','cctv','surveillance'],
  'IT Infrastructure': ['server','data centre','data center','network','router','switch','wireless','wi-fi','wifi','structured cabling','lan','wan','cloud','backup','disaster recovery','business continuity','ups','virtualization','virtualisation','storage'],
  'ICT Hardware': ['ict equipment','ict devices','computer','computers','desktop','laptop','tablet','printer','scanner','server equipment','storage device','computer accessories','communication gadgets','hardware'],
  'IT Support': ['ict support','it support','technical support','helpdesk','help desk','managed services','maintenance','computer maintenance','software maintenance','hardware maintenance','system administration','repair and maintenance','it consulting'],
  Telecommunications: ['internet services','internet connectivity','connectivity','telecommunications','telecommunication','pabx','voip','voice over ip','communication system'],
  'Data & Analytics': ['data analytics','business intelligence','data management','data warehouse','data collection','dashboard','reporting','gis','geographic information system','artificial intelligence','machine learning','real time stock management system'],
  'Digital Services': ['digital transformation','digital services','online platform','e-commerce','online system','electronic system','digital platform','online portal'],
  Consulting: ['ict consultancy','it consultancy','technology consulting','ict consulting','cybersecurity consulting','information security consultancy','advisory services','technology advisory'],
};

const SECTION_WEIGHTS: Record<string, number> = { title: 5, description: 3, scope: 4, requirements: 3, category: 3 };
const WEAK_CONTEXT_TERMS = ['computer-generated','electronic submission','digital copy','submit electronically','email correspondence','online application','electronic copy'];
const CONSTRUCTION_TERMS = ['construction','civil works','building works','road works','roads','bridge','bridges','water reticulation','plumbing','painting','roofing','masonry','carpentry','architectural','quantity surveying','structural engineering','mixed-use development'];
const DIRECT_CATEGORIES = new Set<CapabilityCategory>(['Software & Development','Cybersecurity','IT Support','Data & Analytics','Digital Services','Consulting']);
const PARTNER_CATEGORIES = new Set<CapabilityCategory>(['ICT Hardware','IT Infrastructure','Telecommunications']);

export type Opportunity = {
  title?: string; organisation?: string; reference?: string; deadline?: string; description?: string;
  noticeType?: string; url?: string; sourceId: string; source: string; sourceUrl: string;
  matchedTerms: string[]; matchedSections?: string[]; categories?: CapabilityCategory[];
  relevanceScore?: number; relevanceLevel?: RelevanceLevel; fitLevel?: FitLevel;
  classificationReason?: string; classifierVersion?: string; rawText?: string; contentHash?: string; externalId?: string;
};

export type OpportunitySourceResult = {
  sourceId: string; source: string; sourceUrl: string;
  status: 'ok' | 'authentication_required' | 'error';
  accessMethod: 'public-page' | 'public-ocds-api'; notices: Opportunity[]; message: string;
};

export type OpportunityUpdate = Opportunity & {
  id: string; state: 'new' | 'imported' | 'dismissed'; firstSeenAt: string; lastSeenAt: string; importedTenderId?: string;
};

function text(value: unknown) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function firstString(...values: unknown[]) { return values.map(text).find(Boolean) || ''; }
function normalizeForMatch(value: string) { return text(value).toLowerCase().replace(/[–—]/g, '-'); }
function dateString(value: unknown) { const candidate = text(value); if (!candidate) return ''; const time = new Date(candidate).getTime(); return Number.isFinite(time) ? new Date(time).toISOString() : ''; }
function activeEnough(candidate: Record<string, unknown>) {
  const status = text(candidate.status || candidate.procurementStatus).toLowerCase();
  if (/cancel|closed|complete|terminated|awarded|contracted|finalised|finalized/.test(status)) return false;
  const deadline = dateString(candidate.deadline);
  return !deadline || new Date(deadline).getTime() >= Date.now() - 86400000;
}
function hashContent(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }
  return (hash >>> 0).toString(16);
}

export function classifyTender(fields: { title: string; description: string; scope?: string; requirements?: string; category?: string }): Classification {
  const sections = [
    ['title', normalizeForMatch(fields.title)], ['description', normalizeForMatch(fields.description)],
    ['scope', normalizeForMatch(fields.scope || '')], ['requirements', normalizeForMatch(fields.requirements || '')],
    ['category', normalizeForMatch(fields.category || '')],
  ] as const;
  const constructionHeavy = CONSTRUCTION_TERMS.some(term => sections.some(([, value]) => value.includes(term)));
  const scores = new Map<CapabilityCategory, number>();
  const matched = new Map<string, Set<string>>();

  for (const [category, terms] of Object.entries(CATEGORY_TERMS) as Array<[CapabilityCategory, string[]]>) {
    for (const term of terms) for (const [section, value] of sections) {
      if (!value.includes(term)) continue;
      scores.set(category, (scores.get(category) || 0) + (SECTION_WEIGHTS[section] || 1));
      const sectionMatches = matched.get(term) || new Set<string>();
      sectionMatches.add(section); matched.set(term, sectionMatches);
    }
  }

  const strongCategories = Array.from(scores.entries()).filter(([, score]) => score >= 4).sort((a, b) => b[1] - a[1]);
  const matchedTerms = Array.from(matched.keys()).sort((a, b) => {
    const score = (term: string) => Array.from(scores.entries()).find(([category]) => CATEGORY_TERMS[category].includes(term))?.[1] || 0;
    return score(b) - score(a);
  }).slice(0, 16);
  let relevanceScore = Math.min(100, strongCategories.reduce((sum, [, score]) => sum + score, 0));
  const explicitCyber = strongCategories.some(([category]) => category === 'Cybersecurity');
  if (constructionHeavy && !explicitCyber && strongCategories.length) relevanceScore = Math.max(0, relevanceScore - 12);
  const weakContextHits = WEAK_CONTEXT_TERMS.filter(term => sections.some(([, value]) => value.includes(term)));
  if (weakContextHits.length && !strongCategories.length) relevanceScore = 0;

  const categories = strongCategories.slice(0, 4).map(([category]) => category);
  const relevanceLevel: RelevanceLevel = relevanceScore >= 24 ? 'high' : relevanceScore >= 10 ? 'medium' : 'low';
  const fitLevel: FitLevel = categories.some(category => DIRECT_CATEGORIES.has(category)) ? 'direct'
    : categories.some(category => PARTNER_CATEGORIES.has(category)) ? 'partner' : 'peripheral';
  const matchedSections = Array.from(new Set(matchedTerms.flatMap(term => Array.from(matched.get(term) || []))));
  let reason = categories.length
    ? 'Matched ' + categories.slice(0, 3).join(', ') + ' capability areas from the tender content.'
    : 'No strong technology capability signal was found.';
  if (constructionHeavy && !explicitCyber) reason += ' Construction/civil-work signals reduced the technology relevance score.';
  if (weakContextHits.length && !categories.length) reason += ' Generic electronic/online wording was treated as weak context rather than an ICT opportunity.';

  return { relevanceScore, relevanceLevel, fitLevel, categories, matchedTerms, matchedSections, reason };
}

function normalizeCandidate(candidate: Record<string, unknown>, sourceId: string, source: string, sourceUrl: string, externalId = '', rawText = ''): Opportunity | null {
  const title = firstString(candidate.title, candidate.name);
  const description = firstString(candidate.description, candidate.summary, candidate.scope, candidate.title);
  const scope = firstString(candidate.scope, candidate.deliverables);
  const requirements = firstString(candidate.requirements, candidate.eligibility);
  const category = text(candidate.category);
  if (!title || !activeEnough({ ...candidate, deadline: candidate.deadline })) return null;
  const classification = classifyTender({ title, description, scope, requirements, category });
  if (classification.relevanceScore < 4) return null;
  const deadline = dateString(candidate.deadline);
  const reference = firstString(candidate.reference, candidate.tenderId, candidate.id, externalId);
  const normalizedRaw = text(rawText).slice(0, 30000);
  return {
    title, organisation: firstString(candidate.organisation, candidate.buyerName, candidate.buyer), reference, deadline,
    description, noticeType: firstString(candidate.noticeType, candidate.procurementMethod, 'Procurement notice'),
    url: firstString(candidate.url, sourceUrl), sourceId, source, sourceUrl,
    matchedTerms: classification.matchedTerms, matchedSections: classification.matchedSections,
    categories: classification.categories, relevanceScore: classification.relevanceScore,
    relevanceLevel: classification.relevanceLevel, fitLevel: classification.fitLevel,
    classificationReason: classification.reason, classifierVersion: 'rules-v2',
    rawText: normalizedRaw, contentHash: hashContent(normalizedRaw || [title, description, reference].join('|')),
    externalId: externalId || reference || title,
  };
}

function extractMarkdownLinks(content: string) {
  const links: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  const markdown = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
  for (const match of content.matchAll(markdown)) {
    const title = text(match[1]); const url = text(match[2]);
    if (!title || !url || seen.has(url)) continue;
    seen.add(url); links.push({ title, url });
  }
  return links;
}

async function fetchJson(url: string, init: RequestInit = {}) {
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, headers: { Accept: 'application/json', ...(init.headers || {}) } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function scrapePage(url: string) {
  const scraped = await ai.scrape({ url });
  return text(scraped.text).slice(0, 50000);
}

async function extractTender(content: string, source: typeof OPPORTUNITY_SOURCES[number], fallbackUrl = '') {
  const extracted = await ai.extract({
    content,
    prompt: 'Extract one procurement/tender notice from this source. Preserve facts exactly as published and do not invent missing values. Capture title, organisation, reference number, publication date, submission deadline, notice type, description, scope, requirements, procurement method, source URL and document links. A technology opportunity may have a title without ICT or IT. Return empty strings for unavailable values.',
    schema: {
      type: 'object', properties: {
        title: { type: 'string' }, organisation: { type: 'string' }, reference: { type: 'string' },
        publishedAt: { type: 'string' }, deadline: { type: 'string' }, noticeType: { type: 'string' },
        description: { type: 'string' }, scope: { type: 'string' }, requirements: { type: 'string' },
        procurementMethod: { type: 'string' }, url: { type: 'string' },
        documents: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title', 'url'] } },
      }, required: ['title','organisation','reference','publishedAt','deadline','noticeType','description','scope','requirements','procurementMethod','url','documents'],
    },
    maxTokens: 5000, thinkingMode: 'FAST',
  });
  const data = (extracted.data || {}) as Record<string, unknown>;
  return { candidate: data, source, fallbackUrl, publishedAt: text(data.publishedAt), documents: Array.isArray(data.documents) ? data.documents : [] };
}

async function scanCareersMalawi(): Promise<OpportunitySourceResult> {
  const source = OPPORTUNITY_SOURCES.find(item => item.id === 'careersmw')!;
  try {
    const indexContent = await scrapePage(source.url);
    if (indexContent.length < 120) return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'error', accessMethod: 'public-page', notices: [], message: 'Careers Malawi did not expose enough listing content for discovery.' };

    const extractedIndex = await ai.extract({
      content: indexContent,
      prompt: 'Extract every individual tender/article link visible in the Careers Malawi tender listing. Do not filter to ICT. Do not invent URLs. Keep titles as published.',
      schema: {
        type: 'object', properties: { notices: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } }, required: ['title','url'] } } },
        required: ['notices'],
      }, maxTokens: 7000, thinkingMode: 'FAST',
    });
    const extractedItems = Array.isArray((extractedIndex.data as { notices?: unknown[] } | undefined)?.notices)
      ? (extractedIndex.data as { notices: unknown[] }).notices : [];
    const fallbackLinks = extractMarkdownLinks(indexContent).filter(link => /careersmw\.com\/tenders-and-non-consultancy-services\//i.test(link.url));
    const candidates = new Map<string, { title: string; url: string }>();
    for (const item of extractedItems) {
      const record = item as Record<string, unknown>; const title = text(record.title); const url = text(record.url);
      if (title && /^https?:\/\//i.test(url) && /careersmw\.com/i.test(url)) candidates.set(url, { title, url });
    }
    for (const link of fallbackLinks) candidates.set(link.url, link);
    const links = Array.from(candidates.values()).slice(0, 50);
    const notices: Opportunity[] = []; let extractionFailures = 0;

    for (const link of links) {
      try {
        const detailContent = await scrapePage(link.url);
        if (detailContent.length < 100) continue;
        const detail = await extractTender(detailContent, source, link.url);
        const candidate = detail.candidate as Record<string, unknown>;
        if (!candidate.title) candidate.title = link.title;
        if (!candidate.url) candidate.url = link.url;
        const notice = normalizeCandidate(candidate, source.id, source.name, source.url, text(candidate.reference), detailContent);
        if (notice) notices.push(notice);
      } catch { extractionFailures += 1; }
    }
    const unique = new Map<string, Opportunity>();
    for (const item of notices) unique.set((item.reference + '|' + item.url + '|' + item.title).toLowerCase(), item);
    return {
      sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'ok', accessMethod: 'public-page',
      notices: Array.from(unique.values()).slice(0, 80),
      message: 'Discovered ' + links.length + ' Careers Malawi notices; ' + unique.size + ' matched the technology classifier' + (extractionFailures ? '; ' + extractionFailures + ' detail pages could not be extracted' : '') + '.',
    };
  } catch (error) {
    return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'error', accessMethod: 'public-page', notices: [], message: 'Careers Malawi scan failed: ' + (error instanceof Error ? error.message : 'unknown source error') };
  }
}

function extractOcdsCandidates(payload: unknown): Array<Record<string, unknown>> {
  const candidates: Array<Record<string, unknown>> = []; const seen = new Set<string>();
  const walk = (node: unknown, inheritedOcid = '') => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const item of node) walk(item, inheritedOcid); return; }
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
          id: tender.id, tenderId: tender.id, title: tender.title, description: tender.description,
          category: Array.isArray(tender.items) ? tender.items.map(item => typeof item === 'object' ? text((item as Record<string, unknown>).description) : '').join(' ') : '',
          procurementMethod: tender.procurementMethodDetails || tender.procurementMethod,
          noticeType: Array.isArray(release.tag) ? release.tag.join(', ') : '',
          deadline: typeof tender.tenderPeriod === 'object' && tender.tenderPeriod ? (tender.tenderPeriod as Record<string, unknown>).end : '',
          buyerName: buyer.name,
          url: firstString(tender.documents && Array.isArray(tender.documents) ? (tender.documents[0] as Record<string, unknown>)?.url : '', release.url),
          reference: tender.id || ocid, status: tender.status,
        });
      }
    }
    for (const [key, value] of Object.entries(obj)) { if (key === 'compiledRelease' || key === 'tender' || key === 'buyer') continue; walk(value, ocid); }
  };
  walk(payload); return candidates;
}

async function scanManeps(): Promise<OpportunitySourceResult> {
  const source = OPPORTUNITY_SOURCES.find(item => item.id === 'maneps')!; const apiBase = 'https://maneps.mw/rms/api/ocds';
  try {
    const index = await fetchJson(apiBase + '/get-records', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ skip: 0, take: 250 }) });
    const items = Array.isArray(index?.items) ? index.items : [];
    const details = await Promise.all(items.slice(0, 120).map(async item => {
      const ocid = text(item?.ocid); if (!ocid) return null;
      try { return await fetchJson(apiBase + '/record-package/' + encodeURIComponent(ocid)); }
      catch { try { return await fetchJson(apiBase + '/release-package/' + encodeURIComponent(ocid)); } catch { return null; } }
    }));
    const notices = details.flatMap(payload => extractOcdsCandidates(payload).map(candidate => normalizeCandidate(candidate, source.id, source.name, source.url, text(candidate.reference))).filter((item): item is Opportunity => Boolean(item)));
    const unique = new Map<string, Opportunity>(); for (const item of notices) unique.set((item.reference + '|' + item.url + '|' + item.title).toLowerCase(), item);
    return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'ok', accessMethod: 'public-ocds-api', notices: Array.from(unique.values()).slice(0, 80), message: 'MANEPS OCDS API returned ' + items.length + ' records; ' + unique.size + ' matched the technology opportunity classifier.' };
  } catch {
    return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'error', accessMethod: 'public-ocds-api', notices: [], message: 'The MANEPS OCDS API could not be reached. BidWatch did not use a MANEPS login or browser session.' };
  }
}

async function scanPublicPage(source: typeof OPPORTUNITY_SOURCES[number]): Promise<OpportunitySourceResult> {
  try {
    const content = await scrapePage(source.url);
    if (content.length < 120) return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'error', accessMethod: 'public-page', notices: [], message: 'The public page did not expose enough procurement content for extraction.' };
    const extracted = await ai.extract({
      content,
      prompt: 'Extract current technology-related procurement opportunities from this source, including software, data, networking, infrastructure, telecommunications, cybersecurity, ICT support and technology consultancy. Do not invent missing values and exclude clearly unrelated opportunities.',
      schema: {
        type: 'object', properties: { notices: { type: 'array', items: { type: 'object', properties: {
          title: { type: 'string' }, organisation: { type: 'string' }, reference: { type: 'string' }, deadline: { type: 'string' },
          description: { type: 'string' }, scope: { type: 'string' }, requirements: { type: 'string' }, noticeType: { type: 'string' }, url: { type: 'string' },
        }, required: ['title'] } } }, required: ['notices'],
      }, maxTokens: 7000, thinkingMode: 'FAST',
    });
    const raw = Array.isArray((extracted.data as { notices?: unknown[] } | undefined)?.notices) ? (extracted.data as { notices: unknown[] }).notices : [];
    const notices = raw.map(item => normalizeCandidate(item as Record<string, unknown>, source.id, source.name, source.url)).filter((item): item is Opportunity => Boolean(item));
    const unique = new Map<string, Opportunity>(); for (const item of notices) unique.set((item.reference + '|' + item.url + '|' + item.title).toLowerCase(), item);
    return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'ok', accessMethod: 'public-page', notices: Array.from(unique.values()).slice(0, 80), message: 'Found ' + unique.size + ' relevant opportunities in the accessible public page.' };
  } catch (error) {
    return { sourceId: source.id, source: source.name, sourceUrl: source.url, status: 'error', accessMethod: 'public-page', notices: [], message: 'The public source could not be scanned: ' + (error instanceof Error ? error.message : 'unknown error') };
  }
}

export async function discoverPlatformOpportunities() {
  const results: OpportunitySourceResult[] = [];
  results.push(await scanCareersMalawi());
  results.push(await scanManeps());
  for (const source of OPPORTUNITY_SOURCES.filter(item => item.id !== 'maneps' && item.id !== 'careersmw')) results.push(await scanPublicPage(source));
  return results;
}

function updateKey(item: Opportunity) {
  const reference = text(item.reference).toLowerCase();
  if (reference) return item.sourceId + '|ref|' + reference;
  const canonicalUrl = text(item.url).toLowerCase().replace(/#.*$/, '').replace(/\/$/, '');
  if (canonicalUrl) return item.sourceId + '|url|' + canonicalUrl;
  return item.sourceId + '|content|' + (item.contentHash || hashContent([item.title, item.organisation, item.deadline].join('|')));
}

export async function persistOpportunityUpdates(results: OpportunitySourceResult[]) {
  const existing = await db.list<OpportunityUpdate>('opportunity_updates', { limit: 2000 });
  const byKey = new Map(existing.items.map(item => [updateKey(item), item]));
  const timestamp = new Date().toISOString();
  for (const result of results) for (const opportunity of result.notices) {
    const key = updateKey(opportunity); const current = byKey.get(key);
    if (current) {
      await db.update('opportunity_updates', [{ id: current.id, record: { ...current, ...opportunity, firstSeenAt: current.firstSeenAt || timestamp, lastSeenAt: timestamp } }]);
    } else {
      const [id] = await db.add('opportunity_updates', [{ ...opportunity, state: 'new', firstSeenAt: timestamp, lastSeenAt: timestamp }]);
      if (id) byKey.set(key, { ...opportunity, id, state: 'new', firstSeenAt: timestamp, lastSeenAt: timestamp });
    }
  }
  return timestamp;
}

export async function listOpportunityUpdates(limit = 30) {
  const result = await db.list<OpportunityUpdate>('opportunity_updates', { limit: 2000 });
  const current = result.items.filter(item => {
    if (item.state === 'dismissed') return false;
    if (!item.deadline) return true;
    const time = new Date(item.deadline).getTime();
    return Number.isFinite(time) && time >= Date.now();
  });
  const byReference = new Map<string, Set<string>>();
  for (const item of current) {
    const reference = text(item.reference).toLowerCase(); if (!reference) continue;
    const sources = byReference.get(reference) || new Set<string>(); sources.add(item.source); byReference.set(reference, sources);
  }
  return current.sort((a, b) => (b.relevanceScore || 0) - (a.relevanceScore || 0) || new Date(b.lastSeenAt || b.firstSeenAt).getTime() - new Date(a.lastSeenAt || a.firstSeenAt).getTime())
    .slice(0, limit)
    .map(item => {
      const reference = text(item.reference).toLowerCase();
      const sources = reference ? Array.from(byReference.get(reference) || []).filter(source => source !== item.source) : [];
      return { ...item, alsoListedOn: sources };
    });
}
