import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const anonKey = process.env.SUPABASE_ANON_KEY;
const serviceKey = process.env.SUPABASE_SECRET_KEY;

test('Phase 2A procurement schema preserves global evidence and independent organisation pursuits', async () => {
  assert.ok(supabaseUrl && anonKey && serviceKey, 'Export local Supabase credentials before running integration tests.');
  const host = new URL(supabaseUrl!).hostname;
  assert.ok(['127.0.0.1', 'localhost', '::1'].includes(host), 'Refusing to run procurement schema tests against a remote project.');

  const admin = createClient(supabaseUrl!, serviceKey!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  const anon = createClient(supabaseUrl!, anonKey!, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const suffix = randomUUID();
  const ids: Record<string, string> = {};
  try {
    const sourceResult = await admin.from('procurement_sources').insert({
      source_key: 'test-' + suffix,
      name: 'Integration test source',
      base_url: 'https://example.test/procurement',
      adapter_key: 'test-adapter',
    }).select('id').single();
    assert.ifError(sourceResult.error);
    assert.ok(sourceResult.data);
    ids.source = sourceResult.data.id;

    const runResult = await admin.from('procurement_source_runs').insert({
      source_id: ids.source,
      scan_type: 'manual',
      status: 'ok',
      fetched_count: 1,
      parsed_count: 1,
      relevant_count: 1,
    }).select('id').single();
    assert.ifError(runResult.error);
    assert.ok(runResult.data);
    ids.run = runResult.data.id;

    const observationResult = await admin.from('procurement_source_observations').insert({
      source_id: ids.source,
      source_key: 'notice-' + suffix,
      external_id: 'external-' + suffix,
      reference: 'REF-' + suffix,
      source_url: 'https://example.test/procurement/' + suffix,
      title: 'Integration test ICT procurement',
      buyer_name: 'Test Authority',
      content_hash: 'hash-' + suffix,
      raw_payload: { source: 'test', preserved: true },
    }).select('id').single();
    assert.ifError(observationResult.error);
    assert.ok(observationResult.data);
    ids.observation = observationResult.data.id;

    const canonicalResult = await admin.from('canonical_opportunities').insert({
      canonical_key: 'canonical-' + suffix,
      title: 'Integration test ICT procurement',
      buyer_name: 'Test Authority',
      reference: 'REF-' + suffix,
      lifecycle_status: 'open',
    }).select('id').single();
    assert.ifError(canonicalResult.error);
    assert.ok(canonicalResult.data);
    ids.canonical = canonicalResult.data.id;

    const linkResult = await admin.from('canonical_opportunity_sources').insert({
      canonical_opportunity_id: ids.canonical,
      observation_id: ids.observation,
      match_method: 'same_source_reference',
      match_confidence: 1,
      review_status: 'automatic',
    }).select('id').single();
    assert.ifError(linkResult.error);
    assert.ok(linkResult.data);
    ids.link = linkResult.data.id;

    const orgA = await admin.from('organisations').insert({
      name: 'Phase 2A Test A ' + suffix,
      slug: 'phase-2a-test-a-' + suffix.slice(0, 8),
      status: 'active',
    }).select('id').single();
    assert.ifError(orgA.error);
    assert.ok(orgA.data);
    ids.orgA = orgA.data.id;

    const orgB = await admin.from('organisations').insert({
      name: 'Phase 2A Test B ' + suffix,
      slug: 'phase-2a-test-b-' + suffix.slice(0, 8),
      status: 'active',
    }).select('id').single();
    assert.ifError(orgB.error);
    assert.ok(orgB.data);
    ids.orgB = orgB.data.id;

    const pursuits = await admin.from('organisation_opportunities').insert([
      { organisation_id: ids.orgA, canonical_opportunity_id: ids.canonical, state: 'pursuing', fit_level: 'direct', relevance_score: 88 },
      { organisation_id: ids.orgB, canonical_opportunity_id: ids.canonical, state: 'dismissed', dismissed_at: new Date().toISOString(), fit_level: 'peripheral', relevance_score: 12 },
    ]).select('id,organisation_id,state');
    assert.ifError(pursuits.error);
    assert.ok(pursuits.data);
    assert.equal(pursuits.data.length, 2);
    assert.deepEqual(
      pursuits.data.map(row => row.state).sort(),
      ['dismissed', 'pursuing'],
      'the same canonical opportunity must retain independent organisation decisions',
    );
    ids.pursuitA = pursuits.data.find(row => row.organisation_id === ids.orgA)!.id;
    ids.pursuitB = pursuits.data.find(row => row.organisation_id === ids.orgB)!.id;

    const secondCanonical = await admin.from('canonical_opportunities').insert({
      canonical_key: 'canonical-owner-check-' + suffix,
      title: 'Owner membership constraint check',
      lifecycle_status: 'open',
    }).select('id').single();
    assert.ifError(secondCanonical.error);
    assert.ok(secondCanonical.data);
    ids.canonical2 = secondCanonical.data.id;
    const invalidOwner = await admin.from('organisation_opportunities').insert({
      organisation_id: ids.orgA,
      canonical_opportunity_id: ids.canonical2,
      state: 'watching',
      owner_user_id: randomUUID(),
    });
    assert.ok(invalidOwner.error, 'a pursuit owner must be a member of the same organisation');

    const duplicate = await admin.from('organisation_opportunities').insert({
      organisation_id: ids.orgA,
      canonical_opportunity_id: ids.canonical,
      state: 'watching',
    });
    assert.ok(duplicate.error, 'an organisation must have only one pursuit row per canonical opportunity');

    const browserRead = await anon.from('canonical_opportunities').select('id').eq('id', ids.canonical);
    assert.ok(browserRead.error, 'anonymous browser clients must not read platform-global procurement data');

    const versionUpdate = await admin.from('procurement_observation_versions')
      .update({ snapshot: { tampered: true } }).eq('id', randomUUID());
    assert.ok(versionUpdate.error, 'source evidence versions must not be updateable by the application service');
    const versionDelete = await admin.from('procurement_observation_versions')
      .delete().eq('id', randomUUID());
    assert.ok(versionDelete.error, 'source evidence versions must not be deleteable by the application service');

    const browserWrite = await anon.from('organisation_opportunities').insert({
      organisation_id: ids.orgA,
      canonical_opportunity_id: ids.canonical,
      state: 'watching',
    });
    assert.ok(browserWrite.error, 'anonymous browser clients must not create tenant pursuit records');

  } finally {
    if (ids.pursuitA || ids.pursuitB) {
      await admin.from('organisation_opportunities').delete().in('id', [ids.pursuitA, ids.pursuitB].filter(Boolean));
    }
    if (ids.orgA || ids.orgB) {
      await admin.from('organisations').delete().in('id', [ids.orgA, ids.orgB].filter(Boolean));
    }
    if (ids.link) await admin.from('canonical_opportunity_sources').delete().eq('id', ids.link);
    if (ids.observation) await admin.from('procurement_source_observations').delete().eq('id', ids.observation);
    if (ids.canonical2) await admin.from('canonical_opportunities').delete().eq('id', ids.canonical2);
    if (ids.canonical) await admin.from('canonical_opportunities').delete().eq('id', ids.canonical);
    if (ids.run) await admin.from('procurement_source_runs').delete().eq('id', ids.run);
    if (ids.source) await admin.from('procurement_sources').delete().eq('id', ids.source);
  }
});
