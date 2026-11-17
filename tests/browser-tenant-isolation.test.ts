import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { chromium, type Browser, type Page } from 'playwright';

const supabaseUrl = process.env.SUPABASE_URL!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const serviceKey = process.env.SUPABASE_SECRET_KEY!;
const port = Number(process.env.BROWSER_TEST_PORT || 4173);
const baseUrl = 'http://127.0.0.1:' + port;
const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
const password = 'BidWatch-' + randomUUID() + '!';

if (!supabaseUrl || !anonKey || !serviceKey) {
  throw new Error('SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SECRET_KEY are required.');
}

const admin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
});

async function waitForServer(child: ChildProcess) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('BidWatch server exited with code ' + child.exitCode + '.');
    try {
      const response = await fetch(baseUrl + '/healthz');
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('BidWatch server did not become healthy within 30 seconds.');
}

async function createIdentity(email: string, name: string) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name },
  });
  if (error || !data.user) throw error || new Error('Could not create browser-test identity.');
  return data.user;
}

async function createOrganisation(name: string, slug: string, creatorId: string) {
  const { data, error } = await admin.from('organisations')
    .insert({ name, slug, status: 'active', created_by: creatorId })
    .select('id').single();
  if (error || !data) throw error || new Error('Could not create browser-test organisation.');
  return data.id as string;
}

async function createRole(organisationId: string, key: string, permissions: string[]) {
  const { data, error } = await admin.from('organisation_roles').insert({
    organisation_id: organisationId,
    key,
    name: key === 'owner' ? 'Owner' : 'Member',
    permissions,
    is_system: true,
  }).select('id').single();
  if (error || !data) throw error || new Error('Could not create browser-test role.');
  return data.id as string;
}

async function addMembership(organisationId: string, userId: string, roleId: string) {
  const { error } = await admin.from('organisation_members').insert({
    organisation_id: organisationId,
    user_id: userId,
    role_id: roleId,
    status: 'active',
    joined_at: new Date().toISOString(),
  });
  if (error) throw error;
}

async function addProfile(userId: string, email: string, name: string, roleId: string) {
  const { error } = await admin.from('app_records').insert({
    table_name: 'users',
    record: {
      userId, email, name, roleId, active: true, status: 'Active',
      onboardingCompleted: true, createdAt: new Date().toISOString(),
    },
    scope_type: 'global',
    organisation_id: null,
  });
  if (error) throw error;
}

async function addTender(organisationId: string, title: string, userId: string) {
  const { error } = await admin.from('app_records').insert({
    table_name: 'tenders',
    record: {
      title,
      organisation: 'Browser isolation fixture',
      reference: 'E2E-' + suffix + '-' + title.replace(/\W+/g, '-'),
      description: 'Private browser-level tenant isolation fixture.',
      deadline: '2099-12-31',
      source: 'Browser test',
      url: 'https://example.test/tender',
      category: 'Other',
      status: 'New',
      assigneeId: '',
      submittedBy: userId,
      submittedAt: new Date().toISOString(),
      notes: '',
      revision: 1,
    },
    scope_type: 'organisation',
    organisation_id: organisationId,
  });
  if (error) throw error;
}

async function signIn(email: string) {
  const client = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw error || new Error('Could not sign in browser-test identity.');
  const storageKey = 'sb-' + new URL(supabaseUrl).hostname.split('.')[0] + '-auth-token';
  return { storageKey, session: data.session };
}

