import { db } from './runtime';

type OpportunityDetails = {
  publishedAt?: string;
  procurementMethod?: string;
  eligibility?: string;
  submissionMethod?: string;
  documents?: Array<{ title: string; url: string }>;
  contact?: { name?: string; email?: string; phone?: string };
  verification?: 'structured-api' | 'source-page' | 'source-document' | 'not-verified';
  verifiedAt?: string;
};

type OpportunityUpdate = {
  id: string;
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
  matchedTerms?: string[];
  state: 'new' | 'imported' | 'dismissed';
  firstSeenAt: string;
  lastSeenAt: string;
  importedTenderId?: string;
  details?: OpportunityDetails;
};

const ALLOWED_SOURCE_HOSTS = ['pppc.mw', 'ppda.mw', 'maneps.mw'];
function allowedSourceUrl(value: string) { try { const url = new URL(value); if (url.protocol !== 'https:' || url.port) return false; const host = url.hostname.toLowerCase(); return ALLOWED_SOURCE_HOSTS.some(domain => host === domain || host.endsWith(`.${domain}`)); } catch { return false; } }
const TERMS = ['cybersecurity', 'cyber security', 'information security', 'penetration testing', 'penetration test', 'vulnerability assessment', 'security assessment', 'security audit', 'soc', 'siem', 'endpoint security', 'edr', 'xdr', 'firewall', 'network security', 'identity and access management', 'iam', 'zero trust', 'privileged access', 'mfa', 'multi-factor authentication', 'data protection', 'privacy', 'digital forensics', 'incident response', 'iso 27001', 'pci dss', 'dlp', 'managed detection', 'managed security', 'cloud security', 'ict', 'information technology', 'information systems', 'software', 'network', 'server', 'cloud', 'data analytics', 'database', 'application development', 'it support', 'helpdesk', 'telecommunications', 'consultancy', 'rfp', 'rfq', 'tender'];
function text(value: unknown) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function terms_UNUSED(value: string) { const haystack = value.toLowerCase(); return TERMS.filter(term => haystack.includes(term)).slice(0, 16); }

async function fetchSource(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/html,application/xhtml+xml' } });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return { html: await response.text(), contentType: response.headers.get('content-type') || '' };
  } finally {
    clearTimeout(timer);
  }
}

function cleanHtml(value: string) {
  return value.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'").replace(/\s+/g, ' ').trim();
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

function findExplicitDeadline(textValue: string) {
  const context = textValue.match(/(?:closing date|closing|submission deadline|submission date|deadline|due date|bid closing|tender closing|closing time)[^.;]{0,180}/i)?.[0] || '';
  return extractDate(context);
}

export async function verifyOpportunity(id: string) {
  const [current] = await db.get<OpportunityUpdate>('opportunity_updates', [id]);
  if (!current) return null;
  if (current.sourceId === 'maneps' && current.details?.verification === 'structured-api' && current.deadline) return { ...current, id };

  const targetUrl = current.url || current.sourceUrl;
  if (!targetUrl || !allowedSourceUrl(targetUrl)) {
    return { ...current, id, details: { ...current.details, verification: 'not-verified' as const } };
  }

  try {
    const source = await fetchSource(targetUrl);
    if (source.contentType.toLowerCase().includes('pdf')) {
      return { ...current, id, details: { ...current.details, verification: 'not-verified' as const, verifiedAt: new Date().toISOString() } };
    }

    const textContent = cleanHtml(source.html).slice(0, 120000);
    if (textContent.length < 80) throw new Error('Source content unavailable');

    const deadline = findExplicitDeadline(textContent);
    const documents = Array.from(source.html.matchAll(/href\s*=\s*["']([^"']+)["']/gi))
      .map(match => match[1])
      .filter(url => /pdf|docx?|xlsx?|pptx?|download|attachment/i.test(url))
      .slice(0, 20)
      .map(url => ({ title: url.split('/').pop() || 'Source document', url }));

    const next: OpportunityUpdate = {
      ...current,
      id,
      deadline: deadline || current.deadline,
      details: {
        ...current.details,
        documents: documents.length ? documents : current.details?.documents,
        verification: deadline ? 'source-page' : 'not-verified',
        verifiedAt: new Date().toISOString(),
      },
      lastSeenAt: new Date().toISOString(),
    };

    if (!deadline && !current.deadline) {
      return next;
    }

    const { id: _id, ...record } = next;
    await db.update('opportunity_updates', [{ id, record }]);
    return next;
  } catch {
    return { ...current, id, details: { ...current.details, verification: 'not-verified' as const } };
  }
}

