import { timingSafeEqual } from 'node:crypto';
import { db, router, json, error, requireAuth, supabaseAdmin, type RouterContext } from './runtime';
import { requireOrganisation, requireLegacyOrganisation } from './tenancy';
import { storageService } from './storage';
import { discoverPlatformOpportunities, listOpportunityUpdates, persistOpportunityUpdates, OPPORTUNITY_SOURCES as DISCOVERY_SOURCES } from './opportunity-discovery';
import { verifyOpportunity } from './opportunity-verification';

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
const ACTIVE_STATUSES = ['New', 'Reviewing', 'Pursuing', 'Preparing', 'Ready to Submit'];
function validWorkflowTransition(from: string, to: string) {
  if (from === to) return true;
  if (!STATUSES.includes(to)) return false;
  if (['Applied', 'Declined'].includes(from)) return false;
  // Active work may move backwards when a review exposes missing work, but closure
  // is deliberately controlled by the dedicated Apply/Decline endpoints.
  return ACTIVE_STATUSES.includes(from) && ACTIVE_STATUSES.includes(to);
}
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
function validCronSecret(ctx: RouterContext) {
  const expected = process.env.CRON_SECRET || '';
  const supplied = String(ctx.req.headers['x-cron-secret'] || '');
  if (!expected || !supplied) return false;
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

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
  const ext = filename.toLowerCase().split('.').pop() || '';  if (!filename || !content) return 'File data is required.';
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
interface Tender { id: string; title: string; organisation: string; reference: string; description: string; deadline: string; source: string; url: string; category: string; status: string; assigneeId: string; submittedBy: string; submittedAt: string; notes: string; revision?: number; submissionReference?: string; submissionMethod?: string; submissionReceiptUrl?: string; submissionNotes?: string; appliedBy?: string; appliedAt?: string; qualification?: Qualification; }
interface Qualification { decision: 'undecided' | 'bid' | 'no-bid' | 'needs-review'; score: number; criteria: Record<string, number>; notes: string; updatedAt: string; updatedBy: string }
interface BidRequirement { id: string; tenderId: string; title: string; mandatory: boolean; status: 'open' | 'met' | 'missing' | 'needs-review'; evidence: string; ownerId: string; createdAt: string; updatedAt: string }
interface BidTask { id: string; tenderId: string; title: string; assigneeId: string; dueAt: string; status: 'todo' | 'in-progress' | 'done'; priority: 'low' | 'medium' | 'high'; kind: 'internal-review' | 'technical' | 'financial' | 'submission' | 'other'; createdAt: string; updatedAt: string }
interface BidHistory { id: string; originalTenderId: string; title: string; organisation: string; reference: string; description: string; deadline: string; source: string; url: string; category: string; status: string; assigneeId: string; submittedBy: string; submittedAt: string; notes: string; submissionReference?: string; submissionMethod?: string; submissionReceiptUrl?: string; submissionNotes?: string; appliedBy?: string; appliedAt?: string; deletedBy: string; deletedAt: string; attachmentCount: number }

const OPPORTUNITY_SOURCES = [
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

function opportunityMatch(textValue: string) {
  const haystack = textValue.toLowerCase();
  return OPPORTUNITY_TERMS.filter(term => haystack.includes(term)).slice(0, 12);
}

async function listAll<T>(table: string, limit = 500) { const r = await db.list<T>(table, { limit }); return r.items; }
async function ensureDefaultCategories() {
  const categories = await listAll<{ name: string; active: boolean; createdAt: string }>('categories');
  if (!categories.length) await db.add('categories', DEFAULT_CATEGORIES.map(name => ({ name, active: true, createdAt: now() })));
}
async function listCurrentOrganisationMembers(ctx: RouterContext) {
  if (!ctx.organisation || !supabaseAdmin) throw new Error('Organisation context is unavailable.');
  const { data: memberships, error: membershipError } = await supabaseAdmin
    .from('organisation_members').select('id,user_id,role_id,status,joined_at')
    .eq('organisation_id', ctx.organisation.id).order('joined_at', { ascending: true });
  if (membershipError) throw new Error(membershipError.message);
  const [users, roleResult] = await Promise.all([
    listAll<User>('users'),
    supabaseAdmin.from('organisation_roles').select('id,name').eq('organisation_id', ctx.organisation.id),
  ]);
  if (roleResult.error) throw new Error(roleResult.error.message);
  const roles = new Map((roleResult.data || []).map(role => [role.id, role]));
  return (memberships || []).map(member => {
    const profile = users.find(user => user.userId === member.user_id);
    const role = roles.get(member.role_id);
    return { id: profile?.id || member.id, membershipId: member.id, userId: member.user_id,
      email: profile?.email || '', name: profile?.name || '', roleId: member.role_id,
      role: role?.name || 'Unknown role', status: member.status, joinedAt: member.joined_at };
  });
}
async function listCurrentOrganisationRoles(ctx: RouterContext) {
  if (!ctx.organisation || !supabaseAdmin) throw new Error('Organisation context is unavailable.');
  const { data, error: queryError } = await supabaseAdmin.from('organisation_roles')
    .select('id,key,name,description,permissions,is_system').eq('organisation_id', ctx.organisation.id)
    .order('name', { ascending: true });
  if (queryError) throw new Error(queryError.message);
  return (data || []).map(role => ({ id: role.id, key: role.key, name: role.name,
    description: role.description || '', permissions: Array.isArray(role.permissions) ? role.permissions : [],
    system: Boolean(role.is_system) }));
}
async function activeOrganisationProfileIds(ctx: RouterContext) {
  if (!ctx.organisation || !supabaseAdmin) throw new Error('Organisation context is unavailable.');
  const { data, error: queryError } = await supabaseAdmin.from('organisation_members')
    .select('user_id').eq('organisation_id', ctx.organisation.id).eq('status', 'active');
  if (queryError) throw new Error(queryError.message);
  const activeAuthIds = new Set((data || []).map(member => member.user_id));
  const users = await listAll<User>('users');
  return new Set(users.filter(user => user.userId && activeAuthIds.has(user.userId)).map(user => user.id));
}
async function getById<T>(table: string, id: string) { const [r] = await db.get<T>(table, [id]); return r ? { ...(r as T), id } : null; }
function text(value: unknown, field: string, fallback = '') { const s = String(value ?? fallback).trim(); return s.slice(0, MAX_TEXT[field] ?? 500); }
function validUrl(value: string) { if (!value) return true; try { const u = new URL(value); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } }
function validDeadline(value: string) { const d = new Date(value).getTime(); return Number.isFinite(d); }

async function currentUser(ctx: RouterContext) {
  if (!ctx.organisation || !ctx.user?.email) return null;
  const email = ctx.user.email.toLowerCase();
  const users = await listAll<User>('users');
  const user = users.find(item => item.userId === ctx.user!.userId);
  if (!user || user.email.toLowerCase() !== email) return null;

  // The membership and organisation role are the sole access-control source.
  // Legacy users.active/status/roleId are retained only for compatibility.
  const role: Role = {
    id: ctx.organisation.roleId,
    name: ctx.organisation.roleName,
    description: '',
    permissions: ctx.organisation.permissions.filter((value): value is Permission =>
      PERMISSIONS.some(permission => permission.key === value)),
    system: ctx.organisation.roleKey === 'owner',
    createdAt: '',
    updatedAt: '',
  };
  return {
    ...user,
    roleId: ctx.organisation.roleId,
    role,
    permissions: role.permissions,
    active: true,
    status: 'Active' as const,
  };
}
function requirePermission(permission: Permission) {
  return async (ctx: RouterContext) => {
    if (!ctx.organisation) return error('Select an organisation to continue.', 403);
    if (!ctx.organisation.permissions.includes(permission)) return error('You do not have permission to perform this action.', 403);
  };
}
function requireSuperAdmin() {
  return async (ctx: RouterContext) => {
    if (!ctx.organisation?.isPlatformAdmin) return error('Platform administrator access required.', 403);
  };
}
async function actor(ctx: RouterContext) { const u = await currentUser(ctx); if (!u) throw new Error('Unauthorized'); return u; }
async function securityLog(ctx: RouterContext, action: string, target: string, detail = '') { const u = await actor(ctx); await db.add('security_activity', [{ actorId: ctx.user!.userId, actorEmail: u.email, actorName: u.name, action, target, detail, createdAt: now() }]); }
async function tenderLog(tenderId: string, ctx: RouterContext, action: string, detail = '') { const u = await actor(ctx); await db.add('activity', [{ tenderId, actorId: ctx.user!.userId, actorName: u.name, action, detail, createdAt: now() }]); }
async function requireTender(id: string) { return getById<Tender>('tenders', id); }

async function storageStats(ctx: RouterContext) {
  if (!ctx.organisation) throw new Error('Organisation context is unavailable.');
  const attachments = await listAll<{ filename: string; size: number; path: string }>('attachments');
  const prefix = `organisations/${ctx.organisation.id}/tenders/`;
  const listed = await storageService.listAll(prefix, 10000);
  const legacyPaths = ctx.organisation.slug === 'legacy-bidwatch-workspace'
    ? await storageService.listAll('tenders/', 10000)
    : { paths: [] as string[] };
  const paths = [...listed.paths, ...legacyPaths.paths];
  const tracked = new Set(attachments.map(a => a.path));
  const orphaned = paths.filter(p => !tracked.has(p));
  const trackedBytes = attachments.reduce((sum, a) => sum + Number(a.size || 0), 0);
  const largest = attachments.reduce<{ name: string; size: number } | undefined>((best, a) => !best || Number(a.size || 0) > best.size ? { name: a.filename, size: Number(a.size || 0) } : best, undefined);
  return { trackedBytes, attachmentCount: attachments.length, storedFileCount: paths.length, untrackedFileCount: orphaned.length, largestFile: largest, quota: 'fair-use' };
}

function kpiPermissionForSection(section: string): Permission { return `kpis.view.${section}` as Permission; }
async function buildKpis(ctx: RouterContext, u: Awaited<ReturnType<typeof currentUser>>) {
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
    const members = (await listCurrentOrganisationMembers(ctx)).filter(member => member.status === 'active');
    const assigned = active.filter(t => t.assigneeId).length; const overdueAssigned = active.filter(t => t.assigneeId && new Date(t.deadline).getTime() < nowMs).length;
    result.team = { activeUsers: members.length, assignedActiveBids: assigned, unassignedActiveBids: active.filter(t => !t.assigneeId).length, averageActiveBidsPerUser: members.length ? Math.round((assigned / members.length) * 10) / 10 : 0, overdueAssigned };
  }
  if (u?.permissions.includes(kpiPermissionForSection('access'))) {
    const members = await listCurrentOrganisationMembers(ctx); const roles = await listCurrentOrganisationRoles(ctx);
    result.access = {
      provisioned: members.filter(x => x.status === 'invited').length,
      active: members.filter(x => x.status === 'active').length,
      suspended: members.filter(x => x.status === 'suspended' || x.status === 'removed').length,
      roles: roles.length,
    };
  }  if (u?.permissions.includes(kpiPermissionForSection('storage'))) result.storage = await storageStats(ctx);
  return result;
}

export async function procurementDiscoveryHandler(_event: unknown) {
  const sources = await discoverPlatformOpportunities();
  await persistOpportunityUpdates(sources, 'scheduled');
  return { statusCode: 200, scannedAt: now(), sources };
}

export async function reminderHandler(_event: unknown) {
  if (!supabaseAdmin) throw new Error('Supabase is not configured.');
  const { data: workspace, error: workspaceError } = await supabaseAdmin.from('organisations')
    .select('id').eq('slug', 'legacy-bidwatch-workspace').maybeSingle();
  if (workspaceError || !workspace) throw new Error(workspaceError?.message || 'Legacy workspace not found.');
  const { data: memberships, error: membershipError } = await supabaseAdmin.from('organisation_members')
    .select('user_id,status').eq('organisation_id', workspace.id).eq('status', 'active');
  if (membershipError) throw new Error(membershipError.message);
  const activeUserIds = new Set((memberships || []).map(member => member.user_id));
  const tenders = await listAll<Tender>('tenders');
  const users = (await listAll<User>('users')).filter(user => Boolean(user.userId && activeUserIds.has(user.userId)));
  const notes = await listAll<{ tenderId: string; userId: string; kind: string; createdAt: string }>('notifications');
  for (const t of tenders) {
    if (['Applied', 'Declined'].includes(t.status)) continue;
    const diff = new Date(t.deadline).getTime() - Date.now();
    const days = Math.ceil(diff / 86400000);
    if (diff >= 0 && ![14, 7, 3, 1, 0].includes(days)) continue;
    const kind = `deadline-${days}`;
    const targets = t.assigneeId ? users.filter(user => user.id === t.assigneeId) : users;
    for (const user of targets) {
      if (!user.userId || notes.some(note => note.tenderId === t.id && note.userId === user.userId && note.kind === kind && new Date(note.createdAt).toDateString() === new Date().toDateString())) continue;
      await db.add('notifications', [{
        userId: user.userId, tenderId: t.id, kind,
        title: diff < 0 ? 'Bid overdue' : days === 0 ? 'Bid due today' : `Bid due in ${days} days`,
        body: `${t.title} for ${t.organisation} is ${diff < 0 ? 'past its deadline' : 'approaching its deadline'}.`,
        read: false, createdAt: now(),
      }]);
    }
  }
  return { statusCode: 200 };
}

export const handler = router({
  'POST /api/internal/reminders': [async ctx => { if (!validCronSecret(ctx)) return error('Forbidden.', 403); }, requireLegacyOrganisation(), async ctx => json(await reminderHandler(ctx))],
  'POST /api/internal/opportunity-scan': [async ctx => { if (!validCronSecret(ctx)) return error('Forbidden.', 403); }, requireLegacyOrganisation(), async ctx => json(await procurementDiscoveryHandler(ctx))],
  'GET /api/me': [requireAuth(), requireOrganisation(), async ctx => { const u = await currentUser(ctx); if (!u) return error('Your Google account is not provisioned for BidWatch.', 403); return json({ user: { ...u, role: u.role?.name || 'Member', onboardingCompleted: u.onboardingCompleted === true } }); }], 'PUT /api/me/profile': [requireAuth(), requireOrganisation(), async ctx => { const u = await actor(ctx); const b = ctx.body as Record<string, unknown>; const name = text(b.name, 'title'); if (!name) return error('A display name is required.', 400); const next = { ...u, name, updatedAt: now() }; await db.update('users', [{ id: u.id, record: next }]); return json({ user: next }); }],
  'PUT /api/me/onboarding': [requireAuth(), requireOrganisation(), async ctx => { const u = await actor(ctx); const completed = Boolean((ctx.body as Record<string, unknown>)?.completed); const next = { ...u, onboardingCompleted: completed, updatedAt: now() }; await db.update('users', [{ id: u.id, record: next }]); return json({ onboardingCompleted: completed }); }],
  'GET /api/config': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async () => { await ensureDefaultCategories(); const records = await listAll<{ name: string; active: boolean }>('categories'); return json({ categories: records.filter(x => x.active).map(x => x.name), categoryRecords: records, statuses: STATUSES }); }],
  'GET /api/opportunities/sources': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async () => json({ sources: DISCOVERY_SOURCES })],
  'GET /api/opportunities/updates': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async () => { const updates = await listOpportunityUpdates(60); return json({ updates, meta: { build: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown', count: updates.length, supabaseHost: process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : 'not-configured' } }); }],
  'GET /api/opportunities/watchlists': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async ctx => { const u = await actor(ctx); const items = await listAll<Record<string, unknown>>('opportunity_watchlists'); return json({ watchlists: items.filter(x => x.userId === u.id).sort((a,b) => String(a.name).localeCompare(String(b.name))) }); }],
  'POST /api/opportunities/watchlists': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async ctx => { const u = await actor(ctx); const b = ctx.body as Record<string, unknown>; const name = text(b.name, 'title'); if (!name) return error('Watchlist name is required.', 400); const filters = b.filters && typeof b.filters === 'object' ? b.filters : {}; const [id] = await db.add('opportunity_watchlists', [{ userId: u.id, name, filters, createdAt: now(), updatedAt: now() }]); if (!id) return error('Could not save watchlist.', 500); return json({ watchlist: await getById<Record<string, unknown>>('opportunity_watchlists', id) }, 201); }],
  'DELETE /api/opportunities/watchlists/:id': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async ctx => { const u = await actor(ctx); const item = await getById<Record<string, unknown>>('opportunity_watchlists', ctx.params.id); if (!item || item.userId !== u.id) return error('Watchlist not found.', 404); await db.delete('opportunity_watchlists', [item.id]); return json({ ok: true }); }],
  'GET /api/opportunities/source-health': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async () => {
    const runs = await listAll<Record<string, unknown>>('opportunity_source_runs', 2000);
    const latest = new Map<string, Record<string, unknown>>();
    for (const run of runs.sort((a,b) => new Date(String(b.checkedAt || b.createdAt || 0)).getTime() - new Date(String(a.checkedAt || a.createdAt || 0)).getTime())) {
      const sourceId = String(run.sourceId || '');
      if (sourceId && !latest.has(sourceId)) latest.set(sourceId, run);
    }
    const nowMs = Date.now();
    return json({
      checkedAt: now(),
      sources: DISCOVERY_SOURCES.map(source => {
        const lastRun = latest.get(source.id) || null;
        const checkedAt = lastRun ? new Date(String(lastRun.checkedAt || lastRun.createdAt || 0)).getTime() : 0;
        const ageHours = checkedAt ? Math.max(0, Math.round(((nowMs - checkedAt) / 3600000) * 10) / 10) : null;
        const status = !lastRun ? 'never-checked'
          : String(lastRun.status) === 'error' ? 'failed'
          : ageHours !== null && ageHours > 48 ? 'stale'
          : Number(lastRun.fetchedCount || 0) === 0 ? 'success-empty'
          : 'healthy';
        return {
          ...source,
          health: status,
          ageHours,
          lastRun: lastRun ? {
            id: lastRun.id,
            status: lastRun.status,
            checkedAt: lastRun.checkedAt,
            fetchedCount: lastRun.fetchedCount,
            parsedCount: lastRun.parsedCount,
            relevantCount: lastRun.relevantCount,
            failedCount: lastRun.failedCount,
            durationMs: lastRun.durationMs,
            message: lastRun.message,
          } : null,
        };
      }),
    });
  }],
  'GET /api/opportunities/:id/changes': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async ctx => { const opportunity = await getById<Record<string, unknown>>('opportunity_updates', ctx.params.id); if (!opportunity) return error('Opportunity not found.', 404); const changes = await listAll<Record<string, unknown>>('opportunity_changes'); return json({ changes: changes.filter(x => x.opportunityUpdateId === opportunity.id).sort((a,b) => new Date(String(b.detectedAt)).getTime() - new Date(String(a.detectedAt)).getTime()).slice(0, 50) }); }],
  'GET /api/opportunities/:id': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async ctx => { const opportunity = await verifyOpportunity(ctx.params.id); if (!opportunity) return error('Opportunity not found.', 404); return json({ opportunity }); }],
  'POST /api/opportunities/scan': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async ctx => { if (!rateLimit(`scan:${ctx.user!.userId}`, RATE_LIMITS.scan)) return error('Source scanning is temporarily rate-limited. Try again in a few minutes.', 429); const sources = await discoverPlatformOpportunities(); await persistOpportunityUpdates(sources); const persisted = await listOpportunityUpdates(120); const missingDeadlines = persisted.filter(item => !item.deadline && item.state !== 'dismissed').slice(0, 30); for (const item of missingDeadlines) await verifyOpportunity(item.id); return json({ scannedAt: now(), sources }); }],
  'POST /api/opportunities/import': [requireAuth(), requireOrganisation(),requirePermission('bids.create'), async ctx => { const u = await actor(ctx); const b = ctx.body as Record<string, unknown>; const title = text(b.title, 'title'); const organisation = text(b.organisation, 'organisation', 'Unknown organisation'); const deadline = text(b.deadline, 'deadline'); const url = text(b.url, 'url'); const category = text(b.category, 'category', 'Other'); const reference = text(b.reference, 'reference'); if (!title || !deadline || !validDeadline(deadline)) return error('A valid title and deadline are required to import an opportunity.', 400); if (!validUrl(url)) return error('Only http and https source URLs are allowed.', 400); const cats = await listAll<{ name: string; active: boolean }>('categories'); if (!cats.some(c => c.active && c.name === category)) return error('Category is not active.', 400); const existing = await listAll<Tender>('tenders'); const duplicate = existing.find(t => (reference && t.reference && t.reference.toLowerCase() === reference.toLowerCase()) || (url && t.url && t.url === url)); if (duplicate) return json({ duplicate: true, tender: duplicate }); const [id] = await db.add('tenders', [{ title, organisation, reference, description: text(b.description, 'description'), deadline, source: text(b.source, 'source'), url, category, status: 'New', assigneeId: '', submittedBy: u.id, submittedAt: now(), notes: text(b.notes, 'notes'), revision: 1 }]); if (!id) return error('Could not import opportunity.', 500); const opportunityUpdateId = text(b.opportunityUpdateId, 'reference'); if (opportunityUpdateId) { const update = await getById<Record<string, unknown>>('opportunity_updates', opportunityUpdateId); if (update) await db.update('opportunity_updates', [{ id: update.id, record: { ...update, state: 'imported', importedTenderId: id, lastSeenAt: now() } }]); } await tenderLog(id, ctx, 'imported an opportunity', text(b.source, 'source')); return json({ duplicate: false, tender: await getById<Tender>('tenders', id) }, 201); }],
  'GET /api/kpis': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async ctx => { const u = await actor(ctx); return json({ kpis: await buildKpis(ctx, u) }); }],
  'GET /api/tenders': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async () => json({ tenders: (await listAll<Tender>('tenders')).map(t => ({ ...t, revision: Number(t.revision || 1) })) })],
  'GET /api/history': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async () => { const history = await listAll<BidHistory>('bid_history'); return json({ history: history.sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime()) }); }],
  'POST /api/tenders': [requireAuth(), requireOrganisation(),requirePermission('bids.create'), async ctx => { const u = await actor(ctx); const b = ctx.body as Record<string, unknown>; const title = text(b.title, 'title'); const organisation = text(b.organisation, 'organisation'); const deadline = text(b.deadline, 'deadline'); const url = text(b.url, 'url'); if (!title || !organisation || !deadline) return error('Title, organisation and deadline are required.', 400); if (!validDeadline(deadline)) return error('Deadline is invalid.', 400); if (!validUrl(url)) return error('Only http and https source URLs are allowed.', 400); const category = text(b.category, 'category', 'Other'); const cats = await listAll<{ name: string; active: boolean }>('categories'); if (!cats.some(c => c.active && c.name === category)) return error('Category is not active.', 400); const assigneeId = text(b.assigneeId, 'reference'); if (assigneeId && !(await activeOrganisationProfileIds(ctx)).has(assigneeId)) return error('The selected assignee is not an active member of this organisation.', 400); const [id] = await db.add('tenders', [{ title, organisation, reference: text(b.reference, 'reference'), description: text(b.description, 'description'), deadline, source: text(b.source, 'source'), url, category, status: 'New', assigneeId, submittedBy: u.id, submittedAt: now(), notes: text(b.notes, 'notes'), revision: 1 }]); if (!id) return error('Could not create tender.', 500); await tenderLog(id, ctx, 'created the bid'); return json({ tender: await getById<Tender>('tenders', id) }, 201); }],
  'PUT /api/tenders/:id': [requireAuth(), requireOrganisation(),async ctx => { const u = await actor(ctx); const b = ctx.body as Record<string, unknown>; const old = await requireTender(ctx.params.id); if (!old) return error('Bid not found.', 404); const currentRevision = Number(old.revision || 1); const expectedRevision = b.expectedRevision === undefined ? currentRevision : Number(b.expectedRevision); if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision) return error('This bid was changed by another user. Refresh the record before saving your changes.', 409); if (['Applied', 'Declined'].includes(old.status) && b.status !== undefined && String(b.status) !== old.status) return error('Closed bids cannot be reopened through ordinary editing.', 409); if (b.assigneeId !== undefined && !u.permissions.includes('bids.assign')) return error('You do not have permission to assign bids.', 403);
    if (b.assigneeId !== undefined && String(b.assigneeId) && !(await activeOrganisationProfileIds(ctx)).has(String(b.assigneeId))) return error('The selected assignee is not an active member of this organisation.', 400); const ordinaryKeys = Object.keys(b).filter(k => !['assigneeId', 'status'].includes(k)); if (ordinaryKeys.length && !u.permissions.includes('bids.edit')) return error('You do not have permission to edit bid data.', 403); if (b.status !== undefined && String(b.status) !== old.status) { const nextStatus = String(b.status); if (!validWorkflowTransition(old.status, nextStatus)) return error('Invalid workflow transition. Use the dedicated submission or decline action to close a bid.', 409); if (!['Applied', 'Declined'].includes(nextStatus) && !u.permissions.includes('bids.edit')) return error('You do not have permission to change workflow status.', 403); } const next = { ...old } as Record<string, unknown>; for (const k of ['title', 'organisation', 'reference', 'description', 'deadline', 'source', 'url', 'category', 'notes']) if (b[k] !== undefined) next[k] = text(b[k], k); if (b.deadline !== undefined && !validDeadline(String(next.deadline))) return error('Deadline is invalid.', 400); if (b.url !== undefined && !validUrl(String(next.url || ''))) return error('Only http and https source URLs are allowed.', 400); if (b.category !== undefined) { const cats = await listAll<{ name: string; active: boolean }>('categories'); if (!cats.some(c => c.name === String(next.category) && c.active)) return error('Category is not active.', 400); } if (b.assigneeId !== undefined) { next.assigneeId = text(b.assigneeId, 'reference'); if (next.assigneeId && !(await activeOrganisationProfileIds(ctx)).has(next.assigneeId)) return error('The task assignee is not an active member of this organisation.', 400); } if (b.status !== undefined) next.status = String(b.status); next.revision = currentRevision + 1; await db.update('tenders', [{ id: old.id, record: next }]); if (next.status !== old.status) await tenderLog(old.id, ctx, 'changed status', `${old.status} → ${next.status}`); if (next.assigneeId !== old.assigneeId) await tenderLog(old.id, ctx, 'changed the assignee'); return json({ tender: await getById<Tender>('tenders', old.id) }); }],
  'GET /api/tenders/:id/workspace': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async ctx => { const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); const [requirements, tasks] = await Promise.all([listAll<BidRequirement>('bid_requirements'), listAll<BidTask>('bid_tasks')]); return json({ qualification: tender.qualification || null, requirements: requirements.filter(x => x.tenderId === tender.id).sort((a,b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()), tasks: tasks.filter(x => x.tenderId === tender.id).sort((a,b) => new Date(a.dueAt || '9999').getTime() - new Date(b.dueAt || '9999').getTime()) }); }],
  'PUT /api/tenders/:id/qualification': [requireAuth(), requireOrganisation(),requirePermission('bids.edit'), async ctx => { const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); if (['Applied','Declined'].includes(tender.status)) return error('Closed bids cannot be qualified.', 409); const b = ctx.body as Record<string, unknown>; const decision = String(b.decision || 'undecided') as Qualification['decision']; if (!['undecided','bid','no-bid','needs-review'].includes(decision)) return error('Invalid bid decision.', 400); const criteria = (b.criteria && typeof b.criteria === 'object' ? b.criteria : {}) as Record<string, unknown>; const cleanCriteria: Record<string, number> = {}; for (const key of ['technicalCapability','relevantExperience','eligibility','financialCapacity','strategicValue','competition','deliveryCapability','deadlineFeasibility','partnershipRequirement']) { const value = Number(criteria[key] ?? 0); if (!Number.isInteger(value) || value < 0 || value > 5) return error('Qualification criteria must be scored from 0 to 5.', 400); cleanCriteria[key] = value; } const score = Math.round(Object.values(cleanCriteria).reduce((a,b)=>a+b,0) / Object.keys(cleanCriteria).length * 20); const u = await actor(ctx); const qualification: Qualification = { decision, score, criteria: cleanCriteria, notes: text(b.notes, 'notes'), updatedAt: now(), updatedBy: u.id }; const currentRevision = Number(tender.revision || 1); const expectedRevision = b.expectedRevision === undefined ? currentRevision : Number(b.expectedRevision); if (expectedRevision !== currentRevision) return error('This bid was changed by another user. Refresh the record before saving qualification.', 409); await db.update('tenders', [{ id: tender.id, record: { ...tender, qualification, revision: currentRevision + 1 } }]); await tenderLog(tender.id, ctx, 'updated bid qualification', decision === 'bid' ? 'Bid decision: pursue (' + score + '/100)' : decision === 'no-bid' ? 'Bid decision: no-bid (' + score + '/100)' : 'Bid decision: ' + decision + ' (' + score + '/100)'); return json({ qualification, tender: await requireTender(tender.id) }); }],
  'POST /api/tenders/:id/requirements': [requireAuth(), requireOrganisation(),requirePermission('bids.edit'), async ctx => { const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); const b = ctx.body as Record<string, unknown>; const title = text(b.title, 'title'); if (!title) return error('Requirement title is required.', 400); const status = String(b.status || 'open'); if (!['open','met','missing','needs-review'].includes(status)) return error('Invalid requirement status.', 400); const ownerId = text(b.ownerId, 'reference'); if (ownerId && !(await activeOrganisationProfileIds(ctx)).has(ownerId)) return error('The requirement owner is not an active member of this organisation.', 400); const [id] = await db.add('bid_requirements', [{ tenderId: tender.id, title, mandatory: Boolean(b.mandatory), status, evidence: text(b.evidence, 'notes'), ownerId, createdAt: now(), updatedAt: now() }]); if (!id) return error('Could not create requirement.', 500); await tenderLog(tender.id, ctx, 'added a bid requirement', title); return json({ requirement: await getById<BidRequirement>('bid_requirements', id) }, 201); }],
  'PUT /api/tenders/:id/requirements/:requirementId': [requireAuth(), requireOrganisation(),requirePermission('bids.edit'), async ctx => { const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); const requirement = await getById<BidRequirement>('bid_requirements', ctx.params.requirementId); if (!requirement || requirement.tenderId !== tender.id) return error('Requirement not found.', 404); const b = ctx.body as Record<string, unknown>; const next = { ...requirement }; if (b.title !== undefined) next.title = text(b.title, 'title'); if (b.mandatory !== undefined) next.mandatory = Boolean(b.mandatory); if (b.status !== undefined) { const status = String(b.status); if (!['open','met','missing','needs-review'].includes(status)) return error('Invalid requirement status.', 400); next.status = status as BidRequirement['status']; } if (b.evidence !== undefined) next.evidence = text(b.evidence, 'notes'); if (b.ownerId !== undefined) { next.ownerId = text(b.ownerId, 'reference'); if (next.ownerId && !(await activeOrganisationProfileIds(ctx)).has(next.ownerId)) return error('The requirement owner is not an active member of this organisation.', 400); } next.updatedAt = now(); await db.update('bid_requirements', [{ id: requirement.id, record: next }]); return json({ requirement: await getById<BidRequirement>('bid_requirements', requirement.id) }); }],
  'DELETE /api/tenders/:id/requirements/:requirementId': [requireAuth(), requireOrganisation(),requirePermission('bids.edit'), async ctx => { const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); const requirement = await getById<BidRequirement>('bid_requirements', ctx.params.requirementId); if (!requirement || requirement.tenderId !== tender.id) return error('Requirement not found.', 404); await db.delete('bid_requirements', [requirement.id]); await tenderLog(tender.id, ctx, 'removed a bid requirement', requirement.title); return json({ ok: true }); }],
  'POST /api/tenders/:id/tasks': [requireAuth(), requireOrganisation(),requirePermission('bids.edit'), async ctx => { const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); const b = ctx.body as Record<string, unknown>; const title = text(b.title, 'title'); if (!title) return error('Task title is required.', 400); const status = String(b.status || 'todo'); const priority = String(b.priority || 'medium'); const kind = String(b.kind || 'other'); if (!['todo','in-progress','done'].includes(status) || !['low','medium','high'].includes(priority) || !['internal-review','technical','financial','submission','other'].includes(kind)) return error('Invalid task fields.', 400); const assigneeId = text(b.assigneeId, 'reference'); if (assigneeId && !(await activeOrganisationProfileIds(ctx)).has(assigneeId)) return error('The task assignee is not an active member of this organisation.', 400); const dueAt = text(b.dueAt, 'deadline'); if (dueAt && !validDeadline(dueAt)) return error('Task due date is invalid.', 400); const [id] = await db.add('bid_tasks', [{ tenderId: tender.id, title, assigneeId, dueAt, status, priority, kind, createdAt: now(), updatedAt: now() }]); if (!id) return error('Could not create task.', 500); await tenderLog(tender.id, ctx, 'added a bid task', title); return json({ task: await getById<BidTask>('bid_tasks', id) }, 201); }],
  'PUT /api/tenders/:id/tasks/:taskId': [requireAuth(), requireOrganisation(),requirePermission('bids.edit'), async ctx => { const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); const task = await getById<BidTask>('bid_tasks', ctx.params.taskId); if (!task || task.tenderId !== tender.id) return error('Task not found.', 404); const b = ctx.body as Record<string, unknown>; const next = { ...task }; if (b.title !== undefined) next.title = text(b.title, 'title'); if (b.assigneeId !== undefined) next.assigneeId = text(b.assigneeId, 'reference'); if (b.dueAt !== undefined) { next.dueAt = text(b.dueAt, 'deadline'); if (next.dueAt && !validDeadline(next.dueAt)) return error('Task due date is invalid.', 400); } if (b.status !== undefined) { const s=String(b.status); if (!['todo','in-progress','done'].includes(s)) return error('Invalid task status.', 400); next.status=s as BidTask['status']; } if (b.priority !== undefined) { const p=String(b.priority); if (!['low','medium','high'].includes(p)) return error('Invalid task priority.', 400); next.priority=p as BidTask['priority']; } if (b.kind !== undefined) { const k=String(b.kind); if (!['internal-review','technical','financial','submission','other'].includes(k)) return error('Invalid task kind.', 400); next.kind=k as BidTask['kind']; } next.updatedAt=now(); await db.update('bid_tasks',[{id:task.id,record:next}]); return json({task:await getById<BidTask>('bid_tasks',task.id)}); }],
  'DELETE /api/tenders/:id/tasks/:taskId': [requireAuth(), requireOrganisation(),requirePermission('bids.edit'), async ctx => { const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); const task = await getById<BidTask>('bid_tasks', ctx.params.taskId); if (!task || task.tenderId !== tender.id) return error('Task not found.', 404); await db.delete('bid_tasks',[task.id]); await tenderLog(tender.id,ctx,'removed a bid task',task.title); return json({ok:true}); }],
  'DELETE /api/tenders/:id': [requireAuth(), requireOrganisation(),requirePermission('bids.delete'), async ctx => { const u = await actor(ctx); const old = await requireTender(ctx.params.id); if (!old) return error('Bid not found.', 404); const attachments = await listAll<{ id: string; tenderId: string; path: string }>('attachments'); const owned = attachments.filter(a => a.tenderId === old.id); const archived: Omit<BidHistory, 'id'> = { originalTenderId: old.id, title: old.title, organisation: old.organisation, reference: old.reference, description: old.description, deadline: old.deadline, source: old.source, url: old.url, category: old.category, status: old.status, assigneeId: old.assigneeId, submittedBy: old.submittedBy, submittedAt: old.submittedAt, notes: old.notes, submissionReference: old.submissionReference, submissionMethod: old.submissionMethod, submissionReceiptUrl: old.submissionReceiptUrl, submissionNotes: old.submissionNotes, appliedBy: old.appliedBy, appliedAt: old.appliedAt, deletedBy: u.id, deletedAt: now(), attachmentCount: owned.length }; const [historyId] = await db.add('bid_history', [archived]); if (!historyId) return error('Could not preserve the bid history. The bid was not deleted.', 500); if (owned.length) { const deleted = await storageService.delete(owned.map(a => a.path)); if (deleted.some(ok => !ok)) { await db.delete('bid_history', [historyId]); return error('Could not remove all bid documents. The bid was not deleted.', 500); } await db.delete('attachments', owned.map(a => a.id)); } await db.delete('tenders', [old.id]); return json({ ok: true, deletedAttachments: owned.length, historyId }); }],
  'POST /api/tenders/:id/apply': [requireAuth(), requireOrganisation(),requirePermission('bids.apply'), async ctx => { const u = await actor(ctx); const old = await requireTender(ctx.params.id); if (!old) return error('Bid not found.', 404); if (['Applied', 'Declined'].includes(old.status)) return error('This bid is already closed.', 409); const b = ctx.body as Record<string, unknown>; const currentRevision = Number(old.revision || 1); const expectedRevision = b.expectedRevision === undefined ? currentRevision : Number(b.expectedRevision); if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision) return error('This bid was changed by another user. Refresh the record before recording the submission.', 409); const submissionReference = text(b.submissionReference, 'submissionReference'); const submissionMethod = text(b.submissionMethod, 'title'); const submissionReceiptUrl = text(b.submissionReceiptUrl, 'url'); const submissionNotes = text(b.submissionNotes, 'notes'); if (old.status !== 'Ready to Submit') return error('A bid must reach Ready to Submit before it can be recorded as submitted.', 409); if (!submissionMethod) return error('Submission method is required.', 400); if (!validUrl(submissionReceiptUrl)) return error('Submission receipt URL must use http or https.', 400); if (!submissionReference && !submissionReceiptUrl && !submissionNotes) return error('Submission evidence is required: provide a confirmation/reference, receipt URL, or submission notes.', 400); const next = { ...old, status: 'Applied', appliedBy: u.id, appliedAt: now(), submissionReference, submissionMethod, submissionReceiptUrl, submissionNotes, revision: currentRevision + 1 }; await db.update('tenders', [{ id: old.id, record: next }]); await tenderLog(old.id, ctx, 'marked the bid Applied', [submissionMethod, submissionReference, submissionReceiptUrl].filter(Boolean).join(' · ')); return json({ tender: next }); }],
  'POST /api/tenders/:id/decline': [requireAuth(), requireOrganisation(),requirePermission('bids.decline'), async ctx => { const old = await requireTender(ctx.params.id); if (!old) return error('Bid not found.', 404); if (['Applied', 'Declined'].includes(old.status)) return error('This bid is already closed.', 409); const b = ctx.body as Record<string, unknown>; const currentRevision = Number(old.revision || 1); const expectedRevision = b.expectedRevision === undefined ? currentRevision : Number(b.expectedRevision); if (!Number.isInteger(expectedRevision) || expectedRevision !== currentRevision) return error('This bid was changed by another user. Refresh the record before declining it.', 409); await db.update('tenders', [{ id: old.id, record: { ...old, status: 'Declined', revision: currentRevision + 1 } }]); await tenderLog(old.id, ctx, 'marked the bid Declined'); return json({ tender: await getById<Tender>('tenders', old.id) }); }],
  'GET /api/tenders/:id/attachments': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async ctx => { const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); const a = await listAll<{ tenderId: string; filename: string; mimeType: string; size: number; path: string; uploadedBy: string; uploadedAt: string }>('attachments'); return json({ attachments: a.filter(x => x.tenderId === tender.id) }); }],
  'POST /api/tenders/:id/attachments': [requireAuth(), requireOrganisation(),requirePermission('attachments.upload'), async ctx => { const u = await actor(ctx); const tender = await requireTender(ctx.params.id); if (!tender) return error('Bid not found.', 404); const b = ctx.body as Record<string, unknown>; if (!rateLimit(`upload:${ctx.user!.userId}`, RATE_LIMITS.upload)) return error('Upload rate limit reached. Try again in a few minutes.', 429); const filename = String(b.filename || '').trim(); const mimeType = String(b.mimeType || 'application/octet-stream').toLowerCase(); const size = Number(b.size || 0); const content = String(b.content || ''); const validationError = validateUpload(filename, mimeType, size, content); if (validationError) return error(validationError, 400); const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_'); const path = `organisations/${ctx.organisation!.id}/tenders/${tender.id}/${crypto.randomUUID()}-${safeName}`; const ok = await storageService.put(path, content, mimeType); if (!ok) return error('File upload failed.', 500); const [id] = await db.add('attachments', [{ tenderId: tender.id, filename, mimeType, size, path, uploadedBy: u.id, uploadedAt: now() }]); if (!id) { await storageService.delete([path]); return error('Could not save attachment metadata.', 500); } await tenderLog(tender.id, ctx, 'uploaded an attachment', filename); return json({ attachment: { id, filename } }, 201); }],
  'GET /api/attachments/:id/url': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async ctx => { const a = await getById<{ tenderId: string; path: string }>('attachments', ctx.params.id); if (!a || !(await requireTender(a.tenderId))) return error('Attachment not found.', 404); const url = await storageService.getUrl(a.path); return json({ url }); }],
  'DELETE /api/attachments/:id': [requireAuth(), requireOrganisation(),requirePermission('attachments.delete'), async ctx => { const a = await getById<{ tenderId: string; path: string; filename: string }>('attachments', ctx.params.id); if (!a) return error('Attachment not found.', 404); if (!(await requireTender(a.tenderId))) return error('Attachment not found.', 404); const [deleted] = await storageService.delete([a.path]); if (!deleted) return error('Could not delete the stored document.', 500); await db.delete('attachments', [ctx.params.id]); await tenderLog(a.tenderId, ctx, 'deleted an attachment', a.filename); return json({ ok: true }); }],
  'GET /api/tenders/:id/activity': [requireAuth(), requireOrganisation(),requirePermission('bids.view'), async ctx => { if (!(await requireTender(ctx.params.id))) return error('Bid not found.', 404); const a = await listAll<{ tenderId: string; actorName: string; action: string; detail: string; createdAt: string }>('activity'); return json({ activities: a.filter(x => x.tenderId === ctx.params.id).sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime()) }); }],
  'GET /api/notifications': [requireAuth(), requireOrganisation(),requirePermission('notifications.view'), async ctx => { const n = await listAll<{ userId: string; title: string; body: string; read: boolean; createdAt: string }>('notifications'); return json({ notifications: n.filter(x => x.userId === ctx.user!.userId).sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime()) }); }],
  'POST /api/notifications/:id/read': [requireAuth(), requireOrganisation(),requirePermission('notifications.view'), async ctx => { const n = await getById<{ userId: string; read: boolean }> ('notifications', ctx.params.id); if (!n || n.userId !== ctx.user!.userId) return error('Notification not found.', 404); await db.update('notifications', [{ id: n.id, record: { ...n, read: true } }]); return json({ ok: true }); }], 'POST /api/notifications/read-all': [requireAuth(), requireOrganisation(),requirePermission('notifications.view'), async ctx => { const notes = await listAll<{ userId: string; read: boolean }>('notifications'); const mine = notes.filter(n => n.userId === ctx.user!.userId && !n.read); if (mine.length) await db.update('notifications', mine.map(n => ({ id: n.id, record: { ...n, read: true } }))); return json({ ok: true }); }], 'DELETE /api/notifications': [requireAuth(), requireOrganisation(),requirePermission('notifications.view'), async ctx => { const notes = await listAll<{ userId: string }>('notifications'); const mine = notes.filter(n => n.userId === ctx.user!.userId); if (mine.length) await db.delete('notifications', mine.map(n => n.id)); return json({ ok: true }); }],
    'GET /api/admin/users': [requireAuth(), requireOrganisation(), requirePermission('users.view'), async ctx => json({ users: await listCurrentOrganisationMembers(ctx) })],
    'POST /api/admin/users': [requireAuth(), requireOrganisation(), requirePermission('users.manage'), async () => error('Member invitations are temporarily unavailable while organisation membership management is being migrated.', 409)],
    'PUT /api/admin/users/:id': [requireAuth(), requireOrganisation(), requirePermission('users.manage'), async () => error('Member access changes are temporarily unavailable while organisation membership management is being migrated.', 409)],
    'GET /api/admin/roles': [requireAuth(), requireOrganisation(), requirePermission('roles.view'), async ctx => json({ roles: await listCurrentOrganisationRoles(ctx), permissions: PERMISSIONS })],
    'POST /api/admin/roles': [requireAuth(), requireOrganisation(), requirePermission('roles.manage'), async () => error('Organisation role changes are temporarily unavailable while relational role management is being completed.', 409)],
    'PUT /api/admin/roles/:id': [requireAuth(), requireOrganisation(), requirePermission('roles.manage'), async () => error('Organisation role changes are temporarily unavailable while relational role management is being completed.', 409)],
    'DELETE /api/admin/roles/:id': [requireAuth(), requireOrganisation(), requirePermission('roles.manage'), async () => error('Organisation role changes are temporarily unavailable while relational role management is being completed.', 409)],
  'GET /api/admin/categories': [requireAuth(), requireOrganisation(),requirePermission('categories.manage'), async () => json({ categories: await listAll<{ name: string; active: boolean; createdAt: string }>('categories') })],
  'POST /api/admin/categories': [requireAuth(), requireOrganisation(),requirePermission('categories.manage'), async ctx => { const name = text((ctx.body as Record<string, unknown>).name, 'category'); if (!name) return error('Category name is required.', 400); const cats = await listAll<{ name: string; active: boolean }>('categories'); if (cats.some(x => x.name.toLowerCase() === name.toLowerCase())) return error('That category already exists.', 409); const [id] = await db.add('categories', [{ name, active: true, createdAt: now() }]); return json({ category: await getById('categories', id || '') }, 201); }],
  'PUT /api/admin/categories/:id': [requireAuth(), requireOrganisation(),requirePermission('categories.manage'), async ctx => { const old = await getById<{ name: string; active: boolean }>('categories', ctx.params.id); if (!old) return error('Category not found.', 404); const b = ctx.body as Record<string, unknown>; const next = { ...old, name: text(b.name, 'category', old.name), active: b.active === undefined ? old.active : Boolean(b.active) }; await db.update('categories', [{ id: old.id, record: next }]); return json({ category: next }); }],
  'GET /api/admin/audit': [requireAuth(), requireOrganisation(),requirePermission('audit.view'), async () => json({ events: (await listAll<Record<string, string>>('security_activity')).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()).slice(0, 200) })],
  'GET /api/admin/storage': [requireAuth(), requireOrganisation(),requirePermission('settings.manage'), async ctx => json(await storageStats(ctx))],
  'POST /api/admin/storage/cleanup': [requireAuth(), requireOrganisation(),requireSuperAdmin(), async ctx => { const attachments = await listAll<{ path: string }>('attachments'); const tracked = new Set(attachments.map(a => a.path)); const prefix = `organisations/${ctx.organisation!.id}/tenders/`; const listed = await storageService.listAll(prefix, 10000); const orphaned = listed.paths.filter(path => !tracked.has(path)); if (orphaned.length) { const deleted = await storageService.delete(orphaned); if (deleted.some(ok => !ok)) return error('Some orphaned files could not be removed.', 500); } return json({ ok: true, deleted: orphaned.length }); }],
});