test('browser workspace switching isolates two users and rejects a forged tenant header', { timeout: 120000 }, async () => {
  const userAEmail = 'browser-a-' + suffix + '@example.test';
  const userBEmail = 'browser-b-' + suffix + '@example.test';
  let userA: any;
  let userB: any;
  let orgA = '';
  let orgB = '';
  let browser: Browser | undefined;
  let server: ChildProcess | undefined;

  try {
    userA = await createIdentity(userAEmail, 'Browser User A');
    userB = await createIdentity(userBEmail, 'Browser User B');
    orgA = await createOrganisation('Browser Workspace A ' + suffix, 'browser-a-' + suffix, userA.id);
    orgB = await createOrganisation('Browser Workspace B ' + suffix, 'browser-b-' + suffix, userA.id);

    const permissions = [
      'bids.view', 'bids.create', 'bids.edit', 'bids.assign', 'bids.apply', 'bids.decline',
      'bids.delete', 'attachments.upload', 'attachments.delete', 'notifications.view',
      'users.view', 'users.manage', 'roles.view', 'roles.manage', 'categories.manage',
      'settings.manage', 'audit.view', 'kpis.view.overview', 'kpis.view.pipeline',
      'kpis.view.deadlines', 'kpis.view.submissions', 'kpis.view.workload',
      'kpis.view.team', 'kpis.view.access', 'kpis.view.storage',
    ];
    const ownerA = await createRole(orgA, 'owner', permissions);
    const ownerB = await createRole(orgB, 'owner', permissions);
    const memberB = await createRole(orgB, 'member', ['bids.view', 'notifications.view']);
    await addMembership(orgA, userA.id, ownerA);
    await addMembership(orgB, userA.id, ownerB);
    await addMembership(orgB, userB.id, memberB);
    await addProfile(userA.id, userAEmail, 'Browser User A', ownerA);
    await addProfile(userB.id, userBEmail, 'Browser User B', memberB);
    await addTender(orgA, 'Private Tender A ' + suffix, userA.id);
    await addTender(orgB, 'Private Tender B ' + suffix, userA.id);

    server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        SUPABASE_URL: supabaseUrl,
        SUPABASE_SECRET_KEY: serviceKey,
      },
      stdio: 'ignore',
    });
    await waitForServer(server);
    browser = await chromium.launch({ headless: true });

    const sessionA = await signIn(userAEmail);
    const contextA = await browser.newContext();
    await contextA.addInitScript(({ storageKey, session }) => {
      localStorage.setItem(storageKey, JSON.stringify(session));
    }, sessionA);
    const pageA = await contextA.newPage();
    await pageA.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await pageA.locator('#active-organisation').waitFor({ state: 'visible' });
    await pageA.locator('#active-organisation').selectOption(orgA);
    await pageA.getByRole('button', { name: 'Continue' }).click();
    await pageA.locator('.app-shell').waitFor({ state: 'visible' });

    const readTitles = async (page: Page, token: string) => page.evaluate(async (accessToken: string) => {
      const organisationId = localStorage.getItem('bidwatch-active-organisation') || '';
      const response = await fetch('/api/tenders', {
        headers: {
          Authorization: 'Bearer ' + accessToken,
          'X-Organisation-Id': organisationId,
        },
      });
      const body = await response.json();
      if (!response.ok) throw new Error('Tender request failed: ' + response.status);
      return (body.tenders || []).map((tender: { title: string }) => tender.title);
    }, token);

    const titlesA = await readTitles(pageA, sessionA.session.access_token);
    assert.ok(titlesA.some(title => title.includes('Private Tender A ' + suffix)));
    assert.ok(!titlesA.some(title => title.includes('Private Tender B ' + suffix)));

    const switcher = pageA.locator('.organisation-switcher select');
    await Promise.all([
      pageA.waitForNavigation({ waitUntil: 'domcontentloaded' }),
      switcher.selectOption(orgB),
    ]);
    await pageA.locator('.app-shell').waitFor({ state: 'visible' });
    await pageA.waitForFunction(id => localStorage.getItem('bidwatch-active-organisation') === id, orgB);
    const titlesB = await readTitles(pageA, sessionA.session.access_token);
    assert.ok(titlesB.some(title => title.includes('Private Tender B ' + suffix)));
    assert.ok(!titlesB.some(title => title.includes('Private Tender A ' + suffix)));
    await contextA.close();

    const sessionB = await signIn(userBEmail);
    const contextB = await browser.newContext();
    await contextB.addInitScript(({ storageKey, session }) => {
      localStorage.setItem(storageKey, JSON.stringify(session));
    }, sessionB);
    const pageB = await contextB.newPage();
    await pageB.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await pageB.locator('.app-shell').waitFor({ state: 'visible' });

    const ownTitles = await readTitles(pageB, sessionB.session.access_token);
    assert.ok(ownTitles.some(title => title.includes('Private Tender B ' + suffix)));
    assert.ok(!ownTitles.some(title => title.includes('Private Tender A ' + suffix)));

    const forged = await pageB.evaluate(async ({ organisationId, token }) => {
      const response = await fetch('/api/tenders', {
        headers: {
          Authorization: 'Bearer ' + token,
          'X-Organisation-Id': organisationId,
        },
      });
      return response.status;
    }, { organisationId: orgA, token: sessionB.session.access_token });
    assert.equal(forged, 403, 'a second browser identity cannot switch into a workspace without membership');
    await contextB.close();
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 5000);
        server!.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
    }
    if (orgA || orgB) {
      const orgIds = [orgA, orgB].filter(Boolean);
      await admin.from('app_records').delete().in('organisation_id', orgIds);
      await admin.from('app_records').delete().eq('scope_type', 'global').in('record->>email', [userAEmail, userBEmail]);
      await admin.from('organisations').delete().in('id', orgIds);
    }
    if (userA?.id) await admin.auth.admin.deleteUser(userA.id);
    if (userB?.id) await admin.auth.admin.deleteUser(userB.id);
  }
});

