import { getDatabaseScope, supabaseAdmin } from './runtime';
import type { DatabaseScope } from './scoped-records';

export type OpportunityState =
  | 'new'
  | 'watching'
  | 'qualifying'
  | 'pursuing'
  | 'dismissed'
  | 'converted';

export type ProcurementOpportunityRow = {
  id: string;
  organisation_id: string;
  canonical_opportunity_id: string;
  state: OpportunityState;
  fit_level: 'direct' | 'partner' | 'peripheral' | null;
  relevance_score: number | null;
  classification_version: string | null;
  matched_categories: string[];
  matched_terms: string[];
  classification_reason: string | null;
  owner_user_id: string | null;
  dismissed_at: string | null;
  converted_tender_id: string | null;
  created_at: string;
  updated_at: string;
  canonical_opportunities: {
    id: string;
    canonical_key: string;
    title: string;
    buyer_name: string | null;
    reference: string | null;
    published_at: string | null;
    deadline_at: string | null;
    description: string | null;
    notice_type: string | null;
    procurement_method: string | null;
    lifecycle_status: 'open' | 'closed' | 'cancelled' | 'awarded' | 'unknown';
    canonical_url: string | null;
    canonical_opportunity_sources: Array<{
      id: string;
      match_method: string;
      match_confidence: number | null;
      review_status: string;
      procurement_source_observations: {
        id: string;
        source_key: string;
        external_id: string | null;
        reference: string | null;
        source_url: string;
        title: string;
        buyer_name: string | null;
        published_at: string | null;
        deadline_at: string | null;
        notice_type: string | null;
        procurement_method: string | null;
        document_links: Array<{ title: string; url: string }>;
        content_hash: string;
        first_seen_at: string;
        last_seen_at: string;
        source_status: string;
        procurement_sources: {
          id: string;
          source_key: string;
          name: string;
          base_url: string | null;
        };
      };
    }>;
  };
};

export type OpportunityCursor = {
  updatedAt: string;
  id: string;
};

export type ListOrganisationOpportunitiesOptions = {
  state?: OpportunityState;
  limit?: number;
  cursor?: OpportunityCursor;
};

export type OrganisationOpportunityPage = {
  items: ProcurementOpportunityRow[];
  nextCursor: OpportunityCursor | null;
};

const OPPORTUNITY_SELECT = `
  id,
  organisation_id,
  canonical_opportunity_id,
  state,
  fit_level,
  relevance_score,
  classification_version,
  matched_categories,
  matched_terms,
  classification_reason,
  owner_user_id,
  dismissed_at,
  converted_tender_id,
  created_at,
  updated_at,
  canonical_opportunities!inner (
    id,
    canonical_key,
    title,
    buyer_name,
    reference,
    published_at,
    deadline_at,
    description,
    notice_type,
    procurement_method,
    lifecycle_status,
    canonical_url,
    canonical_opportunity_sources (
      id,
      match_method,
      match_confidence,
      review_status,
      procurement_source_observations (
        id,
        source_key,
        external_id,
        reference,
        source_url,
        title,
        buyer_name,
        published_at,
        deadline_at,
        notice_type,
        procurement_method,
        document_links,
        content_hash,
        first_seen_at,
        last_seen_at,
        source_status,
        procurement_sources (
          id,
          source_key,
          name,
          base_url
        )
      )
    )
  )
`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function activeOrganisationId(getScope: () => DatabaseScope | null): string {
  const scope = getScope();
  if (!scope || scope.kind !== 'organisation') {
    throw new Error('A verified active organisation scope is required to read procurement opportunities.');
  }
  return scope.organisationId;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 50;
  return Math.min(100, Math.max(1, Math.trunc(value)));
}

function validCursor(cursor: OpportunityCursor): boolean {
  return UUID_PATTERN.test(cursor.id)
    && typeof cursor.updatedAt === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(cursor.updatedAt)
    && Number.isFinite(Date.parse(cursor.updatedAt));
}

/**
 * Read-only tenant repository for the Phase 2 canonical opportunity model.
 *
 * The organisation ID is derived exclusively from the verified request scope.
 * Callers cannot supply or override it. Platform-global reads intentionally
 * live behind a separate platform-operator repository that is not part of 2A.
 */
export function createProcurementReadRepository(
  client: any,
  getScope: () => DatabaseScope | null,
) {
  function database() {
    if (!client) throw new Error('Supabase is not configured.');
    return client;
  }

  return {
    async listOrganisationOpportunitiesPage(
      options: ListOrganisationOpportunitiesOptions = {},
    ): Promise<OrganisationOpportunityPage> {
      const organisationId = activeOrganisationId(getScope);
      const limit = boundedLimit(options.limit);
      if (options.cursor && !validCursor(options.cursor)) {
        throw new Error('Invalid procurement opportunity cursor.');
      }

      let query = database()
        .from('organisation_opportunities')
        .select(OPPORTUNITY_SELECT)
        .eq('organisation_id', organisationId);

      if (options.state) query = query.eq('state', options.state);
      if (options.cursor) {
        // Preserve PostgreSQL timestamp precision (up to microseconds); Date would truncate it to milliseconds.
        const timestamp = options.cursor.updatedAt;
        query = query.or(
          `updated_at.lt.${timestamp},and(updated_at.eq.${timestamp},id.lt.${options.cursor.id})`,
        );
      }

      const { data, error } = await query
        .order('updated_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);

      if (error) throw new Error(error.message);
      const rows = (data || []) as ProcurementOpportunityRow[];
      const hasMore = rows.length > limit;
      const items = rows.slice(0, limit);
      const lastItem = items[items.length - 1];

      return {
        items,
        nextCursor: hasMore && lastItem
          ? { updatedAt: lastItem.updated_at, id: lastItem.id }
          : null,
      };
    },

    async listOrganisationOpportunities(
      options: ListOrganisationOpportunitiesOptions = {},
    ): Promise<ProcurementOpportunityRow[]> {
      const { items } = await this.listOrganisationOpportunitiesPage(options);
      return items;
    },

    async getOrganisationOpportunity(id: string): Promise<ProcurementOpportunityRow | null> {
      const organisationId = activeOrganisationId(getScope);
      if (!UUID_PATTERN.test(id)) return null;

      const { data, error } = await database()
        .from('organisation_opportunities')
        .select(OPPORTUNITY_SELECT)
        .eq('organisation_id', organisationId)
        .eq('id', id)
        .maybeSingle();

      if (error) throw new Error(error.message);
      return (data || null) as ProcurementOpportunityRow | null;
    },
  };
}

export const procurementReadRepository = createProcurementReadRepository(
  supabaseAdmin,
  getDatabaseScope,
);
