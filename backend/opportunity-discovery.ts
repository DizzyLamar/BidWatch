import { db } from '@appdeploy/sdk';

export const OPPORTUNITY_SOURCES = [
  { id: 'maneps', name: 'MANePS procurement notices', url: 'https://maneps.mw/procurement-notice', kind: 'api' as const },
  { id: 'ppda', name: 'PPDA procurement notices', url: 'https://ppda.mw/tenders', kind: 'public' as const },
  { id: 'malawi-gov', name: 'Malawi Government tenders', url: 'https://www.malawi.gov.mw/index.php/resources/publications/tenders', kind: 'public' as const },
  { id: 'careersmw', name: 'Careers Malawi tenders & bids', url: 'https://careersmw.com/tenders-and-non-consultancy-services/', kind: 'public' as const },
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
  Cybersecurity: ['cybersecurity','cyber security','information security','penetration testing','penetration test','vulnerability assessment','security assessment','security audit','soc','siem','endpoint security','edr','xdr','firewall','network security','identity and access management','iam','zero trust','privileged access','mfa','multi-factor authentication','data protection','privacy','digital forensics','incident response','iso 27001','pci dss','dlp','managed detection','managed security','cloud security','access control','biometric','cctv','surveillance','smart gate','truck parking','parking management','stock management system','real time stock management','fleet management','vehicle tracking','pos system','point of sale','electronic records','document management','digital registration','telemetry','iot','radio communication','pabx','public address system','generator monitoring','ups battery'],
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
  details?: { publishedAt?: string; procurementMethod?: string; documents?: Array<{ title: string; url: string }> };
  relevanceScore?: number; relevanceLevel?: RelevanceLevel; fitLevel?: FitLevel;
  classificationReason?: string; classifierVersion?: string; rawText?: string; contentHash?: string; externalId?: string;
};