test('browser member administration enforces role changes, suspension, removal and admin boundaries', { timeout: 120000 }, async () => {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  const ownerEmail = 'browser-owner-' + suffix + '@example.test';
  const memberEmail = 'browser-member-' + suffix + '@example.test';
  const password = 'BidWatch-' + randomUUID() + '!';
  let owner: any;
  let member: any;
  let organisationId = '';
  let browser: Browser | undefined;
  let server: ChildProcess | undefined;

  const createTestIdentity = async (email: string, name: string) => {
    const { data, error } = await admin.auth.admin.createUser({
      email, password, email_confirm: true, user_metadata: { full_name: name },
    });
    if (error || !data.user) throw error || new Error('Could not create browser lifecycle identity.');
    return data.user;
  };
  const signInTestIdentity = async (email: string) => {
    const client = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
    });
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error || !data.session) throw error || new Error('Could not sign in browser lifecycle identity.');
    return data.session;
  };

  try {
    owner = await createTestIdentity(ownerEmail, 'Lifecycle Owner');
    member = await createTestIdentity(memberEmail, 'Lifecycle Member');
    organisationId = await createOrganisation('Lifecycle Workspace ' + suffix, 'lifecycle-' + suffix, owner.id);

    const ownerRole = await createRole(organisationId, 'owner', [
      'bids.view', 'users.view', 'users.manage', 'roles.view', 'roles.manage',
    ]);
    const memberRole = await createRole(organisationId, 'member', ['bids.view']);
    const analystRole = await createRole(organisationId, 'analyst', ['bids.view', 'notifications.view']);
    await addMembership(organisationId, owner.id, ownerRole);
    await addMembership(organisationId, member.id, memberRole);
    for (const identity of [
      { user: owner, email: ownerEmail, name: 'Lifecycle Owner', roleId: ownerRole },
      { user: member, email: memberEmail, name: 'Lifecycle Member', roleId: memberRole },
    ]) {
      const { error } = await admin.from('app_records').insert({
        table_name: 'users',
        record: {
          userId: identity.user.id, email: identity.email, name: identity.name,
          roleId: identity.roleId, active: true, status: 'Active',
          onboardingCompleted: true, createdAt: new Date().toISOString(),
        },
        scope_type: 'global', organisation_id: null,
      });
      if (error) throw error;
    }

    server = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(port), SUPABASE_URL: supabaseUrl, SUPABASE_SECRET_KEY: serviceKey },
      stdio: 'ignore',
    });
    await waitForServer(server);
    browser = await chromium.launch({ headless: true });

    const ownerSession = await signInTestIdentity(ownerEmail);
    const ownerContext = await browser.newContext();
    const storageKey = 'sb-' + new URL(supabaseUrl).hostname.split('.')[0] + '-auth-token';
    await ownerContext.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), {
      key: storageKey, session: ownerSession,
    });
    const ownerPage = await ownerContext.newPage();
    await ownerPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await ownerPage.locator('#active-organisation').waitFor({ state: 'visible' });
    await ownerPage.locator('#active-organisation').selectOption(organisationId);
    await ownerPage.getByRole('button', { name: 'Continue' }).click();
    await ownerPage.locator('.app-shell').waitFor({ state: 'visible' });

    const memberSession = await signInTestIdentity(memberEmail);
    const memberContext = await browser.newContext();
    await memberContext.addInitScript(({ key, session }) => localStorage.setItem(key, JSON.stringify(session)), {
      key: storageKey, session: memberSession,
    });
    const memberPage = await memberContext.newPage();
    await memberPage.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await memberPage.locator('#active-organisation').waitFor({ state: 'visible' });
    await memberPage.locator('#active-organisation').selectOption(organisationId);
    await memberPage.getByRole('button', { name: 'Continue' }).click();
    await memberPage.locator('.app-shell').waitFor({ state: 'visible' });

    const request = async (page: Page, token: string, path: string, method = 'GET', body?: unknown) =>
      page.evaluate(async args => {
        const response = await fetch(args.path, {
          method: args.method,
          headers: {
            Authorization: 'Bearer ' + args.token,
            'X-Organisation-Id': args.organisationId,
            ...(args.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(args.body === undefined ? {} : { body: JSON.stringify(args.body) }),
        });
        const payload = await response.json().catch(() => ({}));
        return { status: response.status, payload };
      }, { path, method, token, body, organisationId });

    const memberToken = memberSession.access_token;
    const deniedMemberList = await request(memberPage, memberToken, '/api/admin/users');
    assert.equal(deniedMemberList.status, 403, 'ordinary members cannot enumerate administrative membership data');
    const deniedRoleWrite = await request(memberPage, memberToken, '/api/admin/roles', 'POST', {
      name: 'Forged Admin Role', permissions: ['users.manage'],
    });
    assert.equal(deniedRoleWrite.status, 403, 'ordinary members cannot create or grant administrative roles');

    const listed = await request(ownerPage, ownerSession.access_token, '/api/admin/users');
    assert.equal(listed.status, 200);
    const memberEntry = (listed.payload.users || []).find((item: any) => item.userId === member.id);
    assert.ok(memberEntry?.membershipId, 'admin API must expose the membership id used by lifecycle routes');

    const changedRole = await request(ownerPage, ownerSession.access_token,
      '/api/admin/users/' + memberEntry.membershipId, 'PUT', { roleId: analystRole });
    assert.equal(changedRole.status, 200);
    assert.equal(changedRole.payload.roleId, analystRole);

    const suspended = await request(ownerPage, ownerSession.access_token,
      '/api/admin/users/' + memberEntry.membershipId, 'PUT', { status: 'suspended' });
    assert.equal(suspended.status, 200);
    const suspendedAccess = await request(memberPage, memberToken, '/api/tenders');
    assert.equal(suspendedAccess.status, 403, 'suspended memberships must lose tenant API access immediately');

    const reactivated = await request(ownerPage, ownerSession.access_token,
      '/api/admin/users/' + memberEntry.membershipId, 'PUT', { status: 'active' });
    assert.equal(reactivated.status, 200);
    const restoredAccess = await request(memberPage, memberToken, '/api/tenders');
    assert.equal(restoredAccess.status, 200, 'reactivation restores the member access path');

    const removed = await request(ownerPage, ownerSession.access_token,
      '/api/admin/users/' + memberEntry.membershipId, 'DELETE');
    assert.equal(removed.status, 200);
    const removedAccess = await request(memberPage, memberToken, '/api/tenders');
    assert.equal(removedAccess.status, 403, 'soft removal must revoke access without deleting the Auth identity');
    const organisations = await request(memberPage, memberToken, '/api/organisations');
    assert.ok(!(organisations.payload.organisations || []).some((item: any) => item.id === organisationId));

    await memberContext.close();
    await ownerContext.close();
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) {
      server.kill('SIGTERM');
      await new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, 5000);
        server!.once('exit', () => { clearTimeout(timeout); resolve(); });
      });
    }
    if (organisationId) {
      await admin.from('app_records').delete().eq('organisation_id', organisationId);
      await admin.from('app_records').delete().eq('scope_type', 'global')
        .in('record->>email', [ownerEmail, memberEmail]);
      await admin.from('organisations').delete().eq('id', organisationId);
    }
    if (owner?.id) await admin.auth.admin.deleteUser(owner.id);
    if (member?.id) await admin.auth.admin.deleteUser(member.id);
  }
});
