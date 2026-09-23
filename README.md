# BidWatch

Internal bid and tender tracking system for an ICT and cybersecurity team.

BidWatch gives the team one controlled workspace for procurement opportunities, ownership, deadlines, documents, workflow state, submissions and audit history.

## Product scope

BidWatch tracks these workflow states:

- New
- Reviewing
- Pursuing
- Preparing
- Ready to Submit
- Applied
- Declined

Core capabilities include:

- Provisioned Google authentication.
- Server-enforced role-based access control.
- Permission-specific workflow actions.
- Bid assignment and ownership.
- Deadline urgency and scheduled reminders.
- Explicitly labelled status and category filters.
- Managed document uploads and deletion.
- Activity history and security audit history.
- Permission-controlled KPI visibility.
- Text-only Bid History for removed bids.
- Accessible destructive-action confirmations.
- Production error and recovery states.
- Short-lived client caching and request deduplication for high-frequency reads.
- Optimistic concurrency protection for shared bid records.

## Architecture

The application separates identity, authorization, application logic and persistence.

**Authentication**

Google authenticates the person. BidWatch then checks the authenticated identity against its provisioned-user records.

**Authorization**

The authenticated BidWatch user receives a role. The role determines the permissions available to the user. Sensitive permissions remain restricted to the protected Super Admin identity.

**Application**

The React frontend calls authenticated API routes. The backend validates authorization and input before changing application state. Database records and managed object storage are accessed through the backend.

Frontend: React, Vite, TypeScript and Tailwind CSS.

Backend: Express router, Supabase database and Supabase private storage.

Object storage is isolated behind `backend/storage.ts` so business logic does not depend directly on one storage implementation.

The application currently uses hash routing because the deployed SPA environment does not require server-side route rewrites.

## Request handling

BidWatch treats request volume as a production concern rather than assuming the application will always have a small number of users.

Authenticated GET requests that are safe to cache use a short in-memory cache in `src/api-cache.ts`. Each cached request has a deliberately small time-to-live. Concurrent callers for the same URL share the same in-flight promise, preventing duplicate requests during simultaneous renders or refreshes.

Mutations invalidate affected cache entries before the workspace is refreshed. The main refresh operation also coalesces simultaneous refresh calls so several UI events cannot create a burst of identical requests.

The cache is process-local to the browser session. It is cleared on sign-out and is never used as an authorization source. The server remains the source of truth.

Administrative data uses a longer read cache because roles, categories and user access records change less frequently. Bid lists, KPIs and notifications use shorter windows because users expect them to reflect current work.

## Shared-record consistency

Bid records include a server-managed `revision` value.

When a user edits a bid, applies it or declines it, the client sends the revision it originally read. The server compares that value with the current stored revision. A mismatch returns HTTP 409 instead of silently overwriting another user's newer change. Successful writes increment the revision.

This is optimistic concurrency control. It is intended to protect shared procurement records when two team members have the same bid open at the same time.

The server does not trust hidden fields, disabled controls or client-side workflow state for authorization. Every state-changing endpoint validates permissions and business rules again on the server.

## Authentication and authorization

Authentication and authorization are separate concerns.

1. An administrator provisions a user's Google email and assigns a BidWatch role.
2. The user signs in through Google.
3. Google handles the user's credentials and configured MFA.
4. BidWatch receives the authenticated identity, not the Google password.
5. BidWatch checks that identity against its provisioned-user records.
6. The user's role determines the effective permissions.
7. Suspended, inactive, unprovisioned and identity-mismatched users are denied application access.

The protected Super Admin identity is `ddzinja@gmail.com`.

Sensitive permissions include user management, role management, system settings, security-audit access and privileged KPI/storage views. Ordinary role managers cannot allocate sensitive permissions to themselves or other users.

## Security controls

BidWatch uses deny-by-default authorization and least privilege.

Implemented controls include:

- Server-side authorization on sensitive operations.
- Dedicated permissions for Applied, Declined and deletion actions.
- Object-level checks for bids, attachments and notifications.
- Server-side input length validation.
- HTTP and HTTPS URL allowlisting.
- Active-assignee validation.
- Protected Super Admin handling.
- Protection against suspended-user auto-reactivation.
- File extension and size allowlisting.
- Server-generated storage keys.
- Attachment metadata cleanup when storage writes fail.
- Storage orphan detection and privileged cleanup.
- Security activity logging for access-control changes.
- React's normal escaped rendering without raw HTML injection.
- Repository regression checks for unsafe HTML and native browser confirmation patterns.

These controls are defense in depth. They are not a claim that the application is vulnerability-free. Before wider production use, continue independent security review, dependency review, file-content and magic-byte validation, and malware scanning or content disarm and reconstruction for uploaded documents.

## Bid deletion and history

Deleting a document and deleting a bid are different operations.

### Delete a document

- Requires the attachment-delete permission.
- Shows an explicit destructive confirmation.
- Removes the stored object and attachment metadata.
- Keeps the parent bid and its activity history.

### Delete a bid

