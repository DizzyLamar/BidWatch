import { db, router, json, error, requireAuth, type RouterContext } from './runtime';
import { storageService } from './storage';
import { discoverPlatformOpportunities, listOpportunityUpdates, persistOpportunityUpdates, OPPORTUNITY_SOURCES as DISCOVERY_SOURCES } from './opportunity-discovery';
import { verifyOpportunity } from './opportunity-verification';

const SUPER_ADMIN_EMAIL = 'ddzinja@gmail.com';
const now = () => new Date().toISOString();

type Permission =
  | 'bids.view' | 'bids.create' | 'bids.edit' | 'bids.assign' | 'bids.apply' | 'bids.decline' | 'bids.delete'
  | 'attachments.upload' | 'attachments.delete' | 'notifications.view'
  | 'users.view' | 'users.manage' | 'roles.view' | 'roles.manage' | 'categories.manage' | 'settings.manage'
  | 'audit.view'
  | 'kpis.view.overview' | 'kpis.view.pipeline' | 'kpis.view.deadlines' | 'kpis.view.submissions'
  | 'kpis.view.workload' | 'kpis.view.team' | 'kpis.view.access' | 'kpis.view.storage';

const PERMISSIONS: Array<{ key: Permission; label: string; group: string; description: string }> = [
  { key: 'bids.view', label: 'View bids', group: 'Bids', description: 'View opportunities and details.' },
  { key: 'bids.create', label: 'Create bids', group: 'Bids', description: 'Add opportunities.' },
  { key: 'bids.edit', label: 'Edit bids', group: 'Bids', description: 'Edit ordinary bid data and workflow stages.' },
  { key: 'bids.assign', label: 'Assign bids', group: 'Bids', description: 'Assign ownership.' },
  { key: 'bids.apply', label: 'Mark Applied', group: 'Bids', description: 'Record final submission.' },
  { key: 'bids.decline', label: 'Mark Declined', group: 'Bids', description: 'Close an opportunity as declined.' },
  { key: 'bids.delete', label: 'Delete bids', group: 'Bids', description: 'Permanently remove a bid.' },
  { key: 'attachments.upload', label: 'Upload documents', group: 'Documents', description: 'Attach bid source files.' },
  { key: 'attachments.delete', label: 'Delete documents', group: 'Documents', description: 'Remove attachments.' },
  { key: 'notifications.view', label: 'View notifications', group: 'Workspace', description: 'View deadline reminders.' },
  { key: 'users.view', label: 'View users', group: 'Access control', description: 'See provisioned identities.' },
  { key: 'users.manage', label: 'Manage users', group: 'Access control', description: 'Provision users, assign roles and suspend access.' },
  { key: 'roles.view', label: 'View roles', group: 'Access control', description: 'See role definitions.' },
  { key: 'roles.manage', label: 'Manage roles', group: 'Access control', description: 'Create roles and allocate permissions.' },
  { key: 'categories.manage', label: 'Manage bid categories', group: 'Configuration', description: 'Create and retire categories.' },
  { key: 'settings.manage', label: 'Manage settings', group: 'Configuration', description: 'Manage application configuration and storage.' },
  { key: 'audit.view', label: 'View security audit', group: 'Security', description: 'View access-control and security events.' },
  { key: 'kpis.view.overview', label: 'View KPI overview', group: 'KPIs', description: 'See the general bid portfolio picture.' },
  { key: 'kpis.view.pipeline', label: 'View pipeline KPIs', group: 'KPIs', description: 'See workflow-stage and pipeline metrics.' },
  { key: 'kpis.view.deadlines', label: 'View deadline KPIs', group: 'KPIs', description: 'See deadline risk and timeliness metrics.' },
  { key: 'kpis.view.submissions', label: 'View submission KPIs', group: 'KPIs', description: 'See Applied, Declined and submission-rate metrics.' },
  { key: 'kpis.view.workload', label: 'View workload KPIs', group: 'KPIs', description: 'See personal workload and unassigned work.' },
  { key: 'kpis.view.team', label: 'View team KPIs', group: 'KPIs', description: 'See team workload and assignment metrics.' },
  { key: 'kpis.view.access', label: 'View access KPIs', group: 'KPIs', description: 'See identity, role and suspension posture.' },
  { key: 'kpis.view.storage', label: 'View storage KPIs', group: 'KPIs', description: 'See attachment and storage health metrics.' },
];
const DEFAULT_CATEGORIES = ['Cybersecurity', 'Software Development', 'ICT Infrastructure', 'IT Support', 'Data & Analytics', 'Consulting', 'Other'];
const STATUSES = ['New', 'Reviewing', 'Pursuing', 'Preparing', 'Ready to Submit', 'Applied', 'Declined'];
const SENSITIVE_PERMISSIONS: Permission[] = ['users.manage', 'roles.manage', 'settings.manage', 'audit.view', 'kpis.view.access', 'kpis.view.storage'];
const SAFE_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'ppt', 'pptx', 'png', 'jpg', 'jpeg', 'txt', 'zip']);
const MIME_BY_EXTENSION: Record<string, string[]> = {
  pdf: ['application/pdf'],
  doc: ['application/msword'],
  docx: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  xls: ['application/vnd.ms-excel'],
  xlsx: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  csv: ['text/csv', 'application/csv', 'application/vnd.ms-excel'],
  ppt: ['application/vnd.ms-powerpoint'],
  pptx: ['application/vnd.openxmlformats-officedocument.presentationml.presentation'],
  png: ['image/png'],
  jpg: ['image/jpeg'],
  jpeg: ['image/jpeg'],
  txt: ['text/plain'],
  zip: ['application/zip', 'application/x-zip-compressed']
};
const REQUEST_LIMITS = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMITS = { upload: 20, scan: 2 };

function rateLimit(key: string, limit: number) {
  const nowMs = Date.now();
  const current = REQUEST_LIMITS.get(key);
  if (!current || current.resetAt <= nowMs) {
    REQUEST_LIMITS.set(key, { count: 1, resetAt: nowMs + RATE_WINDOW_MS });
    return true;
  }
  if (current.count >= limit) return false;
  current.count += 1;
  return true;
}