export type OpportunitySourceResult = {
  sourceId: string; source: string; sourceUrl: string;
  status: 'ok' | 'authentication_required' | 'error';
  accessMethod: 'public-page' | 'public-ocds-api';
  notices: Opportunity[];
  fetchedCount: number;
  parsedCount: number;
  relevantCount: number;
  failedCount: number;
  durationMs: number;
  checkedAt: string;
  message: string;
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

function decodeHtml(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|li|td|th|tr|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#8217;/gi, "'")
    .replace(/&#8211;/gi, '-')
    .replace(/&#8212;/gi, '—')
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteUrl(value: string, base: string) {
  try { return new URL(value, base).toString(); } catch { return ''; }
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
    if (!match) continue;
    const parsed = new Date(match[0]).getTime();
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return '';
}

function extractDeadline(value: string) {
  const context = value.match(/(?:deadline|closing\s+(?:date|time)?|submission\s+(?:deadline|date|time)|bid\s+closing|tender\s+closing|proposal\s+due|due\s+date)[^.;]{0,220}/i)?.[0] || value;
  return extractDate(context);
}

function extractReference(value: string) {
  const match = value.match(/(?:procurement\s+reference(?:\s+number)?|reference\s*(?:number|no\.?)|procurement\s+number|tender\s*(?:no\.?|number))\s*[:#-]?\s*([A-Z0-9][A-Z0-9/_ .-]{3,100})/i);
  return match ? match[1].replace(/\s+/g, ' ').trim().replace(/[.,;:]+$/, '') : '';
}

function extractOrganisation(value: string) {
  const patterns = [
    /(?:employer|procuring\s+entity|contracting\s+authority|procurement\s+entity|purchasing\s+entity|procuring\s+agency)\s*[:\-]\s*([^.;\n]{3,180})/i,
    /(?:the\s+)?(?:Malawi\s+Revenue\s+Authority|National\s+Food\s+Reserve\s+Agency|University\s+of\s+Malawi|SADC\s+Secretariat|Ministry\s+of\s+[A-Z][A-Za-z &'’-]{2,100}|Roads\s+Authority|Electricity\s+Supply\s+Corporation\s+of\s+Malawi(?:\s+Limited)?)/i,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return text(match[1] || match[0]);
  }
  return '';
}

function extractRows(html: string) {
  const rows: Array<{ cells: string[]; links: string[] }> = [];
  for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
    const cells = (row.match(/<(?:td|th)[^>]*>[\s\S]*?<\/(?:td|th)>/gi) || []).map(decodeHtml).filter(Boolean);
    if (cells.length < 2) continue;
    const links = Array.from(row.matchAll(/href\s*=\s*["']([^"']+)["']/gi)).map(match => match[1]);
    rows.push({ cells, links });
  }
  return rows;
}

function linkCandidates(html: string, baseUrl: string) {
  const candidates: Array<{ title: string; url: string }> = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absoluteUrl(match[1], baseUrl);
    const title = decodeHtml(match[2]);
    if (!url || !title || title.length < 12 || title.length > 320 || seen.has(url)) continue;
    if (/^(home|login|contact|about|read more|details|download|subscribe|next|previous)$/i.test(title)) continue;
    seen.add(url);
    candidates.push({ title, url });
  }
  return candidates;
}

function publicCandidates(html: string, source: typeof OPPORTUNITY_SOURCES[number]) {
  const candidates: Array<Record<string, unknown>> = [];
  for (const row of extractRows(html)) {
    const joined = row.cells.join(' ');
    const headerOnly = row.cells.every(cell => /^(title|institution|reference(?: no\.?)?|publish(?:ed)? date|closing date|attachment)$/i.test(cell));
    if (headerOnly) continue;
    candidates.push({
      title: row.cells[0],
      organisation: row.cells[1],
      reference: row.cells[2],
      publishedAt: extractDate(row.cells[3] || ''),
      deadline: extractDeadline(joined),
      description: row.cells.slice(0, 6).join(' — '),
      noticeType: 'Procurement notice',
      url: absoluteUrl(row.links[0] || '', source.url) || source.url,
    });
  }
  if (candidates.length) return candidates;
  return linkCandidates(html, source.url).map(link => ({
    title: link.title,
    organisation: '',
    reference: extractReference(link.title),
    publishedAt: extractDate(link.title),
    deadline: extractDeadline(link.title),
    description: link.title,
    noticeType: 'Procurement notice',
    url: link.url,
  }));
}

function sourceResult(source: typeof OPPORTUNITY_SOURCES[number], started: number, rawCount: number, parsedCount: number, notices: Opportunity[], failedCount: number, message: string, status: 'ok' | 'error' = 'ok', accessMethod: 'public-page' | 'public-ocds-api' = 'public-page'): OpportunitySourceResult {
  return {
    sourceId: source.id, source: source.name, sourceUrl: source.url, status, accessMethod, notices,
    fetchedCount: rawCount, parsedCount, relevantCount: notices.length, failedCount,
    durationMs: Date.now() - started, checkedAt: new Date().toISOString(), message,
  };
}

async function scanCareersMalawi(): Promise<OpportunitySourceResult> {
  const source = OPPORTUNITY_SOURCES.find(item => item.id === 'careersmw')!;
  const started = Date.now();
  try {
    const html = await fetchText(source.url);
    const links = linkCandidates(html, source.url)
      .filter(link => link.url.startsWith('https://careersmw.com/'))
      .filter(link => !/\/page\/\d+\/?$|\/category\/|\/tag\//i.test(link.url))
      .slice(0, 80);
    let failed = 0;
    const notices: Opportunity[] = [];
    for (const link of links) {
      try {
        const detailHtml = await fetchText(link.url);
        const articleText = decodeHtml(detailHtml);
        const title = (detailHtml.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] || detailHtml.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || link.title);
        const candidate = {
          title: decodeHtml(title),
          organisation: extractOrganisation(articleText),
          reference: extractReference(articleText),
          deadline: extractDeadline(articleText),
          publishedAt: extractDate(articleText.match(/(?:publication|published|date of publication|date issued|issue date)[^.;]{0,100}/i)?.[0] || ''),
          description: articleText.slice(0, 12000),
          noticeType: /request for (?:proposal|quotation|expression)|consultancy/i.test(articleText) ? 'Tender / consultancy' : 'Tender / bid',
          url: link.url,
        };
        const notice = normalizeCandidate(candidate, source.id, source.name, source.url, text(candidate.reference), articleText);
        if (notice) {
          notice.details = { publishedAt: dateString(candidate.publishedAt), procurementMethod: /national competitive bidding|ncb/i.test(articleText) ? 'National Competitive Bidding' : '' };
          notices.push(notice);
        }
      } catch { failed += 1; }
    }
    const unique = new Map<string, Opportunity>();
    for (const item of notices) unique.set((item.reference + '|' + item.url + '|' + item.title).toLowerCase(), item);
    return sourceResult(source, started, links.length, links.length - failed, Array.from(unique.values()).slice(0, 80), failed, 'Parsed ' + links.length + ' Careers Malawi detail pages deterministically; ' + unique.size + ' matched the technology classifier.');
  } catch (error) {
    return sourceResult(source, started, 0, 0, [], 1, 'Careers Malawi could not be scanned: ' + (error instanceof Error ? error.message : 'unknown source error'), 'error');
  }
}

async function scanPublicPage(source: typeof OPPORTUNITY_SOURCES[number]): Promise<OpportunitySourceResult> {
  const started = Date.now();
  try {
    const html = await fetchText(source.url);
    if (html.length < 120) return sourceResult(source, started, 0, 0, [], 1, 'The public page did not expose enough procurement content for extraction.', 'error');
    const raw = publicCandidates(html, source);
    const notices = raw.map(item => normalizeCandidate(item, source.id, source.name, source.url, text(item.reference), text(item.description))).filter((item): item is Opportunity => Boolean(item));
    const unique = new Map<string, Opportunity>();
    for (const item of notices) unique.set((item.reference + '|' + item.url + '|' + item.title).toLowerCase(), item);
    return sourceResult(source, started, raw.length, raw.length, Array.from(unique.values()).slice(0, 100), 0, 'Parsed ' + raw.length + ' public procurement records; ' + unique.size + ' matched the technology classifier.');
  } catch (error) {
    return sourceResult(source, started, 0, 0, [], 1, 'The public source could not be scanned: ' + (error instanceof Error ? error.message : 'unknown source error'), 'error');
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
  const source = OPPORTUNITY_SOURCES.find(item => item.id === 'maneps')!;
  const started = Date.now();
  const apiBase = 'https://maneps.mw/rms/api/ocds';
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
    return sourceResult(source, started, items.length, items.length, Array.from(unique.values()).slice(0, 100), 0, 'MANePS OCDS API returned ' + items.length + ' records; ' + unique.size + ' matched the technology classifier.', 'ok', 'public-ocds-api');
  } catch {
    return sourceResult(source, started, 0, 0, [], 1, 'MANePS public OCDS endpoint could not be reached. BidWatch did not use a supplier login or browser session.', 'error', 'public-ocds-api');
  }
}

export async function discoverPlatformOpportunities() {
  const results: OpportunitySourceResult[] = [];
  for (const source of OPPORTUNITY_SOURCES) {
    if (source.id === 'maneps') results.push(await scanManeps());
    else if (source.id === 'careersmw') results.push(await scanCareersMalawi());
    else results.push(await scanPublicPage(source));
  }
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
  const current = result.items.filter(item => item.state !== 'dismissed');
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
