import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { api, auth } from './platform';
import {
  Archive,
  Bell,
  CalendarDays,
  Check,
  CheckCheck,
  ChevronLeft,
  ClipboardList,
  FileText,
  Globe2,
  LayoutDashboard,
  LogOut,
  Menu,
  MoreVertical,
  Paperclip,
  Plus,
  Search,
  Settings,
  Shield,
  UserCircle,
  Info,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
const AdminPanel = lazy(() => import('./AdminPanel'));
import { cachedGet, clearApiCache, invalidateApiCache } from './api-cache';
import { applySeo } from './seo';
import Opportunities from './Opportunities';

type Role = 'Member' | 'Authorised' | 'Admin';
type Status =
  | 'New'
  | 'Reviewing'
  | 'Pursuing'
  | 'Preparing'
  | 'Ready to Submit'
  | 'Applied'
  | 'Declined';
type Tender = {
  id: string;
  title: string;
  organisation: string;
  reference?: string;
  description?: string;
  deadline: string;
  source?: string;
  url?: string;
  category?: string;
  status: Status;
  assigneeId?: string;
  submittedBy: string;
  submittedAt: string;
  notes?: string;
  submissionReference?: string;
  appliedBy?: string;
  appliedAt?: string;
  revision?: number;
};
type Attachment = {
  id: string;
  tenderId: string;
  filename: string;
  mimeType: string;
  size: number;
  path: string;
  uploadedBy: string;
  uploadedAt: string;
};
type Activity = {
  id: string;
  tenderId: string;
  actorName: string;
  action: string;
  detail?: string;
  createdAt: string;
};
type User = {
  id: string;
  email: string;
  name: string;
  role: string;
  onboardingCompleted?: boolean;
  roleId?: string;
  permissions?: string[];
  canMarkApplied?: boolean;
  active: boolean;
  status?: string;
  lastSeenAt?: string;
};
type Notice = {
  id: string;
  title: string;
  body: string;
  read: boolean;
  createdAt: string;
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
  alsoListedOn?: string[];
  state: 'new' | 'imported' | 'dismissed';
  firstSeenAt: string;
  lastSeenAt: string;
  importedTenderId?: string;
};
type BidHistory = {
  id: string;
  originalTenderId: string;
  title: string;
  organisation: string;
  reference: string;
  description: string;
  deadline: string;
  source: string;
  url: string;
  category: string;
  status: string;
  submittedAt: string;
  notes: string;
  submissionReference?: string;
  appliedAt?: string;
  deletedAt: string;
  attachmentCount: number;
};

const STATUSES: Status[] = [
  'New',
  'Reviewing',
  'Pursuing',
  'Preparing',
  'Ready to Submit',
  'Applied',
  'Declined',
];
const CATEGORIES = [
  'Cybersecurity',
  'Software Development',
  'ICT Infrastructure',
  'IT Support',
  'Data & Analytics',
  'Consulting',
  'Other',
];
const ACCEPT =
  '.pdf,.doc,.docx,.xls,.xlsx,.csv,.ppt,.pptx,.png,.jpg,.jpeg,.txt,.zip';

function urgency(deadline: string) {
  const diff = new Date(deadline).getTime() - Date.now();
  const days = Math.ceil(diff / 86400000);
  if (diff < 0) return { label: 'Overdue', tone: 'danger' };
  if (days <= 1)
    return { label: days === 0 ? 'Due today' : 'Due tomorrow', tone: 'danger' };
  if (days <= 3) return { label: `Due in ${days} days`, tone: 'danger' };
  if (days <= 7) return { label: `Due in ${days} days`, tone: 'warn' };
  if (days <= 14) return { label: `Due in ${days} days`, tone: 'neutral' };
  return { label: `Due in ${days} days`, tone: 'muted' };
}
function fmtDate(v?: string) {
  return v
    ? new Date(v).toLocaleString([], {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : '—';
}
function initials(name: string) {
  return name
    .split(' ')
    .map(x => x[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
}

function routeFromHash() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const parts = raw.split('/').filter(Boolean);
  const first = parts[0] || 'dashboard';
  if (first === 'bids' && parts[1]) return { view: 'bids', tenderId: parts[1] };
  if (first === 'bids') return { view: 'bids' };
  if (first === 'history') return { view: 'history' };
  if (first === 'mine') return { view: 'mine' };
  if (first === 'notifications') return { view: 'notifications' };
  if (first === 'opportunities') return { view: 'opportunities' };
  if (first === 'insights') return { view: 'insights' };
  if (first === 'add') return { view: 'add' };
  if (first === 'profile') return { view: 'profile' }; if (first === 'settings') return { view: 'settings' }; if (first === 'about') return { view: 'about' }; if (first === 'admin') return { view: 'admin', adminTab: parts[1] || 'users' };
  return { view: 'dashboard' };
}

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [profile, setProfile] = useState<User | null>(null);
  const [view, setView] = useState(() => routeFromHash().view);
  const [adminTab, setAdminTab] = useState(() => routeFromHash().adminTab || 'users');
  const [tenders, setTenders] = useState<Tender[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<any[]>([]);
  const [permissionMeta, setPermissionMeta] = useState<any[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [categoryRecords, setCategoryRecords] = useState<Array<{id:string;name:string;active:boolean}>>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [opportunityUpdates, setOpportunityUpdates] = useState<OpportunityUpdate[]>([]);
  const [history, setHistory] = useState<BidHistory[]>([]);
  const [selected, setSelected] = useState<Tender | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [categoryFilter, setCategoryFilter] = useState('All');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const [noticeKind, setNoticeKind] = useState<'success' | 'error' | 'warning'>('error');
  function showNotice(message: string, kind?: 'success' | 'error' | 'warning') {
    const inferred = kind || (/failed|could not|cannot|denied|invalid|error|not found|suspended/i.test(message) ? 'error' : 'success');
    setNoticeKind(inferred);
    setNotice(message);
  }
  const [mobileNav, setMobileNav] = useState(false);
  const [kpis, setKpis] = useState<Record<string, any>>({});
  const [showOnboarding, setShowOnboarding] = useState(false); const [showNotifications, setShowNotifications] = useState(false); const [showProfileMenu, setShowProfileMenu] = useState(false); const profileMenuRef = useRef<HTMLDivElement>(null); const notificationRef = useRef<HTMLDivElement>(null);

  const refreshInFlight = useRef<Promise<void> | null>(null);

  async function refresh(force = false) {
    if (force) invalidateApiCache();
    if (refreshInFlight.current) return refreshInFlight.current;

    const run = (async () => {
      try {
        const [me, ts, cfg, historyResponse, opportunityResponse, kpiResponse] = await Promise.all([
          cachedGet('/api/me', 10000),
          cachedGet('/api/tenders', 5000),
          cachedGet('/api/config', 300000),
          cachedGet('/api/history', 15000),
          cachedGet('/api/opportunities/updates', 15000),
          cachedGet('/api/kpis', 15000),
        ]);
        setLoadError('');
        setProfile(me.data.user);
        setShowOnboarding(me.data.user.onboardingCompleted !== true);
        setTenders(ts.data.tenders);
        setHistory(historyResponse.data.history || []);
        setOpportunityUpdates((opportunityResponse.data.updates || []).filter((item: OpportunityUpdate) => item.state !== 'dismissed'));
        if (me.data.user.permissions?.includes('notifications.view')) {
          try {
            const ns = await cachedGet('/api/notifications', 10000);
            setNotices(ns.data.notifications || []);
          } catch {
            setNotices([]);
          }
        } else {
          setNotices([]);
        }
        setKpis(kpiResponse.data.kpis || {});
        setCategories(cfg.data.categories);
        setCategoryRecords(cfg.data.categoryRecords || []);
        if (me.data.user.permissions?.includes('users.view')) {
          const adminUsers = await cachedGet('/api/admin/users', 30000);
          setUsers(adminUsers.data.users);
        }
        if (me.data.user.permissions?.includes('roles.view')) {
          const access = (await cachedGet('/api/admin/roles', 30000)).data;
          setRoles(access.roles);
          setPermissionMeta(access.permissions);
        }
      } catch (e: any) {
        const message = e?.status >= 500 ? 'BidWatch is temporarily unavailable. Please try again.' : e?.message || 'Could not load BidWatch.';
        setLoadError(message);
        showNotice(message, 'error');
      } finally {
        setLoading(false);
      }
    })();

    refreshInFlight.current = run;
    try {
      await run;
    } finally {
      if (refreshInFlight.current === run) refreshInFlight.current = null;
    }
  }
  useEffect(() => {
    (async () => {
      try {
        const u = await auth.getUser();
        if (u) setUser(u);
        else setLoading(false);
      } catch {
        setLoading(false);
      }
    })();
  }, []);
  useEffect(() => {
    if (user) refresh();
  }, [user]);
  useEffect(() => {
    applySeo(view, Boolean(user), selected?.title);
  }, [view, user, selected?.title]);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (showProfileMenu && profileMenuRef.current && !profileMenuRef.current.contains(target)) setShowProfileMenu(false);
      if (showNotifications && notificationRef.current && !notificationRef.current.contains(target)) setShowNotifications(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showProfileMenu, showNotifications]);
  useEffect(() => { const onHashChange = () => {
      const route = routeFromHash();
      setView(route.view);
      setAdminTab(route.adminTab || 'users');
      if (route.view !== 'bids' || !route.tenderId) setSelected(null);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
  useEffect(() => {
    const route = routeFromHash();
    if (route.tenderId && tenders.length && !selected) {
      const tender = tenders.find(t => t.id === route.tenderId);
      if (tender) openTender(tender, false);
    }
  }, [tenders, selected]);
  function navigate(path: string) {
    window.location.hash = path.startsWith('#') ? path : `#/${path.replace(/^\//, '')}`;
  }

  async function signIn() {
    try {
      await auth.signIn();
    } catch (e: any) {
      setNotice(
        e?.code === 'popup_blocked'
          ? 'Allow popups to sign in.'
          : e?.code === 'popup_closed'
            ? 'Sign-in cancelled.'
            : 'Sign-in failed.'
      );
    }
  }
  async function signOut() {
    await auth.signOut();
    clearApiCache();
    setUser(null);
    setProfile(null);
    setShowOnboarding(false);
  }
  async function finishOnboarding() {
    try {
      await api.put('/api/me/onboarding', { completed: true });
      setShowOnboarding(false);
      showNotice('You are ready to use BidWatch.', 'success');
    } catch {
      setShowOnboarding(false);
      showNotice('Your introduction could not be saved. You can continue using BidWatch.', 'warning');
    }
  }

  const filtered = useMemo(
    () =>
      tenders
        .filter(t => {
          const q = query.toLowerCase();
          const matchesQ =
            !q ||
            [t.title, t.organisation, t.reference, t.description]
              .join(' ')
              .toLowerCase()
              .includes(q);
          return (
            matchesQ &&
            (statusFilter === 'All' || t.status === statusFilter) &&
            (categoryFilter === 'All' || t.category === categoryFilter)
          );
        })
        .sort(
          (a, b) =>
            new Date(a.deadline).getTime() - new Date(b.deadline).getTime()
        ),
    [tenders, query, statusFilter, categoryFilter]
  );

  async function openTender(t: Tender, push = true) {
    if (push) navigate(`bids/${t.id}`);
    setView('bids');
    setSelected(t);
    const [a, h] = await Promise.all([
      cachedGet(`/api/tenders/${t.id}/attachments`, 10000),
      cachedGet(`/api/tenders/${t.id}/activity`, 10000),
    ]);
    setAttachments(a.data.attachments);
    setActivities(h.data.activities);
  }
  async function markRead(id: string) {
    try {
      await api.post(`/api/notifications/${id}/read`, {});
      invalidateApiCache(['/api/notifications']);
      setNotices(n => n.map(x => (x.id === id ? { ...x, read: true } : x)));
    } catch {
      showNotice('Could not update the notification. Please try again.', 'error');
    }
  }
  async function markAllRead() {
    try {
      await api.post('/api/notifications/read-all', {});
      invalidateApiCache(['/api/notifications']);
      setNotices(n => n.map(x => ({ ...x, read: true })));
    } catch {
      showNotice('Could not mark notifications as read. Please try again.', 'error');
    }
  }
  async function clearNotifications() {
    try {
      await api.delete('/api/notifications');
      invalidateApiCache(['/api/notifications']);
      setNotices([]);
      setShowNotifications(false);
    } catch {
      showNotice('Could not clear notifications. Please try again.', 'error');
    }
  }

  if (!user) return <AuthScreen onSignIn={signIn} notice={notice} />;
  if (loading) return <div className="loading">Loading BidWatch…</div>;
  if (!profile) return <ErrorState message={loadError || 'We could not load your BidWatch profile.'} onRetry={refresh} />;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">B</div>
          <div>
            <strong>BidWatch</strong>
            <span>Internal bid tracker</span>
          </div>
        </div>
        <div className="top-actions">
          <div className="top-popover" ref={notificationRef}>
            <button
              className="icon-btn notification-trigger"
              onClick={() => { setShowNotifications(value => !value); setShowProfileMenu(false); }}
              aria-label={`Notifications${notices.filter(n => !n.read).length ? `, ${notices.filter(n => !n.read).length} unread` : ''}`}
              aria-expanded={showNotifications}
              aria-haspopup="dialog"
            >
              <Bell size={19} />
              {notices.filter(n => !n.read).length > 0 && <em className="notification-count">{notices.filter(n => !n.read).length > 99 ? '99+' : notices.filter(n => !n.read).length}</em>}
            </button>
            {showNotifications && (
              <NotificationPopover notices={notices} onRead={markRead} onReadAll={markAllRead} onClear={clearNotifications} />
            )}
          </div>
          <div className="top-popover" ref={profileMenuRef}>
            <button
              className="user-chip user-menu-trigger"
              onClick={() => { setShowProfileMenu(value => !value); setShowNotifications(false); }}
              aria-expanded={showProfileMenu}
              aria-haspopup="menu"
            >
              <span>{initials(profile.name || user.name || user.email)}</span>
              <div>
                <b>{profile.name || user.name}</b>
                <small>{profile.role}</small>
              </div>
              <ChevronLeft size={14} className="profile-chevron" />
            </button>
            {showProfileMenu && (
              <div className="profile-menu" role="menu">
                <div className="profile-menu-header"><span>{initials(profile.name || user.name || user.email)}</span><div><b>{profile.name || user.name}</b><small>{profile.email}</small></div></div>
                <div className="profile-menu-divider" />
                <button role="menuitem" onClick={() => { setShowProfileMenu(false); navigate('profile'); }}><UserCircle size={17} /><span>Profile</span></button>
                <button role="menuitem" onClick={() => { setShowProfileMenu(false); navigate('settings'); }}><Settings size={17} /><span>Settings</span></button>
                <button role="menuitem" onClick={() => { setShowProfileMenu(false); navigate('about'); }}><Info size={17} /><span>About BidWatch</span></button>
                <div className="profile-menu-divider" />
                <button className="profile-menu-danger" role="menuitem" onClick={() => { setShowProfileMenu(false); void signOut(); }}><LogOut size={17} /><span>Log out</span></button>
              </div>
            )}
          </div>
        </div>
        <button
          className="mobile-menu icon-btn"
          onClick={() => setMobileNav(!mobileNav)}
        >
          <Menu size={20} />
        </button>
      </header>
      <div className="body-shell">
        {mobileNav && <button className="mobile-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNav(false)} />}        <aside className={mobileNav ? 'sidebar open' : 'sidebar'}>
          <nav>
            <NavItem
              icon={<LayoutDashboard size={18} />}
              label="Dashboard"
              active={view === 'dashboard'}
              onClick={() => {
                navigate('dashboard');
                setMobileNav(false);
              }}
            />
            <NavItem
              icon={<ClipboardList size={18} />}
              label="All Bids"
              active={view === 'bids'}
              onClick={() => {
                navigate('bids');
                setMobileNav(false);
              }}
            />
            <NavItem
              icon={<Globe2 size={18} />}
              label="Find Opportunities"
              active={view === 'opportunities'}
              onClick={() => {
                navigate('opportunities');
                setMobileNav(false);
              }}
            />
            <NavItem
              icon={<Archive size={18} />}
              label="Bid History"
              active={view === 'history'}
              onClick={() => {
                navigate('history');
                setMobileNav(false);
              }}
            />
            <NavItem
              icon={<CalendarDays size={18} />}
              label="My Tenders"
              active={view === 'mine'}
              onClick={() => {
                navigate('mine');
                setMobileNav(false);
              }}
            />
            {profile.permissions?.some((p: string) => p.startsWith('kpis.view.')) && (
              <NavItem
                icon={<ClipboardList size={18} />}
                label="Insights"
                active={view === 'insights'}
                onClick={() => {
                  navigate('insights');
                  setMobileNav(false);
                }}
              />
            )}
            {(profile.permissions?.includes('users.view') || profile.permissions?.includes('roles.view') || profile.permissions?.includes('categories.manage')) && (
              <>
                <div className="nav-label">Access & configuration</div>
                {(profile.permissions?.includes('users.view') || profile.permissions?.includes('roles.view')) && (
                  <NavItem
                    icon={<Shield size={18} />}
                    label="Administration"
                    active={view === 'admin'}
                    onClick={() => {
                      navigate('admin/users');
                      setMobileNav(false);
                    }}
                  />
                )}
              </>
            )}
          </nav>
          <div className="sidebar-foot">
            <Shield size={16} />
            <span>Access controlled</span>
          </div>
        </aside>
        <main className="main">
          {notice && (
            <div className={`toast ${noticeKind}`} role="alert" aria-live="assertive">
              <span>{notice}</span>
              <button aria-label="Dismiss message" onClick={() => setNotice('')}>
                <X size={15} />
              </button>
            </div>
          )}
          {view === 'dashboard' && (
            <Dashboard
              tenders={tenders}
              profile={profile}
              onOpen={openTender}
              onAdd={() => navigate('add')}
              opportunityUpdates={opportunityUpdates}
            />
          )}
          {view === 'insights' && (
            <Insights kpis={kpis} />
          )}
          {view === 'opportunities' && (
            <Opportunities onImported={() => { invalidateApiCache(['/api/tenders', '/api/kpis']); void refresh(true); }} />
          )}
          {view === 'bids' && (
            <BidList
              tenders={filtered}
              query={query}
              setQuery={setQuery}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              categoryFilter={categoryFilter}
              setCategoryFilter={setCategoryFilter}
              onOpen={openTender}
              onAdd={() => navigate('add')}
            />
          )}
          {view === 'history' && <HistoryView history={history} />}
          {view === 'mine' && (
            <BidList
              tenders={filtered.filter(
                t => t.assigneeId === profile.id || t.submittedBy === profile.id
              )}
              query={query}
              setQuery={setQuery}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              categoryFilter={categoryFilter}
              setCategoryFilter={setCategoryFilter}
              onOpen={openTender}
              onAdd={() => navigate('add')}
              title="My Tenders"
            />
          )}
          {view === 'add' && (
            <TenderForm
              users={users.length ? users : [profile]}
              onCancel={() => setView('bids')}
              onSaved={async () => {
                invalidateApiCache(['/api/tenders', '/api/history', '/api/kpis', '/api/tenders/']);
                await refresh(true);
                navigate('bids');
              }}
            />
          )}
          {view === 'profile' && <ProfileView profile={profile} onSaved={async () => { await refresh(); }} setNotice={showNotice} />} {view === 'settings' && <SettingsView setNotice={showNotice} />} {view === 'about' && <AboutView />} {view === 'admin' && (profile.permissions?.includes('users.view') || profile.permissions?.includes('roles.view')) && (
            <Suspense fallback={<div className="panel" aria-live="polite">Loading administration…</div>}>
              <AdminPanel
                users={users}
              roles={roles}
              permissions={permissionMeta}
              profile={{ email: profile.email, role: profile.role, permissions: profile.permissions || [] }}
              categories={categoryRecords}
              initialTab={adminTab as any}
              onTabChange={(tab) => navigate(`admin/${tab}`)}
                onRefresh={() => refresh(true)}
                setNotice={showNotice}
              />
            </Suspense>
          )}
        </main>
      </div>
      {showOnboarding && (
        <OnboardingDialog onFinish={finishOnboarding} />
      )}
      {selected && (
        <TenderDrawer
          tender={selected}
          profile={profile}
          users={users.length ? users : [profile]}
          attachments={attachments}
          activities={activities}
              onClose={() => {
                setSelected(null);
                navigate('bids');
              }}
              onChanged={async () => {
            await refresh();
            const fresh = tenders.find(t => t.id === selected.id);
            if (fresh) await openTender(fresh, false);
          }}
          setNotice={showNotice}
        />
      )}
    </div>
  );
}

function OnboardingDialog({ onFinish }: { onFinish: () => Promise<void> }) {
  const [step, setStep] = useState(0);
  const steps = [
    {
      title: 'Welcome to BidWatch',
      body: 'BidWatch keeps procurement opportunities, ownership, deadlines, documents and submissions in one controlled workspace.',
      points: ['Your access is tied to your provisioned Google account.', 'Your role determines which actions and insights you can use.'],
    },
    {
      title: 'Follow a bid from discovery to submission',
      body: 'Every opportunity moves through a clear workflow so the team can see what is happening and what needs attention.',
      points: ['Bids progress through defined review, pursuit, preparation and submission stages.', 'Use My Tenders for your assigned work and the Dashboard for deadlines needing attention.'],
    },
    {
      title: 'Know where to look',
      body: 'The workspace separates action from analysis so you can find the right information quickly.',
      points: ['Dashboard: work that needs attention now.', 'Insights: operational trends and role-appropriate KPIs.', 'All Bids: search, filter and open the full bid record.'],
    },
  ];
  const current = steps[step];
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') void onFinish();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onFinish]);
  return (
    <div className="onboarding-backdrop" onClick={() => void onFinish()}>
      <section className="onboarding-dialog" onClick={event => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="onboarding-title" aria-describedby="onboarding-description">
        <div className="onboarding-progress" aria-label={`Step ${step + 1} of ${steps.length}`}>
          {steps.map((item, index) => <span key={item.title} className={index === step ? 'active' : index < step ? 'complete' : ''} />)}
        </div>
        <div className="onboarding-content">
          <span className="onboarding-eyebrow">GETTING STARTED · {step + 1} OF {steps.length}</span>
          <h2 id="onboarding-title">{current.title}</h2>
          <p id="onboarding-description">{current.body}</p>
          <ul>
            {current.points.map(point => <li key={point}>{point}</li>)}
          </ul>
        </div>
        <div className="onboarding-actions">
          <button className="text-btn" onClick={() => void onFinish()}>Skip introduction</button>
          <div>
            {step > 0 && <button className="secondary" onClick={() => setStep(value => value - 1)}>Back</button>}
            {step < steps.length - 1 ? <button className="primary" autoFocus onClick={() => setStep(value => value + 1)}>Next</button> : <button className="primary" autoFocus onClick={() => void onFinish()}>Start using BidWatch</button>}
          </div>
        </div>
      </section>
    </div>
  );
}
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="error-state" role="alert">
      <div className="error-state-card">
        <strong>We could not load BidWatch</strong>
        <p>{message}</p>
        <button className="primary" onClick={onRetry}>Try again</button>
      </div>
    </div>
  );
}
function NavItem({ icon, label, active, count, onClick }: any) {
  return (
    <button
      className={active ? 'nav-item active' : 'nav-item'}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
      {count ? <em>{count}</em> : null}
    </button>
  );
}
function AuthScreen({
  onSignIn,
  notice,
}: {
  onSignIn: () => void;
  notice: string;
}) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="brand auth-brand">
          <div className="brand-mark">B</div>
          <div>
            <strong>BidWatch</strong>
            <span>Internal bid tracker</span>
          </div>
        </div>
        <h1>Keep every bid in sight.</h1>
        <p>
          Track opportunities, deadlines, ownership, documents and submissions
          in one place.
        </p>
        <button className="primary wide" onClick={onSignIn}>
          Sign in / Sign up
        </button>
        <small>Use the provisioned Google account assigned to you by a BidWatch administrator. Authentication is handled by Google; BidWatch does not receive your Google password.</small>
        {notice && <div className="form-error">{notice}</div>}
      </div>
    </div>
  );
}
function displayBidTitle(title: string) {
  const value = title.trim();
  if (!value) return 'Untitled bid';
  if (value === value.toUpperCase() && /[A-Z]/.test(value)) {
    return value.toLowerCase().replace(/\b([a-z])/g, letter => letter.toUpperCase());
  }
  return value;
}

function Dashboard({ tenders, profile, onOpen, onAdd, opportunityUpdates }: { tenders: Tender[]; profile: User; onOpen: (tender: Tender) => void; onAdd: () => void; opportunityUpdates: OpportunityUpdate[] }) {
  const [view, setView] = useState<'all' | 'mine' | 'unassigned'>('all');
  const canSeeTeam = profile.permissions?.includes('kpis.view.team');
  const canSeeMine = profile.permissions?.includes('kpis.view.workload');
  const open = tenders.filter((t: Tender) => t.status !== 'Applied' && t.status !== 'Declined');
  const urgencyRank = (deadline: string) => { const diff = new Date(deadline).getTime() - Date.now(); if (diff < 0) return 0; if (diff <= 86400000) return 1; if (diff <= 3 * 86400000) return 2; if (diff <= 7 * 86400000) return 3; if (diff <= 14 * 86400000) return 4; return 5; };
  const sorted = [...open].sort((a: Tender, b: Tender) => urgencyRank(a.deadline) - urgencyRank(b.deadline) || new Date(a.deadline).getTime() - new Date(b.deadline).getTime());
  const source = view === 'mine' ? sorted.filter((t: Tender) => t.assigneeId === profile.id) : view === 'unassigned' ? sorted.filter((t: Tender) => !t.assigneeId) : sorted;
  const visible = source.slice(0, 8);
  const counts = {
    all: tenders.length,
    mine: canSeeMine ? open.filter((t: Tender) => t.assigneeId === profile.id).length : 0,
    unassigned: canSeeTeam ? open.filter((t: Tender) => !t.assigneeId).length : 0,
  };
  const viewLabel = view === 'mine' ? 'your assigned bids' : view === 'unassigned' ? 'open bids without an owner' : 'the latest bids in the workspace';

  return (
    <>
      <PageHead title="Dashboard" subtitle="Action-first work on the left. New procurement signals on the right." />
      <div className="dashboard-grid">
      <section className="panel dashboard-workspace">
        <div className="panel-head dashboard-workspace-head">
          <div>
            <h2>Bid workspace</h2>
            <p>Use the views to focus the same bid data without maintaining duplicate lists.</p>
          </div>
          <button className="primary dashboard-add-bid" onClick={onAdd}><Plus size={16} /> Add bid</button>
        </div>
        <div className="dashboard-tabs" role="tablist" aria-label="Bid workspace views">
          <button className={view === 'all' ? 'dashboard-tab active' : 'dashboard-tab'} role="tab" aria-selected={view === 'all'} onClick={() => setView('all')}>
            <span>All bids</span><b>{counts.all}</b>
          </button>
          {canSeeMine && <button className={view === 'mine' ? 'dashboard-tab active' : 'dashboard-tab'} role="tab" aria-selected={view === 'mine'} onClick={() => setView('mine')}>
            <span>My deadlines</span><b>{counts.mine}</b>
          </button>}
          {canSeeTeam && <button className={view === 'unassigned' ? 'dashboard-tab active' : 'dashboard-tab'} role="tab" aria-selected={view === 'unassigned'} onClick={() => setView('unassigned')}>
            <span>Unassigned</span><b>{counts.unassigned}</b>
          </button>}
        </div>
        <div className="dashboard-list-head">
          <span>{view === 'all' ? 'Latest bids' : view === 'mine' ? 'Upcoming assigned deadlines' : 'Open bids without an owner'}</span>
          <span>{viewLabel}</span>
        </div>
        {visible.length ? (
          <div className="dashboard-bid-list">
            {visible.map((t: Tender) => {
              const u = urgency(t.deadline);
              return <button className="dashboard-bid-card" key={t.id} onClick={() => onOpen(t)}>
                <span className="dashboard-bid-main">
                  <b>{displayBidTitle(t.title)}</b>
                  <span>{t.organisation}</span>
                  <small>{t.reference || 'No reference'}{t.category ? ` · ${t.category}` : ''}</small>
                </span>
                <span className="dashboard-bid-meta">
                  <strong>{fmtDate(t.deadline)}</strong>
                  <em className={`urgency ${u.tone}`}>{u.label}</em>
                  <span className={`status ${t.status.toLowerCase().replaceAll(' ', '-')}`}>{t.status}</span>
                  <span className="dashboard-open-action">Open bid</span>
                </span>
              </button>;
            })}
          </div>
        ) : (
          <div className="dashboard-empty-state">
            <div className="dashboard-empty-icon"><ClipboardList size={20} /></div>
            <b>{view === 'unassigned' ? 'No unassigned bids' : view === 'mine' ? 'No upcoming assigned deadlines' : 'No bids to show'}</b>
            <span>{view === 'unassigned' ? 'All open bids currently have an owner.' : view === 'mine' ? 'You have no open bids assigned to you.' : 'Add a bid to begin tracking procurement opportunities.'}</span>
          </div>
        )}
        <div className="dashboard-workspace-foot">
          <span>{visible.length} shown{source.length > visible.length ? ` of ${source.length}` : ''}</span>
          <button className="text-btn dashboard-view-all" onClick={() => window.location.hash = '#/bids'}>Open all bids</button>
        </div>
      </section>
      <OpportunityUpdates updates={opportunityUpdates} />
      </div>
    </>
  );
}
function OpportunityUpdates({ updates }: { updates: OpportunityUpdate[] }) {
  const visible = [...updates].filter(item => { const time = item.deadline ? new Date(item.deadline).getTime() : NaN; return Number.isFinite(time) && time >= Date.now(); }).sort((a, b) => {
    const cyberTerms = ['cybersecurity', 'cyber security', 'information security', 'penetration testing', 'vulnerability assessment', 'security audit', 'soc', 'siem', 'firewall', 'network security', 'iam', 'mfa', 'data protection', 'incident response', 'iso 27001'];
    const isCyber = (item: OpportunityUpdate) => (item.matchedTerms || []).some(term => cyberTerms.includes(term));
    const rank = (value?: string) => { if (!value) return 99; const diff = new Date(value).getTime() - Date.now(); if (diff < 0) return 0; if (diff <= 86400000) return 1; if (diff <= 3 * 86400000) return 2; if (diff <= 7 * 86400000) return 3; if (diff <= 14 * 86400000) return 4; return 5; };
    return Number(isCyber(b)) - Number(isCyber(a)) || rank(a.deadline) - rank(b.deadline) || (new Date(a.deadline || '9999-12-31').getTime() - new Date(b.deadline || '9999-12-31').getTime());
  }).slice(0, 5);
  return (
    <section className="panel dashboard-workspace opportunity-updates">
      <div className="panel-head dashboard-workspace-head">
        <div>
          <h2>Opportunity updates</h2>
          <p>Relevant procurement opportunities found on connected platforms.</p>
        </div>
        <button className="text-btn" onClick={() => { window.location.hash = '#/opportunities'; }}>Explore all</button>
      </div>
      {visible.length ? (
        <div className="dashboard-bid-list">
          {visible.map(item => {
            const deadline = item.deadline ? urgency(item.deadline) : null;
            return (
              <a className="dashboard-bid-card opportunity-update-card" key={item.id} href={item.url || item.sourceUrl} target="_blank" rel="noreferrer">
                <span className="dashboard-bid-main">
                  <b>{displayBidTitle(item.title || 'Untitled opportunity')}</b>
                  <span>{item.organisation || 'Organisation not published'} · {item.source}</span>
                  <small>{item.reference || 'Reference not published'} · {item.state === 'imported' ? 'Added to BidWatch' : 'New from platform'}{item.alsoListedOn?.length ? ` · Also listed on ${item.alsoListedOn.join(', ')}` : ''}</small>
                </span>
                <span className="dashboard-bid-meta">
                  <strong>{item.deadline ? fmtDate(item.deadline) : 'Deadline not published'}</strong>
                  {deadline && <em className={`urgency ${deadline.tone}`}>{deadline.label}</em>}
                  <span className="status neutral">{item.noticeType || 'Procurement notice'}</span>
                </span>
              </a>
            );
          })}
        </div>
      ) : (
        <div className="dashboard-empty-state">
          <div className="dashboard-empty-icon"><Globe2 size={20} /></div>
          <b>No platform opportunities yet</b>
          <span>Run a discovery scan to populate this feed. Scheduled discovery also runs with the daily reminder job.</span>
        </div>
      )}
      <div className="dashboard-workspace-foot">
        <span>{visible.length} shown{updates.length > visible.length ? ` of ${updates.length}` : ''}</span>
        <button className="text-btn" onClick={() => { window.location.hash = '#/opportunities'; }}>Explore all</button>
      </div>
    </section>
  );
}
function Insights({ kpis }: { kpis: Record<string, any> }) {
  return (
    <>
      <PageHead title="Insights" subtitle="Operational information available to you based on your BidWatch permissions." />
      <KpiPanel kpis={kpis} />
    </>
  );
}
function KpiPanel({ kpis }: { kpis: Record<string, any> }) {
  const portfolio = kpis.overview;
  const deadlines = kpis.deadlines;
  const submissions = kpis.submissions;
  const pipelineNames = ['New', 'Reviewing', 'Pursuing', 'Preparing', 'Ready to Submit', 'Applied', 'Declined'];
  const pipeline = pipelineNames.map(name => ({ name, value: Number(kpis.pipeline?.[name] || 0) }));
  const pipelineTotal = pipeline.reduce((sum, item) => sum + item.value, 0);
  const active = Number(portfolio?.active || 0);
  const applied = Number(portfolio?.applied || 0);
  const total = Number(portfolio?.total || 0);
  const overdue = Number(deadlines?.overdue || 0);
  const dueToday = Number(deadlines?.dueToday || 0);
  const due1to3 = Number(deadlines?.due1to3 || 0);
  const due4to7 = Number(deadlines?.due4to7 || 0);
  const due7 = dueToday + due1to3 + due4to7;
  const riskTotal = overdue + dueToday + due1to3 + due4to7;
  const visible = Object.keys(kpis).filter(key => kpis[key]);
  if (!visible.length) return null;
  return (
    <section className="panel kpi-panel">
      <div className="kpi-head"><div><span className="kpi-eyebrow">OPERATIONAL SUMMARY</span><h2>Bid overview</h2></div></div>
      {portfolio && <div className="kpi-hero-grid"><div className="kpi-hero-stat"><span>Open bids</span><strong>{active}</strong><small>{total ? `${Math.round((active / total) * 100)}% of all bids` : 'No open bids'}</small></div><div className="kpi-hero-stat"><span>Submitted bids</span><strong>{applied}</strong><small>{submissions ? `${submissions.submissionRate}% submission rate` : 'Applied status'}</small></div><div className={`kpi-hero-stat ${overdue > 0 ? 'risk' : ''}`}><span>Bids needing attention</span><strong>{riskTotal}</strong><small>{overdue > 0 ? `${overdue} overdue` : `${due7} due within 7 days`}</small></div><div className="kpi-hero-stat"><span>Average days to deadline</span><strong>{deadlines?.averageDaysRemaining ?? '—'}</strong><small>Open bids only</small></div></div>}
      <div className="kpi-analytics-grid">
        {kpis.deadlines && <div className="kpi-chart-card"><div className="kpi-card-head"><div><h3>Upcoming deadlines</h3></div><b>{riskTotal} needing attention</b></div><div className="kpi-risk-grid"><div className="kpi-risk danger"><span>Overdue</span><strong>{overdue}</strong></div><div className="kpi-risk critical"><span>Due today</span><strong>{dueToday}</strong></div><div className="kpi-risk warning"><span>Due in 1–3 days</span><strong>{deadlines.due1to3 || 0}</strong></div><div className="kpi-risk neutral"><span>Due in 4–7 days</span><strong>{deadlines.due4to7 || 0}</strong></div></div><div className="kpi-pressure"><span title="Share of open bids that are overdue or due within 7 days.">At-risk share</span><div role="img" aria-label={`${active ? Math.round((riskTotal / active) * 100) : 0}% of open bids are overdue or due within 7 days`}><i style={{ width: `${active ? Math.min(100, (riskTotal / active) * 100) : 0}%` }} /></div><b>{active ? Math.round((riskTotal / active) * 100) : 0}%</b></div><p className="kpi-help">Share of open bids that are overdue or due within 7 days.</p></div>}
        {kpis.pipeline && <div className="kpi-chart-card"><div className="kpi-card-head"><div><h3>Bids by stage</h3></div></div><div className="kpi-bars" aria-label="Bid pipeline distribution; bar width represents share of all bids">{pipeline.map(item => <div className="kpi-bar-row" key={item.name}><span title={item.name}>{item.name}</span><div className="kpi-bar-track"><i style={{ width: `${pipelineTotal ? Math.round((item.value / pipelineTotal) * 100) : 0}%` }} /></div><strong>{item.value}</strong></div>)}</div></div>}
      </div>
      <div className="kpi-detail-grid">{kpis.submissions && <KpiDetail title="Submission activity" scope="Shared" items={[[`Submitted this month`, submissions.submittedThisMonth], [`Declined this month`, submissions.declinedThisMonth], [`Submission rate`, `${submissions.submissionRate}%`]]} />}{kpis.workload && <KpiDetail title="My work" scope="Personal" items={[[`My open bids`, kpis.workload.myActive], [`My deadlines in 7 days`, kpis.workload.myDue7]]} />}{kpis.team && <KpiDetail title="Team workload" scope="Team" items={[[`Active users`, kpis.team.activeUsers], [`Assigned open bids`, kpis.team.assignedActiveBids], [`Unassigned open bids`, kpis.team.unassignedActiveBids], [`Average open bids / user`, Number(kpis.team.averageActiveBidsPerUser).toFixed(2)], [`Overdue assigned`, kpis.team.overdueAssigned]]} />}{kpis.access && <KpiDetail title="User access" scope="Super Admin" items={[[`Provisioned users`, kpis.access.provisioned], [`Active users`, kpis.access.active], [`Suspended users`, kpis.access.suspended], [`Roles`, kpis.access.roles]]} />}{kpis.storage && <KpiDetail title="Storage" scope="Super Admin" items={[[`Attachments`, kpis.storage.attachmentCount], [`Stored files`, kpis.storage.storedFileCount], [`Unlinked files`, kpis.storage.untrackedFileCount], [`Tracked storage`, `${(kpis.storage.trackedBytes / 1024 / 1024).toFixed(2)} MB`]]} />}</div>
    </section>
  );
}
function KpiDetail({ title, scope, items }: { title: string; scope: string; items: Array<[string, any]> }) { return <section className="kpi-detail-card"><div className="kpi-detail-head"><h3>{title}</h3><span className="kpi-detail-scope">{scope}</span></div><div className="kpi-metric-list">{items.filter(([, value]) => value !== undefined).map(([label, value]) => <div className="kpi-metric" key={label}><b>{value}</b><span>{label}</span></div>)}</div></section>; }
function ScopeTag({ label }: { label: string }) { return <span className={`kpi-scope-tag ${label.toLowerCase().replaceAll(' ', '-')}`}>{label}</span>; }
function PageHead({ title, subtitle, action }: any) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </div>
  );
}
function BidList({
  tenders,
  query,
  setQuery,
  statusFilter,
  setStatusFilter,
  categoryFilter,
  setCategoryFilter,
  onOpen,
  onAdd,
  title = 'All Bids',
}: any) {
  return (
    <>
      <PageHead
        title={title}
        subtitle="Search, filter and open a bid to review its details."
        action={
          <button className="primary" onClick={onAdd}>
            <Plus size={17} /> Add bid
          </button>
        }
      />
      <div className="toolbar">
        <div className="search">
          <Search size={17} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search title, organisation, reference…"
          />
        </div>
        <label className="filter-field">
          <span>Status</span>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Filter by status">
            <option value="All">Any status</option>
            {STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label className="filter-field">
          <span>Category</span>
          <select value={categoryFilter} onChange={e => setCategoryFilter(e.target.value)} aria-label="Filter by category">
            <option value="All">Any category</option>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <span className="result-count">
          {tenders.length} result{tenders.length === 1 ? '' : 's'}
        </span>
      </div>
      <section className="panel">
        <TenderTable tenders={tenders} onOpen={onOpen} />
      </section>
    </>
  );
}
function TenderTable({
  tenders,
  onOpen,
}: {
  tenders: Tender[];
  onOpen: (t: Tender) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Bid</th>
            <th>Organisation</th>
            <th>Deadline</th>
            <th>Status</th>
            <th>Category</th>
          </tr>
        </thead>
        <tbody>
          {tenders.length ? (
            tenders.map(t => {
              const u = urgency(t.deadline);
              return (
                <tr key={t.id} onClick={() => onOpen(t)}>
                  <td>
                    <b>{t.title}</b>
                    <small>{t.reference || 'No reference'}</small>
                  </td>
                  <td>{t.organisation}</td>
                  <td>
                    <span>{fmtDate(t.deadline)}</span>
                    <small className={`urgency ${u.tone}`}>{u.label}</small>
                  </td>
                  <td>
                    <span
                      className={`status ${t.status.toLowerCase().replaceAll(' ', '-')}`}
                    >
                      {t.status}
                    </span>
                  </td>
                  <td>{t.category || 'Other'}</td>
                </tr>
              );
            })
          ) : (
            <tr>
              <td colSpan={5} className="empty">
                No bids match the current filters.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
function TenderForm({ users, onCancel, onSaved }: any) {
  const [form, setForm] = useState<any>({
    title: '',
    organisation: '',
    reference: '',
    description: '',
    deadline: '',
    source: '',
    url: '',
    category: 'Cybersecurity',
    assigneeId: '',
    notes: '',
  });
  const [files, setFiles] = useState<File[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (k: string, v: any) => setForm((f: any) => ({ ...f, [k]: v }));
  async function submit(e: any) {
    e.preventDefault();
    if (!form.title || !form.organisation || !form.deadline) {
      setError('Title, organisation and deadline are required.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const oversized = files.find(file => file.size > 10 * 1024 * 1024);
      if (oversized) {
        throw new Error(`${oversized.name} is larger than the current 10 MB upload limit.`);
      }
      const r = await api.post('/api/tenders', form);
      const id = r.data.tender.id;
      for (const file of files) {
        const reader = new FileReader();
        await new Promise<void>((resolve, reject) => {
          reader.onload = async () => {
            try {
              const base64 = String(reader.result).split(',')[1];
              await api.post(`/api/tenders/${id}/attachments`, {
                filename: file.name,
                mimeType: file.type || 'application/octet-stream',
                size: file.size,
                content: base64,
              });
              resolve();
            } catch (err) {
              reject(err);
            }
          };
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(file);
        });
      }
      await onSaved();
    } catch (err: any) {
      setError(err?.message || 'Could not save bid.');
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <PageHead
        title="Add bid"
        subtitle="Create one record and attach the source documents."
      />
      <form className="form panel" onSubmit={submit}>
        <div className="form-grid">
          <Field label="Bid title *">
            <input
              value={form.title}
              onChange={e => set('title', e.target.value)}
              placeholder="e.g. Cybersecurity Services RFP"
            />
          </Field>
          <Field label="Organisation *">
            <input
              value={form.organisation}
              onChange={e => set('organisation', e.target.value)}
              placeholder="Organisation name"
            />
          </Field>
          <Field label="Reference">
            <input
              value={form.reference}
              onChange={e => set('reference', e.target.value)}
              placeholder="Tender / RFP number"
            />
          </Field>
          <Field label="Deadline *">
            <input
              type="datetime-local"
              value={form.deadline}
              onChange={e => set('deadline', e.target.value)}
            />
          </Field>
          <Field label="Category">
            <select
              value={form.category}
              onChange={e => set('category', e.target.value)}
            >
              {CATEGORIES.map(c => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label="Assignee">
            <select
              value={form.assigneeId}
              onChange={e => set('assigneeId', e.target.value)}
            >
              <option value="">Unassigned</option>
              {users.map((u: User) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Source">
            <input
              value={form.source}
              onChange={e => set('source', e.target.value)}
              placeholder="UNDP, website, email…"
            />
          </Field>
          <Field label="Source URL">
            <input
              value={form.url}
              onChange={e => set('url', e.target.value)}
              placeholder="https://…"
            />
          </Field>
          <Field label="Description" wide>
            <textarea
              rows={5}
              value={form.description}
              onChange={e => set('description', e.target.value)}
              placeholder="What is being procured? Include useful scope details."
            />
          </Field>
          <Field label="Internal notes" wide>
            <textarea
              rows={4}
              value={form.notes}
              onChange={e => set('notes', e.target.value)}
              placeholder="Questions, partner requirements, next steps…"
            />
          </Field>
        </div>
        <div className="upload-box" onClick={() => fileRef.current?.click()}>
          <Upload size={22} />
          <b>Attach bid documents</b>
          <span>PDF, Word, Excel, PowerPoint, images, TXT or ZIP</span>
          <input
            ref={fileRef}
            type="file"
            multiple
            accept={ACCEPT}
            hidden
            onChange={e => setFiles(Array.from(e.target.files || []))}
          />
          {files.length > 0 && (
            <div className="file-list">
              {files.map(f => (
                <span key={f.name}>
                  <Paperclip size={14} />
                  {f.name}
                </span>
              ))}
            </div>
          )}
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="form-actions">
          <button type="button" className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save bid'}
          </button>
        </div>
      </form>
    </>
  );
}
function Field({ label, children, wide }: any) {
  return (
    <label className={wide ? 'field wide' : 'field'}>
      <span>{label}</span>
      {children}
    </label>
  );
}
function TenderDrawer({
  tender,
  profile,
  users,
  attachments,
  activities,
  onClose,
  onChanged,
  setNotice,
}: any) {
  const [busy, setBusy] = useState(false);
  const [subRef, setSubRef] = useState(tender.submissionReference || '');
  const [status, setStatus] = useState(tender.status);
  const [assignee, setAssignee] = useState(tender.assigneeId || '');
  const [revision, setRevision] = useState<number>(tender.revision || 1);
  const [confirm, setConfirm] = useState<{ type: 'attachment' | 'bid' | 'apply' | 'decline'; attachment?: Attachment } | null>(null);
  async function saveChanges() {
    setBusy(true);
    try {
      await api.put(`/api/tenders/${tender.id}`, {
        status,
        assigneeId: assignee,
        expectedRevision: revision,
      });
      invalidateApiCache(['/api/tenders', `/api/tenders/${tender.id}/`, '/api/kpis', '/api/history']);
      await onChanged();
      setNotice('Bid updated.');
    } catch (e: any) {
      setNotice(e?.message || 'Update failed.');
    } finally {
      setBusy(false);
    }
  }
  function requestApply() { setConfirm({ type: 'apply' }); }
  async function apply() {
    setBusy(true);
    try {
      await api.post(`/api/tenders/${tender.id}/apply`, {
        submissionReference: subRef,
        expectedRevision: revision,
      });
      invalidateApiCache(['/api/tenders', `/api/tenders/${tender.id}/`, '/api/kpis', '/api/history']);
      await onChanged();
      setConfirm(null);
      setNotice('Bid marked Applied.');
    } catch (e: any) {
      setNotice(e?.message || 'Could not mark Applied.');
    } finally {
      setBusy(false);
    }
  }
  function requestDecline() { setConfirm({ type: 'decline' }); }
  async function decline() {
    setBusy(true);
    try {
      await api.post(`/api/tenders/${tender.id}/decline`, { expectedRevision: revision });
      invalidateApiCache(['/api/tenders', `/api/tenders/${tender.id}/`, '/api/kpis', '/api/history']);
      await onChanged();
      setConfirm(null);
      setNotice('Bid marked Declined.');
    } catch (e: any) {
      setNotice(e?.message || 'Could not decline.');
    } finally {
      setBusy(false);
    }
  }
  async function download(a: Attachment) {
    try {
      const r = await api.get(`/api/attachments/${a.id}/url`);
      window.open(r.data.url, '_blank', 'noopener,noreferrer');
    } catch (e: any) {
      setNotice(e?.message || 'Could not open document.');
    }
  }
  async function removeAttachment(a: Attachment) {
    setConfirm({ type: 'attachment', attachment: a });
  }
  async function removeTender() {
    if (!profile.permissions?.includes('bids.delete')) return;
    setConfirm({ type: 'bid' });
  }
  async function performConfirmedDelete() {
    if (!confirm) return;
    setBusy(true);
    try {
      if (confirm.type === 'attachment' && confirm.attachment) {
        await api.delete(`/api/attachments/${confirm.attachment.id}`);
        invalidateApiCache([`/api/tenders/${tender.id}/attachments`, `/api/tenders/${tender.id}/activity`]);
        setNotice('Document deleted.', 'success');
        setConfirm(null);
        await onChanged();
      } else {
        await api.delete(`/api/tenders/${tender.id}`);
        invalidateApiCache(['/api/tenders', '/api/history', '/api/kpis', `/api/tenders/${tender.id}/`]);
        setNotice('Bid deleted. Its text history remains available in Bid History.', 'success');
        setConfirm(null);
        await onChanged();
        onClose();
      }
    } catch (e: any) {
      setNotice(e?.message || 'The deletion could not be completed.', 'error');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="drawer" onClick={e => e.stopPropagation()}>
        <div className="drawer-head">
          <button className="icon-btn" onClick={onClose}>
            <ChevronLeft size={20} />
          </button>
          <div>
            <span
              className={`status ${tender.status.toLowerCase().replaceAll(' ', '-')}`}
            >
              {tender.status}
            </span>
            <h2 id="bid-detail-title">{tender.title}</h2>
            <p>
              {tender.organisation}
              {tender.reference ? ` · ${tender.reference}` : ''}
            </p>
          </div>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="drawer-body">
          <div className={`deadline ${urgency(tender.deadline).tone}`}>
            <CalendarDays size={18} />
            <div>
              <small>Deadline</small>
              <b>{fmtDate(tender.deadline)}</b>
              <span>{urgency(tender.deadline).label}</span>
            </div>
          </div>
          <section>
            <h3>Details</h3>
            <p className="long-text">
              {tender.description || 'No description provided.'}
            </p>
            <div className="detail-grid">
              <div>
                <small>Category</small>
                <b>{tender.category || 'Other'}</b>
              </div>
              <div>
                <small>Submitted</small>
                <b>{fmtDate(tender.submittedAt)}</b>
              </div>
              <div>
                <small>Source</small>
                <b>{tender.source || '—'}</b>
              </div>
              <div>
                <small>URL</small>
                {tender.url ? (
                  <a href={tender.url} target="_blank" rel="noreferrer">
                    Open source
                  </a>
                ) : (
                  <b>—</b>
                )}
              </div>
            </div>
          </section>
          <section>
            <h3>Manage</h3>
            <div className="manage-grid">
              <Field label="Status">
                <select
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                >
                  {STATUSES.filter(s => s !== 'Applied').map(s => (
                    <option key={s}>{s}</option>
                  ))}
                </select>
              </Field>
              <Field label="Assignee">
                <select
                  value={assignee}
                  onChange={e => setAssignee(e.target.value)}
                >
                  <option value="">Unassigned</option>
                  {users.map((u: User) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <button className="secondary" disabled={busy} onClick={saveChanges}>
              {busy ? 'Saving…' : 'Save changes'}
            </button>
          </section>
          <section>
            <div className="section-title">
              <h3>Attachments</h3>
              <Paperclip size={16} />
            </div>
            {attachments.length ? (
              <div className="attachments">
                {attachments.map((a: Attachment) => (
                  <div className='attachment-row' key={a.id}>
                    <button onClick={() => download(a)}>
                      <FileText size={17} />
                      <span>
                        {a.filename}
                        <small>{(a.size / 1024 / 1024).toFixed(2)} MB</small>
                      </span>
                    </button>
                    {profile.permissions?.includes('attachments.delete') && <button className='mini-btn' onClick={() => removeAttachment(a)}>Delete</button>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted">No attachments.</p>
            )}
          </section>
          <section>
            <h3>Activity</h3>
            <div className="timeline">
              {activities.map((a: Activity) => (
                <div key={a.id}>
                  <span>{initials(a.actorName)}</span>
                  <p>
                    <b>{a.actorName}</b> {a.action}
                    {a.detail ? (
                      <>
                        <br />
                        <small>{a.detail}</small>
                      </>
                    ) : null}
                    <time>{fmtDate(a.createdAt)}</time>
                  </p>
                </div>
              ))}
            </div>
          </section>
          {profile.permissions?.includes('bids.apply') &&
            tender.status !== 'Applied' &&
            tender.status !== 'Declined' && (
              <section className="apply-box">
                <h3>Mark as Applied</h3>
                <p>Only authorised users can record the final submission.</p>
                <input
                  value={subRef}
                  onChange={e => setSubRef(e.target.value)}
                  placeholder="Submission reference (optional)"
                />
                <button
                  className="primary wide"
                  onClick={requestApply}
                  disabled={busy}
                >
                  <Check size={17} /> Confirm Applied
                </button>
              </section>
            )}
          {profile.permissions?.includes('bids.decline') && tender.status !== 'Applied' && (
            <button className='danger-btn' onClick={requestDecline} disabled={busy}>
              Mark Declined
            </button>
          )}
          {profile.permissions?.includes('bids.delete') && (
            <button className='danger-btn' onClick={removeTender} disabled={busy}>
              <Trash2 size={16} /> Delete bid and documents
            </button>
          )}
        </div>
      </aside>
      {confirm && (
        <ConfirmDialog
          title={confirm.type === 'bid' ? 'Delete this bid?' : confirm.type === 'attachment' ? 'Delete this document?' : confirm.type === 'apply' ? 'Mark this bid as Applied?' : 'Mark this bid as Declined?'}
          description={confirm.type === 'bid' ? `“${tender.title}” and its stored documents will be permanently removed from the active workspace.` : confirm.type === 'attachment' ? `“${confirm.attachment?.filename || 'This document'}” will be permanently removed from storage.` : confirm.type === 'apply' ? `This will close “${tender.title}” as a submitted bid and record the submission timestamp.` : `This will close “${tender.title}” as Declined.`}
          impact={confirm.type === 'bid' ? 'A text-only record of this bid will remain in Bid History so the team can retain its procurement history.' : confirm.type === 'attachment' ? 'The bid itself will remain. Only the stored document will be removed.' : confirm.type === 'apply' ? 'Applied is a final workflow state. Confirm that the submission has actually been made before continuing.' : 'Declined is a final workflow state for this bid.'}
          actionLabel={confirm.type === 'bid' ? 'Delete bid' : confirm.type === 'attachment' ? 'Delete document' : confirm.type === 'apply' ? 'Mark Applied' : 'Mark Declined'}
          busy={busy}
          onCancel={() => !busy && setConfirm(null)}
          onConfirm={confirm.type === 'apply' ? apply : confirm.type === 'decline' ? decline : performConfirmedDelete}
        />
      )}
    </div>
  );
}
function ConfirmDialog({ title, description, impact, actionLabel, busy, onCancel, onConfirm }: { title: string; description: string; impact: string; actionLabel: string; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={() => !busy && onCancel()}>
      <div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title">
        <div className="modal-head">
          <div><h2 id="confirm-title">{title}</h2><p>This action cannot be undone.</p></div>
          <button className="icon-btn" onClick={onCancel} disabled={busy} aria-label="Close confirmation"><X size={18} /></button>
        </div>
        <div className="modal-body">
          <p className="confirm-copy">{description}</p>
          <div className="confirm-impact">{impact}</div>
          <div className="modal-actions">
            <button className="secondary" onClick={onCancel} disabled={busy}>Keep it</button>
            <button className="danger-btn" onClick={onConfirm} disabled={busy}>{busy ? 'Working…' : actionLabel}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
function HistoryView({ history }: { history: BidHistory[] }) {
  return (
    <>
      <PageHead title="Bid History" subtitle="Text-only records of bids previously removed from the active workspace." />
      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead><tr><th>Bid</th><th>Organisation</th><th>Status</th><th>Deadline</th><th>Deleted</th><th>Documents</th></tr></thead>
            <tbody>
              {history.length ? history.map(item => (
                <tr key={item.id}>
                  <td><b>{item.title}</b><small>{item.reference || 'No reference'}</small></td>
                  <td>{item.organisation}</td>
                  <td><span className="history-status">{item.status}</span></td>
                  <td>{fmtDate(item.deadline)}</td>
                  <td>{fmtDate(item.deletedAt)}</td>
                  <td>{item.attachmentCount}</td>
                </tr>
              )) : <tr><td colSpan={6} className="empty">No archived bids yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
function NotificationPopover({ notices, onRead, onReadAll, onClear }: any) { const unread = notices.filter((n: Notice) => !n.read).length; return <section className='notification-popover' role='dialog' aria-label='Notifications'><div className='notification-popover-head'><div><h2>Notifications</h2><span>{unread ? `${unread} unread` : 'All caught up'}</span></div><div className='notification-popover-actions'>{unread > 0 && <button className='text-btn' onClick={onReadAll}>Mark all read</button>}{notices.length > 0 && <button className='text-btn' onClick={onClear}>Clear</button>}</div></div><div className='notification-popover-list'>{notices.length ? notices.slice(0, 12).map((n: Notice) => <button className={n.read ? 'notification-item read' : 'notification-item'} key={n.id} onClick={() => !n.read && onRead(n.id)}><span className='notification-item-icon'><Bell size={16} /></span><span className='notification-item-copy'><b>{n.title}</b><span>{n.body}</span><small>{fmtDate(n.createdAt)}</small></span>{!n.read && <i aria-label='Unread' />}</button>) : <div className='notification-empty'><Bell size={20} /><b>No notifications</b><span>You are all caught up.</span></div>}</div></section>; }
  /* stale duplicate notification markup removed */ /* <section>      <div className="notification-popover-head">        <div><h2>Notifications</h2><span>{unread ? `${unread} unread` : 'All caught up'}</span></div>        <div className="notification-popover-actions">          {unread > 0 && <button className="text-btn" onClick={onReadAll}>Mark all read</button>}          {notices.length > 0 && <button className="text-btn" onClick={onClear}>Clear</button>}        </div>      </div>      <div className="notification-popover-list">        {notices.length ? notices.slice(0, 12).map((n: Notice) => (          <button className={n.read ? 'notification-item read' : 'notification-item'} key={n.id} onClick={() => !n.read && onRead(n.id)}>            <span className="notification-item-icon"><Bell size={16} /></span>            <span className="notification-item-copy"><b>{n.title}</b><span>{n.body}</span><small>{fmtDate(n.createdAt)}</small></span>            {!n.read && <i aria-label="Unread" />}          </button>        )) : <div className="notification-empty"><Bell size={20} /><b>No notifications</b><span>You are all caught up.</span></div>}      </div>    </section>  );} */ function Notifications({ notices, onRead }: any) {
  return (
    <>
      <PageHead
        title="Notifications"
        subtitle="Deadline reminders and team activity that need your attention."
      />
      <section className="panel notice-list">
        {notices.length ? (
          notices.map((n: Notice) => (
            <button
              className={n.read ? 'notice read' : 'notice'}
              key={n.id}
              onClick={() => !n.read && onRead(n.id)}
            >
              <Bell size={18} />
              <div>
                <b>{n.title}</b>
                <p>{n.body}</p>
                <small>{fmtDate(n.createdAt)}</small>
              </div>
              {!n.read && <i />}
            </button>
          ))
        ) : (
          <div className="empty-state">
            <Bell size={24} />
            <b>No notifications</b>
            <span>You are all caught up.</span>
          </div>
        )}
      </section>
    </>
  );
}
function People({ users, onChange }: any) {
  return (
    <>
      <PageHead
        title="People"
        subtitle="Manage BidWatch access and submission permissions."
      />
      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th>Can mark Applied</th>
                <th>Active</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u: User) => (
                <tr key={u.id}>
                  <td>
                    <b>{u.name}</b>
                    <small>{u.email}</small>
                  </td>
                  <td>
                    <span className="status neutral">{u.role}</span>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={u.canMarkApplied}
                      onChange={async e => {
                        await api.put(`/api/users/${u.id}`, {
                          canMarkApplied: e.target.checked,
                        });
                        onChange();
                      }}
                    />
                  </td>
                  <td>{u.active ? 'Active' : 'Inactive'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
function ProfileView({ profile, onSaved, setNotice }: any) {
  const [name, setName] = useState(profile.name || '');
  const [saving, setSaving] = useState(false);
  return (
    <>
      <PageHead title="Profile" subtitle="Manage the name shown to your BidWatch team." />
      <section className="panel settings-page">
        <div className="profile-hero"><span>{initials(name || profile.name || profile.email)}</span><div><h2>{name || profile.name}</h2><p>{profile.email}</p><small>{profile.role}</small></div></div>
        <form onSubmit={async event => { event.preventDefault(); setSaving(true); try { await api.put('/api/me/profile', { name }); await onSaved(); setNotice('Profile updated.', 'success'); } catch { setNotice('Could not update your profile.', 'error'); } finally { setSaving(false); } }}>
          <label className="field"><span>Display name</span><input value={name} onChange={e => setName(e.target.value)} maxLength={120} required /></label>
          <label className="field"><span>Google account</span><input value={profile.email} readOnly /></label>
          <div className="form-actions"><span>Authentication is managed by Google.</span><button className="primary" disabled={saving}>{saving ? 'Saving…' : 'Save profile'}</button></div>
        </form>
      </section>
    </>
  );
}
function SettingsView({ profile, setNotice }: any) {
  return (
    <>
      <PageHead title="Settings" subtitle="Your BidWatch workspace preferences." />
      <section className="panel settings-page">
        <div className="settings-section"><div><h2>Notifications</h2><p>Choose how BidWatch can alert you about deadlines and workspace activity.</p></div><NotificationPreferences setNotice={setNotice} /></div>
        <div className="settings-section"><div><h2>Deadline reminders</h2><p>BidWatch generates reminders 14, 7, 3 and 1 day before a deadline, on the deadline day, and when a bid becomes overdue.</p></div></div>
        <div className="settings-section"><div><h2>Access</h2><p>Your permissions are controlled by your assigned BidWatch role. Contact an administrator if your access needs to change.</p></div></div>
      </section>
    </>
  );
}
function NotificationPreferences({ setNotice }: any) {
  const [env, setEnv] = useState<any>(null);
  useEffect(() => { void import('@appdeploy/client').then(() => setEnv({ supported: true })); }, []);
  return <div className="notification-preferences"><div><b>Browser notifications</b><span>Receive deadline alerts outside BidWatch when your browser supports push notifications.</span></div><button className="secondary" onClick={async () => { try { const mod = await import('@appdeploy/client'); await mod.notifications.subscribe({ showUi: true }); setNotice('Browser notifications enabled.', 'success'); } catch { setNotice('Browser notifications could not be enabled. Check your browser permission and try again.', 'warning'); } }}>{env?.supported ? 'Enable browser notifications' : 'Enable browser notifications'}</button><div className="email-notification-note"><b>Email notifications</b><span>Email delivery is supported as a planned integration, but it requires a transactional email provider and verified sending domain before it can send production mail.</span></div></div>;
}
function AboutView() {
  return (
    <>
      <PageHead title="About BidWatch" subtitle="Internal procurement opportunity tracking for Turtle Tech." />
      <section className="panel about-page">
        <div><b>BidWatch</b><p>A controlled workspace for discovering, reviewing, assigning, preparing and tracking procurement opportunities through submission.</p></div>
        <div><b>Workflow</b><p>Bids move through defined stages from intake and review through preparation and final submission. A bid can also be marked Declined when it is not pursued.</p></div>
        <div><b>Security model</b><p>Access is provisioned by administrators, authenticated through Google, and enforced with server-side role permissions.</p></div>
      </section>
    </>
  );
}
function LegacySettingsView({ setNotice }: any) { return <><PageHead title='Settings' subtitle='Your BidWatch workspace preferences.' /><section className='panel settings-page'><div className='settings-section'><div><h2>Notifications</h2><p>Receive deadline alerts in your browser when supported.</p></div><button className='secondary' onClick={async () => { try { const mod = await import('@appdeploy/client'); await mod.notifications.subscribe({ showUi: true }); setNotice('Browser notifications enabled.', 'success'); } catch { setNotice('Browser notifications could not be enabled. Check browser permissions and try again.', 'warning'); } }}>Enable browser notifications</button></div><div className='settings-section'><div><h2>Email notifications</h2><p>Email delivery requires a transactional email provider and verified sending domain before production mail can be sent.</p></div><span className='status neutral'>Provider configuration required</span></div><div className='settings-section'><div><h2>Deadline reminders</h2><p>Reminders are generated 14, 7, 3 and 1 day before a deadline, on deadline day, and when overdue.</p></div></div><div className='settings-section'><div><h2>Access</h2><p>Your permissions are controlled by your assigned BidWatch role.</p></div></div></section></>; }
function LegacySettingsRulesRemoved() { return null; } /*
      <section className="panel settings">
        <div>
          <b>Deadline reminders</b>
          <span>
            14, 7, 3 and 1 day before deadline, on deadline day, and overdue.
          </span>
        </div>
        <div>
          <b>Default access</b>
          <span>
            New sign-ins become Members until an administrator changes their
            role.
          </span>
        </div>
        <div>
          <b>Application control</b>
          <span>
            Only Authorised and Admin users can mark a bid Applied or Declined.
          </span>
        </div>
      </section>
    </>
  );
}
*/ function TenderDrawerPlaceholder() {
  return null;
}
