# BidWatch

Internal bid/tender tracking system for an ICT and cybersecurity team.

BidWatch is designed around a simple principle: **every opportunity should be discoverable, owned, auditable, deadline-aware and recoverable from mistakes.**

## Product scope

BidWatch tracks the full bid lifecycle:

`Found/New → Reviewing → Pursuing → Preparing → Ready to Submit → Applied`

A bid can also be closed as `Declined`.

Core capabilities:

- Provisioned Google authentication.
- Server-enforced role-based access control.
- Permission-specific workflow actions.
- Bid assignment and ownership.
- Deadline urgency and scheduled reminders.
- Search and filtering.
- Managed document uploads and deletion.
- Activity history and security audit history.
- Role-allocated KPI visibility.
- Text-only Bid History for bids removed from the active workspace.
- Production-oriented error and destructive-action UX.

## Architecture

```text
Google identity
      ↓
Provisioned BidWatch user
      ↓
Role
      ↓
Permissions
      ↓
Frontend → authenticated API → database / managed storage
```

Frontend: React + Vite + TypeScript + Tailwind CSS.

Backend: AppDeploy router + database + managed storage.

Application storage is isolated behind `backend/storage.ts` so the business logic is not tied directly to one object-storage provider.

The application currently uses hash routing because the deployed SPA environment does not require server-side route rewrites.

## Authentication and authorization

Authentication and authorization are deliberately separate.

1. An administrator provisions a user's Google email in BidWatch and assigns a role.
2. The user selects Google sign-in.
3. Google authenticates the user using their normal Google credentials and MFA where configured.
4. BidWatch receives the authenticated identity, not the Google password.
5. BidWatch checks the identity against the provisioned-user table.
6. The assigned role determines the user's permissions.
7. Suspended, inactive, unprovisioned or identity-mismatched users are denied application access.

The protected Super Admin identity is `ddzinja@gmail.com`.

Sensitive access-control permissions include user management, role management, system settings, security-audit access and privileged KPI/storage views. Ordinary role managers cannot allocate sensitive permissions to themselves or others.

## Security controls

BidWatch follows a deny-by-default, least-privilege model.

Implemented controls include:

- Server-side authorization on sensitive operations.
- Dedicated permissions for `Applied`, `Declined` and deletion actions.
- Object-level checks for bids, attachments and notifications.
- Server-side input length validation.
- HTTP/HTTPS URL allowlisting.
- Active-assignee validation.
- Protected Super Admin handling.
- Protection against suspended-user auto-reactivation.
- File extension and size allowlisting.
- Server-generated storage keys.
- Attachment metadata cleanup when storage writes fail.
- Storage orphan detection and privileged cleanup.
- Security activity logging for access-control changes.
- No raw HTML rendering in the React UI.
- Repository regression checks for common XSS/unsafe-UI patterns.

Security is defense-in-depth, not a claim that the application is vulnerability-free. Before wider production use, continue independent security review, dependency review, file-content/magic-byte validation and malware scanning/CDR for uploaded documents.

## Bid deletion and history

Deleting a bid is intentionally different from deleting a document.

### Delete a document

- Requires the attachment-delete permission.
- Shows an explicit destructive confirmation.
- Removes the stored object and attachment metadata.
- Keeps the parent bid and its activity history.

### Delete a bid

- Requires the bid-delete permission.
- Shows the exact bid being removed and its consequences.
- Archives the bid's text metadata into `bid_history` before removing the active record.
- Removes stored documents only after the history snapshot succeeds.
- Leaves a text-only record in **Bid History**.

The history record is deliberately independent of the document objects, so deleting the PDF/DOCX/etc. does not erase the fact that the opportunity existed or the key information about it.

## UX rules

BidWatch uses consequence-based interaction patterns rather than generic browser alerts.

### Destructive actions

Use a confirmation dialog for irreversible deletion. The dialog must:

- Name the object being deleted.
- Explain what will be removed.
- Explain what will remain.
- Use an explicit destructive action label such as `Delete bid` or `Delete document`.
- Keep the non-destructive option visually distinct.
- Never rely on a generic `Are you sure?` message.

Routine actions should not be overloaded with confirmations.

### Errors

Errors should:

- Appear close to the failed task where possible.
- Use plain language.
- Explain what happened without exposing implementation details.
- Give the user a recovery path when one exists.
- Avoid stack traces, database errors and internal service details.
- Use stronger visual treatment only when the error actually blocks progress.

Form validation is inline. Save/delete operations use disabled states to prevent duplicate submissions. Application-load failures have a dedicated recovery state with a retry action.

## KPI model

KPI visibility is permission-driven.

Available groups:

- Portfolio.
- Pipeline.
- Deadline risk.
- Submissions.
- Personal workload.
- Team workload.
- Access posture.
- Storage health.

The backend only returns KPI sections allowed by the authenticated user's role.

## Testing strategy

