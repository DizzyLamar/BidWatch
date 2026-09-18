import { ai, db } from '@appdeploy/sdk';

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

const TERMS = ['cybersecurity', 'cyber security', 'information security', 'penetration testing', 'penetration test', 'vulnerability assessment', 'security assessment', 'security audit', 'soc', 'siem', 'endpoint security', 'edr', 'xdr', 'firewall', 'network security', 'identity and access management', 'iam', 'zero trust', 'privileged access', 'mfa', 'multi-factor authentication', 'data protection', 'privacy', 'digital forensics', 'incident response', 'iso 27001', 'pci dss', 'dlp', 'managed detection', 'managed security', 'cloud security', 'ict', 'information technology', 'information systems', 'software', 'network', 'server', 'cloud', 'data analytics', 'database', 'application development', 'it support', 'helpdesk', 'telecommunications', 'consultancy', 'rfp', 'rfq', 'tender'];
function text(value: unknown) { return String(value ?? '').replace(/\s+/g, ' ').trim(); }
function dateString(value: unknown) { const valueText = text(value); if (!valueText) return ''; const time = new Date(valueText).getTime(); return Number.isFinite(time) ? new Date(time).toISOString() : ''; }
function terms(value: string) { const haystack = value.toLowerCase(); return TERMS.filter(term => haystack.includes(term)).slice(0, 16); }

export async function verifyOpportunity(id: string) {
  const [current] = await db.get<OpportunityUpdate>('opportunity_updates', [id]);
  if (!current) return null;
  if (current.sourceId === 'maneps' && current.details?.verification === 'structured-api' && current.deadline) return { ...current, id };
  const targetUrl = current.url || current.sourceUrl;
  if (!targetUrl) return { ...current, id, details: { ...current.details, verification: 'not-verified' as const } };
  try {
    const scraped = await ai.scrape({ url: targetUrl });
    if (scraped.status >= 400 || scraped.text.length < 80) throw new Error('Source content unavailable');
    const result = await ai.extract({
      content: scraped.text.slice(0, 90000),
      prompt: `Verify this exact procurement opportunity from the supplied source. Title: ${current.title || ''}. Reference: ${current.reference || ''}. Recover only information explicitly present in the source. Most importantly, recover the official closing/submission deadline, including dates shown in procurement tables or notices. Also recover the publication date, procurement method, eligibility, submission method, contact details, document links, organisation, notice type and a useful description. Do not infer or guess values.`,
      schema: {
        type: 'object',
        properties: {
          title: { type: 'string' }, organisation: { type: 'string' }, reference: { type: 'string' }, deadline: { type: 'string' },
          description: { type: 'string' }, noticeType: { type: 'string' }, publishedAt: { type: 'string' }, procurementMethod: { type: 'string' },
          eligibility: { type: 'string' }, submissionMethod: { type: 'string' },
          documents: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, url: { type: 'string' } } } },
          contact: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, phone: { type: 'string' } } }
        }
      },
      maxTokens: 3500,
      thinkingMode: 'FAST'
    });
    const data = result.data as Record<string, unknown>;
    const documents = Array.isArray(data.documents) ? data.documents as Array<{ title: string; url: string }> : current.details?.documents;
    const next: OpportunityUpdate = {
      ...current,
      id,
      title: text(data.title) || current.title,
      organisation: text(data.organisation) || current.organisation,
      reference: text(data.reference) || current.reference,
      deadline: dateString(data.deadline) || current.deadline,
      description: text(data.description) || current.description,
      noticeType: text(data.noticeType) || current.noticeType,
      matchedTerms: terms([data.title, data.description, data.organisation].map(text).join(' ')),
      details: {
        ...current.details,
        publishedAt: dateString(data.publishedAt) || current.details?.publishedAt,
        procurementMethod: text(data.procurementMethod) || current.details?.procurementMethod,
        eligibility: text(data.eligibility) || current.details?.eligibility,
        submissionMethod: text(data.submissionMethod) || current.details?.submissionMethod,
        documents,
        contact: data.contact && typeof data.contact === 'object' ? data.contact as OpportunityDetails['contact'] : current.details?.contact,
        verification: current.url && current.url !== current.sourceUrl ? 'source-document' : 'source-page',
        verifiedAt: new Date().toISOString()
      },
      lastSeenAt: new Date().toISOString()
    };
    const { id: _id, ...record } = next;
    await db.update('opportunity_updates', [{ id, record }]);
    return next;
  } catch {
    return { ...current, id, details: { ...current.details, verification: 'not-verified' as const } };
  }
}
