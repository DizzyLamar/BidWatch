export type ScheduledOrganisation = { id: string };
export type OrganisationTaskFailure = { organisationId: string; error: string };

export async function runOrganisationTasks<TOrganisation extends ScheduledOrganisation, TResult>(
  organisations: TOrganisation[],
  task: (organisation: TOrganisation) => Promise<TResult>,
): Promise<{
  processed: Array<{ organisationId: string; result: TResult }>;
  failures: OrganisationTaskFailure[];
}> {
  const processed: Array<{ organisationId: string; result: TResult }> = [];
  const failures: OrganisationTaskFailure[] = [];

  // Deliberately sequential: tenant scope is explicit, failures are isolated,
  // and one slow or broken organisation cannot prevent later tenants running.
  for (const organisation of organisations) {
    try {
      const result = await task(organisation);
      processed.push({ organisationId: organisation.id, result });
    } catch (error) {
      failures.push({
        organisationId: organisation.id,
        error: error instanceof Error ? error.message : 'Organisation task failed.',
      });
    }
  }

  return { processed, failures };
}