BidWatch uses two layers of automated verification.

### Repository CI

GitHub Actions runs on pull requests and pushes to `main`:

1. Install dependencies.
2. Typecheck the TypeScript project.
3. Run `npm test`.
4. Build the production frontend.

`npm test` runs `scripts/verify-repo.mjs`, which checks:

- AppDeploy test-suite structure.
- Exactly one sanity test.
- Required security-sensitive backend routes and permissions.
- Bid-history support.
- Managed storage deletion.
- Absence of common raw-HTML/XSS patterns.
- Absence of native browser confirmation dialogs.
- Required production error/confirmation styling.

### AppDeploy black-box QA

`tests/tests.json` defines user-visible workflows for AppDeploy's deployed QA layer. It covers authentication, bid creation, destructive deletion/history, authorization boundaries and production error handling.

A successful local build is not considered sufficient evidence that the deployed application works. The live application should also be reviewed through AppDeploy QA and runtime status.

## Development workflow

Use this workflow for every feature or significant fix:

```text
1. Define the user outcome
        ↓
2. Identify permissions + security impact
        ↓
3. Identify UX states
   happy / validation / loading / empty / error / destructive
        ↓
4. Write or update tests
        ↓
5. Implement backend authorization + data lifecycle
        ↓
6. Implement frontend workflow + recovery states
        ↓
7. Run typecheck + repository tests + production build
        ↓
8. Deploy to AppDeploy
        ↓
9. Review runtime errors + black-box QA
        ↓
10. Fix → redeploy → re-test
        ↓
11. Commit to GitHub
        ↓
12. Merge to main only when CI passes
```

### Definition of Done

A feature is not complete until:

- The user-visible workflow works.
- Backend authorization is enforced independently of the UI.
- Invalid input is rejected safely.
- Loading, empty, success and failure states are handled.
- Destructive actions have appropriate confirmation/recovery.
- Relevant activity/audit history exists.
- Existing data is not accidentally destroyed.
- Automated tests cover the changed behavior.
- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- AppDeploy deployment is ready with no reported frontend/backend runtime errors.
- The deployed behavior has been reviewed.

## Git workflow

Recommended branch model:

```text
main
 ↑
Pull Request
 ↑
feature/<short-description>
```

Examples:

- `feature/bid-history`
- `fix/delete-confirmation`
- `security/attachment-validation`
- `chore/ci-pipeline`

Keep commits focused. Prefer:

- `feat:` for product functionality.
- `fix:` for defects.
- `security:` for security hardening.
- `test:` for automated coverage.
- `docs:` for documentation.
- `chore:` for tooling/CI/dependencies.
- `refactor:` for behavior-preserving architecture changes.

## Continuous integration and deployment

### CI

`.github/workflows/ci.yml` runs automatically for pull requests and pushes to `main`.

### Production deployment

`.github/workflows/deploy.yml` runs after a push to `main` or manually through GitHub Actions.

It repeats the critical verification steps and then calls AppDeploy through `scripts/deploy-appdeploy.mjs`.

The deployment workflow requires a GitHub Actions secret:

`APPDEPLOY_API_KEY`

The key should be created through AppDeploy's API-key flow and stored only as a GitHub Actions secret. Never commit it to the repository.

The deployment script:

- Detects application files changed in the commit.
- Sends only relevant application files/deletions to AppDeploy.
- Polls deployment status.
- Fails the workflow if deployment fails or runtime errors are reported.
- Prevents overlapping production deployments with a GitHub Actions concurrency group.

AppDeploy currently provides the hosted runtime, database, storage, authentication and black-box QA layer. GitHub Actions is the source-control CI/CD control plane.

## Local development

```bash
npm install
npm run dev
```

Before opening a pull request:

```bash
npm run typecheck
npm test
npm run build
```

## Deployment notes

The production application is currently hosted through AppDeploy.

Live application:

`https://bidwatch-q2u0th.v2.appdeploy.ai/`

The AppDeploy MCP workflow also maintains deployment versions and supports rollback when required.

## Repository security

BidWatch contains internal security architecture and application code. The repository should be **private** before it is used as a real company source repository. If it remains public during development, do not commit credentials, secrets, production data, customer documents or sensitive infrastructure details.

## Future hardening

Priorities for future iterations:

1. File magic-byte/signature validation.
2. Malware scanning/CDR for uploaded documents.
3. Server-side pagination and indexed search as volume grows.
4. Stronger audit viewer and access-review workflow.
5. Email/WhatsApp deadline notifications where appropriate.
6. Saved filters and bulk operations with careful authorization.
7. Automated dependency/security scanning in CI.
8. Independent penetration testing before exposing BidWatch beyond the internal team.

## Current AppDeploy snapshot

The live source is maintained separately from GitHub and should be synchronized deliberately. The deployed snapshot is the runtime source of truth for AppDeploy; GitHub is the source-control record.