- Requires the bid-delete permission.
- Identifies the exact bid and explains the consequences.
- Creates a text-only history snapshot before deleting the active record.
- Removes stored documents only after the history snapshot succeeds.
- Leaves the historical record in Bid History.

The history record is independent of document storage, so removing a PDF, DOCX or other attachment does not erase the procurement record.

## UX rules

BidWatch uses explicit, task-specific controls rather than generic browser prompts.

### Filters

Every filter has a visible field label. The default options are written as `All statuses` and `All categories`, so the meaning of each control remains clear even when several filters appear together.

### Destructive actions

Use a confirmation dialog for irreversible deletion. The dialog must:

- Name the object being deleted.
- Explain what will be removed.
- Explain what will remain.
- Use an explicit destructive action label such as `Delete bid` or `Delete document`.
- Provide a clear non-destructive option.
- Prevent duplicate submission while the operation is running.
- Never rely on a generic browser `confirm()` dialog.

### Errors

Errors should appear close to the failed task where possible. Messages use plain language, avoid implementation details and provide a recovery path when one exists. Stack traces, database errors and internal service details are never presented as user-facing copy.

Save and deletion operations use disabled states while requests are running. Application-load failures have a dedicated recovery state with a retry action.

## KPI model

KPI visibility is permission-driven.

Available groups include:

- Portfolio
- Pipeline
- Deadline risk
- Submissions
- Personal workload
- Team workload
- Access posture
- Storage health

The backend returns only the KPI sections allowed by the authenticated user's role.

## Testing strategy

BidWatch uses repository CI and deployed black-box QA.

### Repository CI

GitHub Actions runs on pull requests and pushes to `main`.

The pipeline installs dependencies, typechecks the project, runs `npm test` and builds the production frontend.

`npm test` runs `scripts/verify-repo.mjs`. The repository verification checks the deployed QA suite, security-sensitive backend routes, bid-history support, managed storage deletion, unsafe HTML patterns, native browser confirmations and required production error styling.

### Deployed QA

`tests/tests.json` defines user-visible workflows for deployed QA. Current coverage includes first-login onboarding, labelled filters at mobile width, destructive deletion and history, concurrent bid edits, privileged workflow boundaries and production error handling.

A successful local build is not treated as sufficient evidence that the deployed application works. Runtime status and black-box QA are part of the definition of done.

## Development workflow

For every feature or significant fix:

1. Define the user outcome.
2. Identify permissions and security impact.
3. Identify loading, empty, validation, success, error and destructive states.
4. Write or update tests.
5. Implement backend authorization and data lifecycle rules.
6. Implement the frontend workflow and recovery states.
7. Run typecheck, repository tests and the production build.
8. Deploy through Render after CI passes.
9. Review runtime errors and black-box QA.
10. Fix and redeploy if required.
11. Synchronize the deployed application source into GitHub.
12. Merge to `main` only after CI passes.

### Definition of done

A feature is complete only when:

- The user-visible workflow works.
- Backend authorization is enforced independently of the UI.
- Invalid input is rejected safely.
- Loading, empty, success and failure states are handled.
- Destructive actions have appropriate confirmation and recovery behavior.
- Relevant activity or audit history exists.
- Existing data is not accidentally destroyed.
- Relevant automated tests cover the changed behavior.
- `npm run typecheck` passes.
- `npm test` passes.
- `npm run build` passes.
- Render reports a healthy deployment with no frontend or backend runtime errors.
- GitHub contains the same application source used by the deployment.

## Git workflow

Use focused feature or fix branches and merge through pull requests.

Recommended commit prefixes:

- `feat:` product functionality.
- `fix:` defects.
- `security:` security hardening.
- `test:` automated coverage.
- `docs:` documentation.
- `chore:` tooling, CI or dependencies.
- `refactor:` behavior-preserving architecture changes.

GitHub is the source-control record. The Render deployment must be sourced from the GitHub commit that passed CI.

## Continuous integration and deployment

`.github/workflows/ci.yml` runs automatically for pull requests and pushes to `main`.

`Render deploys the connected `main` branch automatically. GitHub Actions is responsible for CI verification; Render is responsible for building and running the production web service.

The Render service uses `npm install && npm run build`, starts with `npm start`, and exposes `/healthz` for readiness checks. Production secrets are configured in Render and are never committed to the repository.

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

## Production

Live application
:

`https://bidwatch.onrender.com/`

Render provides the hosted web service. Supabase provides authentication, database and private storage. GitHub provides source control and CI verification.

The repository should be private before BidWatch is used as a real company source repository. Never commit credentials, production data, customer documents or sensitive infrastructure details.

## Future hardening

Priorities as usage grows:

1. Server-side pagination and indexed search for large bid volumes.
2. File magic-byte validation.
3. Malware scanning or content disarm and reconstruction for uploaded documents.
4. Stronger audit review and access-review workflows.
5. Transactional email and approved messaging notifications.
6. Saved filters and carefully authorized bulk operations.
7. Automated dependency and security scanning in CI.
8. Independent penetration testing before exposure outside the internal team.