function decodeBase64(content: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) return null;
  try {
    const decoded = Buffer.from(content, 'base64');
    return new Uint8Array(decoded);
  } catch {
    return null;
  }
}

function hasSignature(bytes: Uint8Array, ext: string) {
  if (['txt', 'csv'].includes(ext)) return true;
  if (ext === 'pdf') return bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46;
  if (['png'].includes(ext)) return bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (['jpg', 'jpeg'].includes(ext)) return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (['doc', 'xls', 'ppt'].includes(ext)) return bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0 && bytes[4] === 0xa1 && bytes[5] === 0xb1 && bytes[6] === 0x1a && bytes[7] === 0xe1;
  if (['docx', 'xlsx', 'pptx', 'zip'].includes(ext)) return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
  return false;
}

function validateUpload(filename: string, mimeType: string, claimedSize: number, content: string) {
  const ext = filename.toLowerCase().split('.').pop() || '';
  if (!filename || !content) return 'File data is required.';
  if (filename.length > 255 || !SAFE_EXTENSIONS.has(ext)) return 'This file type is not permitted.';
  if (!Number.isFinite(claimedSize) || claimedSize <= 0 || claimedSize > 10 * 1024 * 1024) return 'Files must be between 1 byte and 10 MB in the current upload path.';
  if (content.length > 14 * 1024 * 1024) return 'Encoded file payload is too large.';
  const allowedMimes = MIME_BY_EXTENSION[ext] || [];
  if (allowedMimes.length && !allowedMimes.includes(mimeType)) return 'The declared file type does not match the selected file extension.';
  const bytes = decodeBase64(content);
  if (!bytes) return 'The uploaded file is not valid base64 data.';
  if (bytes.byteLength !== claimedSize) return 'The uploaded file size does not match its declared size.';
  if (!hasSignature(bytes, ext)) return 'The uploaded file signature does not match its extension.';
  return null;
}
const MAX_TEXT: Record<string, number> = { title: 180, organisation: 180, reference: 120, description: 8000, source: 180, category: 80, notes: 8000, submissionReference: 180, url: 500, deadline: 40 };

interface Role { id: string; name: string; description: string; permissions: Permission[]; system: boolean; createdAt: string; updatedAt: string }
interface User { id: string; userId?: string; email: string; name: string; roleId: string; active: boolean; status: 'Provisioned' | 'Active' | 'Suspended'; createdAt: string; updatedAt: string; lastSeenAt?: string; onboardingCompleted?: boolean }
interface Tender { id: string; title: string; organisation: string; reference: string; description: string; deadline: string; source: string; url: string; category: string; status: string; assigneeId: string; submittedBy: string; submittedAt: string; notes: string; revision?: number; submissionReference?: string; appliedBy?: string; appliedAt?: string }
interface BidHistory { id: string; originalTenderId: string; title: string; organisation: string; reference: string; description: string; deadline: string; source: string; url: string; category: string; status: string; assigneeId: string; submittedBy: string; submittedAt: string; notes: string; submissionReference?: string; appliedBy?: string; appliedAt?: string; deletedBy: string; deletedAt: string; attachmentCount: number }

const OPPORTUNITY_SOURCES_UNUSED = [
  { id: 'pppc', name: 'PPPC procurement adverts', url: 'https://www.pppc.mw/procurement/adverts', kind: 'public' },
  { id: 'ppda', name: 'PPDA procurement notices', url: 'https://ppda.mw/tenders', kind: 'public' },
  { id: 'maneps', name: 'MANEPS procurement notices', url: 'https://maneps.mw/procurement-notice', kind: 'portal' },
] as const;

const OPPORTUNITY_TERMS = [
  'ict', 'information technology', 'information systems', 'cybersecurity', 'cyber security', 'information security',
  'penetration testing', 'vulnerability assessment', 'security assessment', 'soc', 'siem', 'endpoint security',
  'firewall', 'network security', 'identity and access management', 'iam', 'zero trust', 'backup', 'disaster recovery',
  'cloud', 'data centre', 'data center', 'server', 'network', 'router', 'switch', 'wireless', 'internet', 'connectivity',
  'software', 'application development', 'web development', 'mobile application', 'database', 'erp', 'crm', 'api',
  'website', 'digital transformation', 'automation', 'data analytics', 'business intelligence', 'managed services',
  'it support', 'technical support', 'helpdesk', 'licence', 'license', 'software renewal', 'ict equipment', 'computer',
  'laptop', 'cctv', 'access control', 'telecommunications', 'consultancy', 'consulting', 'rfp', 'expression of interest',
  'request for quotation', 'request for proposals', 'tender'
];

function opportunityMatch_UNUSED(textValue: string) {
  const haystack = textValue.toLowerCase();
  return OPPORTUNITY_TERMS.filter(term => haystack.includes(term)).slice(0, 12);
}

