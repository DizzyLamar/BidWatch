-- Phase 2B prerequisite: explicitly identify one-observation canonical seeds.
-- This is additive and does not migrate or modify any procurement data.
begin;

alter table public.canonical_opportunity_sources
  drop constraint canonical_opportunity_sources_method_check;

alter table public.canonical_opportunity_sources
  add constraint canonical_opportunity_sources_method_check check (
    match_method in (
      'same_source_reference',
      'exact_url',
      'external_identifier',
      'content_hash',
      'reviewed_manual',
      'source_observation_seed'
    )
  );

commit;