async function listAll<T>(table: string, limit = 500) { const r = await db.list<T>(table, { limit }); return r.items; }
async function getById<T>(table: string, id: string) { const [r] = await db.get<T>(table, [id]); return r ? { ...(r as T), id } : null; }
function text(value: unknown, field: string, fallback = '') { const s = String(value ?? fallback).trim(); return s.slice(0, MAX_TEXT[field] ?? 500); }
function validEmail(email: string) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254; }
function validUrl(value: string) { if (!value) return true; try { const u = new URL(value); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
function validDeadline(value: string) { const d = new Date(value).getTime(); return Number.isFinite(d); }
function roleHasSensitive(role: Role | null) { return Boolean(role?.permissions.some(p => SENSITIVE_PERMISSIONS.includes(p))); }

async function seed() {
  let roles = await listAll<Role>('roles');
  if (!roles.length) {
    const ids = await db.add('roles', [
      { name: 'Super Admin', description: 'Protected platform owner. Manages users, roles and system configuration.', permissions: PERMISSIONS.map(p => p.key), system: true, createdAt: now(), updatedAt: now() },
      { name: 'Member', description: 'Standard team access for reviewing and contributing bids.', permissions: ['bids.view', 'bids.create', 'attachments.upload', 'notifications.view', 'kpis.view.overview', 'kpis.view.deadlines', 'kpis.view.workload'], system: true, createdAt: now(), updatedAt: now() },
      { name: 'Bid Manager', description: 'Operational access for workflow, ownership and submission.', permissions: ['bids.view', 'bids.create', 'bids.edit', 'bids.assign', 'bids.apply', 'bids.decline', 'attachments.upload', 'attachments.delete', 'notifications.view', 'kpis.view.overview', 'kpis.view.pipeline', 'kpis.view.deadlines', 'kpis.view.submissions', 'kpis.view.workload', 'kpis.view.team'], system: true, createdAt: now(), updatedAt: now() },
    ]);
    roles = [];
    for (const id of ids.filter((x): x is string => Boolean(x))) { const r = await getById<Role>('roles', id); if (r) roles.push(r); }
  }
  const cats = await listAll<{ name: string; active: boolean; createdAt: string }>('categories');
  if (!cats.length) await db.add('categories', DEFAULT_CATEGORIES.map(name => ({ name, active: true, createdAt: now() })));
  return roles;
}
function perms(role: Role | null): Permission[] { return role?.name === 'Super Admin' ? PERMISSIONS.map(p => p.key) : role?.permissions || []; }

async function currentUser(ctx: RouterContext) {
  await seed();
  const email = (ctx.user?.email || '').toLowerCase();
  if (!email) return null;
  let users = await listAll<User>('users');
  const roles = await listAll<Role>('roles');
  const superRole = roles.find(r => r.name === 'Super Admin');
  let u = users.find(x => x.userId === ctx.user!.userId) || users.find(x => x.email.toLowerCase() === email);

  if (!u && email === SUPER_ADMIN_EMAIL) {
    if (!superRole) return null;
    const [id] = await db.add('users', [{ userId: ctx.user!.userId, email, name: ctx.user!.name || 'Super Admin', roleId: superRole.id, active: true, status: 'Active', createdAt: now(), updatedAt: now(), lastSeenAt: now() }]);
    u = { id: id || '', userId: ctx.user!.userId, email, name: ctx.user!.name || 'Super Admin', roleId: superRole.id, active: true, status: 'Active', createdAt: now(), updatedAt: now(), lastSeenAt: now() };
  }
  if (!u) return null;
  if (u.email.toLowerCase() !== email) return null;
  if (email === SUPER_ADMIN_EMAIL && superRole) u.roleId = superRole.id;
  if (!u.userId) {
    if (!u.active || u.status === 'Suspended') return { ...u, role: await getById<Role>('roles', u.roleId), permissions: [] };
    u = { ...u, userId: ctx.user!.userId, name: ctx.user!.name || u.name, status: 'Active', active: true, lastSeenAt: now(), updatedAt: now() };
    await db.update('users', [{ id: u.id, record: u }]);
  } else if (u.userId !== ctx.user!.userId) {
    return { ...u, role: await getById<Role>('roles', u.roleId), permissions: [] };
  } else if (email !== SUPER_ADMIN_EMAIL) {
    u = { ...u, name: ctx.user!.name || u.name, lastSeenAt: now(), updatedAt: now() };
    await db.update('users', [{ id: u.id, record: u }]);
  }
  const role = await getById<Role>('roles', u.roleId);
  return { ...u, role, permissions: perms(role) };
}
function requirePermission(permission: Permission) { return async (ctx: RouterContext) => { const u = await currentUser(ctx); if (!u) return error('Your Google account is not provisioned for BidWatch.', 403); if (!u.active || u.status === 'Suspended') return error('Your BidWatch access is suspended.', 403); if (!u.permissions.includes(permission)) return error('You do not have permission to perform this action.', 403); }; }
function requireSuperAdmin() { return async (ctx: RouterContext) => { const u = await currentUser(ctx); if (!u || (ctx.user?.email || '').toLowerCase() !== SUPER_ADMIN_EMAIL || u.role?.name !== 'Super Admin') return error('Super Admin access required.', 403); }; }
async function actor(ctx: RouterContext) { const u = await currentUser(ctx); if (!u) throw new Error('Unauthorized'); return u; }
async function securityLog(ctx: RouterContext, action: string, target: string, detail = '') { const u = await actor(ctx); await db.add('security_activity', [{ actorId: ctx.user!.userId, actorEmail: u.email, actorName: u.name, action, target, detail, createdAt: now() }]); }
async function tenderLog(tenderId: string, ctx: RouterContext, action: string, detail = '') { const u = await actor(ctx); await db.add('activity', [{ tenderId, actorId: ctx.user!.userId, actorName: u.name, action, detail, createdAt: now() }]); }
async function requireTender(id: string) { return getById<Tender>('tenders', id); }

async function storageStats() {
  const attachments = await listAll<{ filename: string; size: number; path: string }>('attachments');
  const listed = await storageService.listAll('tenders/', 10000);
  const tracked = new Set(attachments.map(a => a.path));
  const orphaned = listed.paths.filter(p => !tracked.has(p));
  const trackedBytes = attachments.reduce((sum, a) => sum + Number(a.size || 0), 0);
  const largest = attachments.reduce<{ name: string; size: number } | undefined>((best, a) => !best || Number(a.size || 0) > best.size ? { name: a.filename, size: Number(a.size || 0) } : best, undefined);
  return { trackedBytes, attachmentCount: attachments.length, storedFileCount: listed.paths.length, untrackedFileCount: orphaned.length, largestFile: largest, quota: 'fair-use' };
}

function kpiPermissionForSection(section: string): Permission { return `kpis.view.${section}` as Permission; }
async function buildKpis(_ctx: RouterContext, u: Awaited<ReturnType<typeof currentUser>>) {
  const tenders = await listAll<Tender>('tenders');
  const result: Record<string, unknown> = {};
  const active = tenders.filter(t => !['Applied', 'Declined'].includes(t.status));
  const applied = tenders.filter(t => t.status === 'Applied');
  const declined = tenders.filter(t => t.status === 'Declined');
  const nowMs = Date.now();
  if (u?.permissions.includes(kpiPermissionForSection('overview'))) result.overview = { active: active.length, total: tenders.length, applied: applied.length, declined: declined.length };
  if (u?.permissions.includes(kpiPermissionForSection('pipeline'))) result.pipeline = Object.fromEntries(STATUSES.map(s => [s, tenders.filter(t => t.status === s).length]));
  if (u?.permissions.includes(kpiPermissionForSection('deadlines'))) {
    const overdue = active.filter(t => new Date(t.deadline).getTime() < nowMs).length;
    const dueToday = active.filter(t => { const d = new Date(t.deadline); const n = new Date(); return d.toDateString() === n.toDateString(); }).length;
    const due1to3 = active.filter(t => { const diff = new Date(t.deadline).getTime() - nowMs; return diff > 0 && diff <= 3 * 86400000; }).length;
    const due4to7 = active.filter(t => { const diff = new Date(t.deadline).getTime() - nowMs; return diff > 3 * 86400000 && diff <= 7 * 86400000; }).length;
    const remaining = active.map(t => (new Date(t.deadline).getTime() - nowMs) / 86400000).filter(n => Number.isFinite(n));
    result.deadlines = { overdue, dueToday, due1to3, due4to7, averageDaysRemaining: remaining.length ? Math.round((remaining.reduce((a, b) => a + b, 0) / remaining.length) * 10) / 10 : 0 };
  }
  if (u?.permissions.includes(kpiPermissionForSection('submissions'))) {
    const month = new Date(); const key = `${month.getUTCFullYear()}-${month.getUTCMonth()}`;
    const inMonth = (items: Tender[]) => items.filter(t => { const d = new Date(t.appliedAt || t.submittedAt); return `${d.getUTCFullYear()}-${d.getUTCMonth()}` === key; }).length;
    const closed = applied.length + declined.length;
    result.submissions = { submittedThisMonth: inMonth(applied), declinedThisMonth: inMonth(declined), submissionRate: closed ? Math.round((applied.length / closed) * 100) : 0 };
  }
  if (u?.permissions.includes(kpiPermissionForSection('workload'))) {
    const mine = active.filter(t => t.assigneeId === u.id); const due7 = mine.filter(t => { const diff = new Date(t.deadline).getTime() - nowMs; return diff >= 0 && diff <= 7 * 86400000; }).length;
    result.workload = { myActive: mine.length, myDue7: due7 };
  }
  if (u?.permissions.includes(kpiPermissionForSection('team'))) {
    const users = (await listAll<User>('users')).filter(x => x.active && x.status !== 'Suspended');
    const assigned = active.filter(t => t.assigneeId).length; const overdueAssigned = active.filter(t => t.assigneeId && new Date(t.deadline).getTime() < nowMs).length;
    result.team = { activeUsers: users.length, assignedActiveBids: assigned, unassignedActiveBids: active.filter(t => !t.assigneeId).length, averageActiveBidsPerUser: users.length ? Math.round((assigned / users.length) * 10) / 10 : 0, overdueAssigned };
  }
  if (u?.permissions.includes(kpiPermissionForSection('access'))) {
    const users = await listAll<User>('users'); const roles = await listAll<Role>('roles');
    result.access = { provisioned: users.filter(x => x.status === 'Provisioned').length, active: users.filter(x => x.status === 'Active' && x.active).length, suspended: users.filter(x => x.status === 'Suspended' || !x.active).length, roles: roles.length };
  }
  if (u?.permissions.includes(kpiPermissionForSection('storage'))) result.storage = await storageStats();
  return result;
}

export async function reminderHandler(_event: unknown) {
  const tenders = await listAll<Tender>('tenders'); const users = await listAll<User>('users'); const notes = await listAll<{ tenderId: string; userId: string; kind: string; createdAt: string }>('notifications');
  for (const t of tenders) { if (['Applied', 'Declined'].includes(t.status)) continue; const diff = new Date(t.deadline).getTime() - Date.now(); const days = Math.ceil(diff / 86400000); if (diff >= 0 && ![14, 7, 3, 1, 0].includes(days)) continue; const kind = `deadline-${days}`; const targets = t.assigneeId ? users.filter(u => u.id === t.assigneeId && u.status !== 'Suspended' && u.active) : users.filter(u => u.status !== 'Suspended' && u.active); for (const u of targets) if (!notes.some(n => n.tenderId === t.id && n.userId === u.userId && n.kind === kind && new Date(n.createdAt).toDateString() === new Date().toDateString())) await db.add('notifications', [{ userId: u.userId, tenderId: t.id, kind, title: diff < 0 ? 'Bid overdue' : days === 0 ? 'Bid due today' : `Bid due in ${days} days`, body: `${t.title} for ${t.organisation} is ${diff < 0 ? 'past its deadline' : 'approaching its deadline'}.`, read: false, createdAt: now() }]); }
  return { statusCode: 200 };
}

export const handler = router({
  'POST /api/internal/reminders': [async ctx => {
    const secret = String(ctx.req.headers['x-cron-secret'] || '');
    if (!process.env.CRON_SECRET || secret !== process.env.CRON_SECRET) return error('Unauthorized.', 401);
    return json(await reminderHandler(null));
  }],
  'GET /api/me': [requireAuth(), async ctx => { const u = await currentUser(ctx); if (!u) return error('Your Google account is not provisioned for BidWatch.', 403); if (!u.active || u.status === 'Suspended') return error('Your BidWatch access is suspended.', 403); return json({ user: { ...u, role: u.role?.name || 'Member', onboardingCompleted: u.onboardingCompleted === true } }); }], 'PUT /api/me/profile': [requireAuth(), async ctx => { const u = await actor(ctx); const b = ctx.body as Record<string, unknown>; const name = text(b.name, 'title'); if (!name) return error('A display name is required.', 400); const next = { ...u, name, updatedAt: now() }; await db.update('users', [{ id: u.id, record: next }]); return json({ user: next }); }],
  'PUT /api/me/onboarding': [requireAuth(), async ctx => { const u = await actor(ctx); const completed = Boolean((ctx.body as Record<string, unknown>)?.completed); const next = { ...u, onboardingCompleted: completed, updatedAt: now() }; await db.update('users', [{ id: u.id, record: next }]); return json({ onboardingCompleted: completed }); }],
  'GET /api/config': [requireAuth(), requirePermission('bids.view'), async () => { const records = await listAll<{ name: string; active: boolean }>('categories'); return json({ categories: records.filter(x => x.active).map(x => x.name), categoryRecords: records, statuses: STATUSES }); }],
  'GET /api/opportunities/sources': [requireAuth(), requirePermission('bids.view'), async () => json({ sources: DISCOVERY_SOURCES })],
  'GET /api/opportunities/updates': [requireAuth(), requirePermission('bids.view'), async () => json({ updates: await listOpportunityUpdates(60) })],
  'GET /api/opportunities/:id': [requireAuth(), requirePermission('bids.view'), async ctx => { const opportunity = await verifyOpportunity(ctx.params.id); if (!opportunity) return error('Opportunity not found.', 404); return json({ opportunity }); }],
  'POST /api/opportunities/scan': [requireAuth(), requirePermission('bids.view'), async ctx => { if (!rateLimit(`scan:${ctx.user!.userId}`, RATE_LIMITS.scan)) return error('Source scanning is temporarily rate-limited. Try again in a few minutes.', 429); const sources = await discoverPlatformOpportunities(); await persistOpportunityUpdates(sources); const persisted = await listOpportunityUpdates(120); const missingDeadlines = persisted.filter(item => !item.deadline && item.state !== 'dismissed').slice(0, 30); for (const item of missingDeadlines) await verifyOpportunity(item.id); return json({ scannedAt: now(), sources }); }],
  'POST /api/opportunities/import': [requireAuth(), requirePermission('bids.create'), async ctx => { const u = await actor(ctx); const b = ctx.body as Record<string, unknown>; const title = text(b.title, 'title'); const organisation = text(b.organisation, 'organisation', 'Unknown organisation'); const deadline = text(b.deadline, 'deadline'); const url = text(b.url, 'url'); const category = text(b.category, 'category', 'Other'); const reference = text(b.reference, 'reference'); if (!title || !deadline || !validDeadline(deadline)) return error('A valid title and deadline are required to import an opportunity.', 400); if (!validUrl(url)) return error('Only http and https source URLs are allowed.', 400); const cats = await listAll<{ name: string; active: boolean }>('categories'); if (!cats.some(c => c.active && c.name === category)) return error('Category is not active.', 400); const existing = await listAll<Tender>('tenders'); const duplicate = existing.find(t => (reference && t.reference && t.reference.toLowerCase() === reference.toLowerCase()) || (url && t.url && t.url === url)); if (duplicate) return json({ duplicate: true, tender: duplicate }); const [id] = await db.add('tenders', [{ title, organisation, reference, description: text(b.description, 'description'), deadline, source: text(b.source, 'source'), url, category, status: 'New', assigneeId: '', submittedBy: u.id, submittedAt: now(), notes: text(b.notes, 'notes'), revision: 1 }]); if (!id) return error('Could not import opportunity.', 500); const opportunityUpdateId = text(b.opportunityUpdateId, 'reference'); if (opportunityUpdateId) { const update = await getById<Record<string, unknown>>('opportunity_updates', opportunityUpdateId); if (update) await db.update('opportunity_updates', [{ id: update.id, record: { ...update, state: 'imported', importedTenderId: id, lastSeenAt: now() } }]); } await tenderLog(id, ctx, 'imported an opportunity', text(b.source, 'source')); return json({ duplicate: false, tender: await getById<Tender>('tenders', id) }, 201); }],
  'GET /api/kpis': [requireAuth(), requirePermission('bids.view'), async ctx => { const u = await actor(ctx); return json({ kpis: await buildKpis(ctx, u) }); }],
  'GET /api/tenders': [requireAuth(), requirePermission('bids.view'), async () => json({ tenders: (await listAll<Tender>('tenders')).map(t => ({ ...t, revision: Number(t.revision || 1) })) })],
  'GET /api/history': [requireAuth(), requirePermission('bids.view'), async () => { const history = await listAll<BidHistory>('bid_history'); return json({ history: history.sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime()) }); }],
  'POST /api/tenders': [requireAuth(), requirePermission('bids.create'), async ctx => { const u = await actor(ctx); const b = ctx.body as Record<string, unknown>; const title = text(b.title, 'title'); const organisation = text(b.organisation, 'organisation'); const deadline = text(b.deadline, 'deadline'); const url = text(b.url, 'url'); if (!title || !organisation || !deadline) return error('Title, organisation and deadline are required.', 400); if (!validDeadline(deadline)) return error('Deadline is invalid.', 400); if (!validUrl(url)) return error('Only http and https source URLs are allowed.', 400); const category = text(b.category, 'category', 'Other'); const cats = await listAll<{ name: string; active: boolean }>('categories'); if (!cats.some(c => c.active && c.name === category)) return error('Category is not active.', 400); const assigneeId = text(b.assigneeId, 'reference'); if (assigneeId) { const users = await listAll<User>('users'); if (!users.some(x => x.id === assigneeId && x.active && x.status !== 'Suspended')) return error('The selected assignee is not an active BidWatch user.', 400); } const [id] = await db.add('tenders', [{ title, organisation, reference: text(b.reference, 'reference'), description: text(b.description, 'description'), deadline, source: text(b.source, 'source'), url, category, status: 'New', assigneeId, submittedBy: u.id, submittedAt: now(), notes: text(b.notes, 'notes'), revision: 1 }]); if (!id) return error('Could not create tender.', 500); await tenderLog(id, ctx, 'created the bid'); return json({ tender: await getById<Tender>('tenders', id) }, 201); }],
  'PUT /api/tenders/:id': [requireAuth(), async ctx => { const u = await actor(ctx); const b = ctx.body as Record<string, unknown>; const old = await requireTender(ctx.params.id); if (!old) return error('Bid not found.', 404); const currentRevision = Number(old.revision || 1); const expectedRevision = b.expectedRevision === undefined ? currentRevision : Number(b.expectedRevision); if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision) return error('This bid was changed by another user. Refresh the record before saving your changes.', 409); if (['Applied', 'Declined'].includes(old.status) && b.status !== undefined && String(b.status) !== old.status) return error('Closed bids cannot be reopened through ordinary editing.', 409); if (b.assigneeId !== undefined && !u.permissions.includes('bids.assign')) return error('You do not have permission to assign bids.', 403);
    if (b.assigneeId !== undefined && String(b.assigneeId)) { const users = await listAll<User>('users'); if (!users.some(x => x.id === String(b.assigneeId) && x.active && x.status !== 'Suspended')) return error('The selected assignee is not an active BidWatch user.', 400); } const ordinaryKeys = Object.keys(b).filter(k => !['assigneeId', 'status'].includes(k)); if (ordinaryKeys.length && !u.permissions.includes('bids.edit')) return error('You do not have permission to edit bid data.', 403); if (b.status !== undefined && String(b.status) !== old.status) { const nextStatus = String(b.status); if (!STATUSES.includes(nextStatus)) return error('Invalid workflow status.', 400); if (nextStatus === 'Applied' && !u.permissions.includes('bids.apply')) return error('You do not have permission to mark bids Applied.', 403); if (nextStatus === 'Declined' && !u.permissions.includes('bids.decline')) return error('You do not have permission to mark bids Declined.', 403); if (!['Applied', 'Declined'].includes(nextStatus) && !u.permissions.includes('bids.edit')) return error('You do not have permission to change workflow status.', 403); } const next = { ...old } as Record<string, unknown>; for (const k of ['title', 'organisation', 'reference', 'description', 'deadline', 'source', 'url', 'category', 'notes']) if (b[k] !== undefined) next[k] = text(b[k], k); if (b.deadline !== undefined && !validDeadline(String(next.deadline))) return error('Deadline is invalid.', 400); if (b.url !== undefined && !validUrl(String(next.url || ''))) return error('Only http and https source URLs are allowed.', 400); if (b.category !== undefined) { const cats = await listAll<{ name: string; active: boolean }>('categories'); if (!cats.some(c => c.name === String(next.category) && c.active)) return error('Category is not active.', 400); } if (b.assigneeId !== undefined) next.assigneeId = text(b.assigneeId, 'reference'); if (b.status !== undefined) next.status = String(b.status); next.revision = currentRevision + 1; await db.update('tenders', [{ id: old.id, record: next }]); if (next.status !== old.status) await tenderLog(old.id, ctx, 'changed status', `${old.status} → ${next.status}`); if (next.assigneeId !== old.assigneeId) await tenderLog(old.id, ctx, 'changed the assignee'); return json({ tender: await getById<Tender>('tenders', old.id) }); }],
  'DELETE /api/tenders/:id': [requireAuth(), requirePermission('bids.delete'), async ctx => { const u = await actor(ctx); const old = await requireTender(ctx.params.id); if (!old) return error('Bid not found.', 404); const attachments = await listAll<{ id: string; tenderId: string; path: string }>('attachments'); const owned = attachments.filter(a => a.tenderId === old.id); const archived: Omit<BidHistory, 'id'> = { originalTenderId: old.id, title: old.title, organisation: old.organisation, reference: old.reference, description: old.description, deadline: old.deadline, source: old.source, url: old.url, category: old.category, status: old.status, assigneeId: old.assigneeId, submittedBy: old.submittedBy, submittedAt: old.submittedAt, notes: old.notes, submissionReference: old.submissionReference, appliedBy: old.appliedBy, appliedAt: old.appliedAt, deletedBy: u.id, deletedAt: now(), attachmentCount: owned.length }; const [historyId] = await db.add('bid_history', [archived]); if (!historyId) return error('Could not preserve the bid history. The bid was not deleted.', 500); if (owned.length) { const deleted = await storageService.delete(owned.map(a => a.path)); if (deleted.some(ok => !ok)) { await db.delete('bid_history', [historyId]); return error('Could not remove all bid documents. The bid was not deleted.', 500); } await db.delete('attachments', owned.map(a => a.id)); } await db.delete('tenders', [old.id]); return json({ ok: true, deletedAttachments: owned.length, historyId }); }],
  'POST /api/tenders/:id/apply': [requireAuth(), requirePermission('bids.apply'), async ctx => { const u = await actor(ctx); const old = await requireTender(ctx.params.id); if (!old) return error('Bid not found.', 404); if (['Applied', 'Declined'].includes(old.status)) return error('This bid is already closed.', 409); const b = ctx.body as Record<string, unknown>; const currentRevision = Number(old.revision || 1); const expectedRevision = b.expectedRevision === undefined ? currentRevision : Number(b.expectedRevision); if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision) return error('This bid was changed by another user. Refresh the record before recording the submission.', 409); const submissionReference = text(b.submissionReference, 'submissionReference'); const next = { ...old, status: 'Applied', appliedBy: u.id, appliedAt: now(), submissionReference, revision: currentRevision + 1 }; await db.update('tenders', [{ id: old.id, record: next }]); await tenderLog(old.id, ctx, 'marked the bid Applied', submissionReference); return json({ tender: next }); }],
  'POST /api/tenders/:id/decline': [requireAuth(), requirePermission('bids.decline'), async ctx => { const old = await requireTender(ctx.params.id); if (!old) return error('Bid not found.', 404); if (['Applied', 'Declined'].includes(old.status)) return error('This bid is already closed.', 409); const b = ctx.body as Record<string, unknown>; const currentRevision = Number(old.revision || 1); const expectedRevision = b.expectedRevision === undefined ? currentRevision : Number(b.expectedRevision); if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision) return error('This bid was changed by another user. Refresh the record before declining it.', 409); await db.update('tenders', [{ id: old.id, record: { ...old, status: 'Declined', revision: currentRevision + 1 } }]); await tenderLog(old.id, ctx, 'marked the bid Declined'); return json({ tender: await getById<Tender>('tenders', old.id) }); }],
  'GET /api/tenders/:id/attachments': [requireAuth(), requirePermission('bids.view'), async ctx => { const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); const a = await listAll<{ tenderId: string; filename: string; mimeType: string; size: number; path: string; uploadedBy: string; uploadedAt: string }>('attachments'); return json({ attachments: a.filter(x => x.tenderId === tender.id) }); }],
  'POST /api/tenders/:id/attachments': [requireAuth(), requirePermission('attachments.upload'), async ctx => { const u = await actor(ctx); const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); const b = ctx.body as Record<string, unknown>; if (!rateLimit(`upload:${ctx.user!.userId}`, RATE_LIMITS.upload)) return error('Upload rate limit reached. Try again in a few minutes.', 429); const filename = String(b.filename || '').trim(); const mimeType = String(b.mimeType || 'application/octet-stream').toLowerCase(); const size = Number(b.size || 0); const content = String(b.content || ''); const validationError = validateUpload(filename, mimeType, size, content); if (validationError) return error(validationError, 400); const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_'); const path = `tenders/${tender.id}/${crypto.randomUUID()}-${safeName}`; const ok = await storageService.put(path, content, mimeType); if (!ok) return error('File upload failed.', 500); const [id] = await db.add('attachments', [{ tenderId: tender.id, filename, mimeType, size, path, uploadedBy: u.id, uploadedAt: now() }]); if (!id) { await storageService.delete([path]); return error('Could not save attachment metadata.', 500); } await tenderLog(tender.id, ctx, 'uploaded an attachment', filename); return json({ attachment: { id, filename } }, 201); }],
  'GET /api/attachments/:id/url': [requireAuth(), requirePermission('bids.view'), async ctx => { const a = await getById<{ tenderId: string; path: string }>('attachments', ctx.params.id); if (!a || !(await requireTender(a.tenderId))) return error('Attachment not found.', 404); const url = await storageService.getUrl(a.path); return json({ url }); }],
  'DELETE /api/attachments/:id': [requireAuth(), requirePermission('attachments.delete'), async ctx => { const a = await getById<{ tenderId: string; path: string; filename: string }>('attachments', ctx.params.id); if (!a) return error('Attachment not found.', 404); if (!(await requireTender(a.tenderId))) return error('Attachment not found.', 404); const [deleted] = await storageService.delete([a.path]); if (!deleted) return error('Could not delete the stored document.', 500); await db.delete('attachments', [ctx.params.id]); await tenderLog(a.tenderId, ctx, 'deleted an attachment', a.filename); return json({ ok: true }); }],
  'GET /api/tenders/:id/activity': [requireAuth(), requirePermission('bids.view'), async ctx => { if (!(await requireTender(ctx.params.id))) return error('Bid not found.', 404); const a = await listAll<{ tenderId: string; actorName: string; action: string; detail: string; createdAt: string }>('activity'); return json({ activities: a.filter(x => x.tenderId === ctx.params.id).sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime()) }); }],
  'GET /api/notifications': [requireAuth(), requirePermission('notifications.view'), async ctx => { const n = await listAll<{ userId: string; title: string; body: string; read: boolean; createdAt: string }>('notifications'); return json({ notifications: n.filter(x => x.userId === ctx.user!.userId).sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime()) }); }],
  'POST /api/notifications/:id/read': [requireAuth(), requirePermission('notifications.view'), async ctx => { const n = await getById<{ userId: string; read: boolean }> ('notifications', ctx.params.id); if (!n || n.userId !== ctx.user!.userId) return error('Notification not found.', 404); await db.update('notifications', [{ id: n.id, record: { ...n, read: true } }]); return json({ ok: true }); }], 'POST /api/notifications/read-all': [requireAuth(), requirePermission('notifications.view'), async ctx => { const notes = await listAll<{ userId: string; read: boolean }>('notifications'); const mine = notes.filter(n => n.userId === ctx.user!.userId && !n.read); if (mine.length) await db.update('notifications', mine.map(n => ({ id: n.id, record: { ...n, read: true } }))); return json({ ok: true }); }], 'DELETE /api/notifications': [requireAuth(), requirePermission('notifications.view'), async ctx => { const notes = await listAll<{ userId: string }>('notifications'); const mine = notes.filter(n => n.userId === ctx.user!.userId); if (mine.length) await db.delete('notifications', mine.map(n => n.id)); return json({ ok: true }); }],
  'GET /api/admin/users': [requireAuth(), requirePermission('users.view'), async () => json({ users: await listAll<User>('users') })],
  'POST /api/admin/users': [requireAuth(), requirePermission('users.manage'), async ctx => { const u = await actor(ctx); const b = ctx.body as Record<string, unknown>; const email = text(b.email, 'reference').toLowerCase(); const name = text(b.name, 'title'); const roleId = String(b.roleId || ''); if (!validEmail(email) || !roleId) return error('A valid email and role are required.', 400); if (email === SUPER_ADMIN_EMAIL) return error('The protected Super Admin identity is managed separately.', 403); const role = await getById<Role>('roles', roleId); if (!role) return error('Selected role was not found.', 400); if (roleHasSensitive(role) && u.role?.name !== 'Super Admin') return error('Only the protected Super Admin can provision sensitive access roles.', 403); const users = await listAll<User>('users'); if (users.some(x => x.email.toLowerCase() === email)) return error('A user with that email already exists.', 409); const [id] = await db.add('users', [{ email, name: name || email.split('@')[0], roleId, active: true, status: 'Provisioned', createdAt: now(), updatedAt: now() }]); await securityLog(ctx, 'user.provisioned', email, role.name); return json({ user: await getById<User>('users', id || '') }, 201); }],
  'PUT /api/admin/users/:id': [requireAuth(), requirePermission('users.manage'), async ctx => { const actorUser = await actor(ctx); const old = await getById<User>('users', ctx.params.id); if (!old) return error('User not found.', 404); if (old.email.toLowerCase() === SUPER_ADMIN_EMAIL) return error('The protected Super Admin account cannot be changed here.', 403); const b = ctx.body as Record<string, unknown>; const next = { ...old }; if (b.name !== undefined) next.name = text(b.name, 'title'); if (b.roleId !== undefined) { const role = await getById<Role>('roles', String(b.roleId)); if (!role) return error('Selected role was not found.', 400); if (roleHasSensitive(role) && actorUser.role?.name !== 'Super Admin') return error('Only the protected Super Admin can assign sensitive access roles.', 403); next.roleId = role.id; } if (b.active !== undefined) next.active = Boolean(b.active); if (b.status !== undefined) { const status = String(b.status); if (!['Provisioned', 'Active', 'Suspended'].includes(status)) return error('Invalid user status.', 400); next.status = status as User['status']; } next.updatedAt = now(); await db.update('users', [{ id: old.id, record: next }]); await securityLog(ctx, 'user.access_changed', old.email, JSON.stringify({ roleId: next.roleId, active: next.active, status: next.status })); return json({ user: next }); }],
  'GET /api/admin/roles': [requireAuth(), requirePermission('roles.view'), async () => json({ roles: await listAll<Role>('roles'), permissions: PERMISSIONS })],
  'POST /api/admin/roles': [requireAuth(), requirePermission('roles.manage'), async ctx => { const u = await actor(ctx); const b = ctx.body as Record<string, unknown>; const name = text(b.name, 'title'); const description = text(b.description, 'description'); const permissions = Array.isArray(b.permissions) ? b.permissions.filter((x): x is Permission => PERMISSIONS.some(p => p.key === x)) : []; if (!name) return error('Role name is required.', 400); if (u.role?.name !== 'Super Admin' && permissions.some(p => SENSITIVE_PERMISSIONS.includes(p))) return error('Sensitive permissions can only be allocated by the protected Super Admin.', 403); const roles = await listAll<Role>('roles'); if (roles.some(x => x.name.toLowerCase() === name.toLowerCase())) return error('A role with that name already exists.', 409); const [id] = await db.add('roles', [{ name, description, permissions, system: false, createdAt: now(), updatedAt: now() }]); await securityLog(ctx, 'role.created', name, permissions.join(', ')); return json({ role: await getById<Role>('roles', id || '') }, 201); }],
  'PUT /api/admin/roles/:id': [requireAuth(), requirePermission('roles.manage'), async ctx => { const u = await actor(ctx); const old = await getById<Role>('roles', ctx.params.id); if (!old) return error('Role not found.', 404); if (old.system) return error('System roles are protected. Create a custom role instead.', 403); const b = ctx.body as Record<string, unknown>; const permissions = Array.isArray(b.permissions) ? b.permissions.filter((x): x is Permission => PERMISSIONS.some(p => p.key === x)) : old.permissions; if (u.role?.name !== 'Super Admin' && permissions.some(p => SENSITIVE_PERMISSIONS.includes(p))) return error('Sensitive permissions can only be allocated by the protected Super Admin.', 403); const next = { ...old, name: text(b.name, 'title', old.name), description: text(b.description, 'description', old.description), permissions, updatedAt: now() }; if (!next.name) return error('Role name is required.', 400); await db.update('roles', [{ id: old.id, record: next }]); await securityLog(ctx, 'role.updated', old.name, permissions.join(', ')); return json({ role: next }); }],
  'DELETE /api/admin/roles/:id': [requireAuth(), requirePermission('roles.manage'), async ctx => { const old = await getById<Role>('roles', ctx.params.id); if (!old) return error('Role not found.', 404); if (old.system) return error('System roles cannot be deleted.', 403); const users = await listAll<User>('users'); if (users.some(x => x.roleId === old.id)) return error('This role is assigned to users. Reassign them first.', 409); await db.delete('roles', [old.id]); await securityLog(ctx, 'role.deleted', old.name); return json({ ok: true }); }],
  'GET /api/admin/categories': [requireAuth(), requirePermission('categories.manage'), async () => json({ categories: await listAll<{ name: string; active: boolean; createdAt: string }>('categories') })],
  'POST /api/admin/categories': [requireAuth(), requirePermission('categories.manage'), async ctx => { const name = text((ctx.body as Record<string, unknown>).name, 'category'); if (!name) return error('Category name is required.', 400); const cats = await listAll<{ name: string; active: boolean }>('categories'); if (cats.some(x => x.name.toLowerCase() === name.toLowerCase())) return error('That category already exists.', 409); const [id] = await db.add('categories', [{ name, active: true, createdAt: now() }]); return json({ category: await getById('categories', id || '') }, 201); }],
  'PUT /api/admin/categories/:id': [requireAuth(), requirePermission('categories.manage'), async ctx => { const old = await getById<{ name: string; active: boolean }>('categories', ctx.params.id); if (!old) return error('Category not found.', 404); const b = ctx.body as Record<string, unknown>; const next = { ...old, name: text(b.name, 'category', old.name), active: b.active === undefined ? old.active : Boolean(b.active) }; await db.update('categories', [{ id: old.id, record: next }]); return json({ category: next }); }],
  'GET /api/admin/audit': [requireAuth(), requirePermission('audit.view'), async () => json({ events: (await listAll<Record<string, string>>('security_activity')).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 200) })],
  'GET /api/admin/storage': [requireAuth(), requirePermission('settings.manage'), async () => json(await storageStats())],
  'POST /api/admin/storage/cleanup': [requireAuth(), requireSuperAdmin(), async () => { const attachments = await listAll<{ path: string }>('attachments'); const tracked = new Set(attachments.map(a => a.path)); const listed = await storageService.listAll('tenders/', 10000); const orphaned = listed.paths.filter(path => !tracked.has(path)); if (orphaned.length) { const deleted = await storageService.delete(orphaned); if (deleted.some(ok => !ok)) return error('Some orphaned files could not be removed.', 500); } return json({ ok: true, deleted: orphaned.length }); }],
});
