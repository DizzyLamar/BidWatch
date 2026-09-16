# BidWatch

Internal bid/tender tracking system for an ICT and cybersecurity team.

## Current security model

- Google-only authentication through the platform identity provider.
- Authentication and authorization are separate: a Google identity must be provisioned in BidWatch before application access is granted.
- Users receive a role; roles contain permissions. Individual users are not granted ad-hoc permissions.
- `ddzinja@gmail.com` is the protected Super Admin identity.
- Sensitive access-control permissions cannot be allocated by ordinary role managers.
- Bid workflow transitions such as Applied and Declined are enforced server-side with dedicated permissions.
- Object lookups for bids and attachments are checked server-side before access.
- User-controlled URLs are restricted to HTTP/HTTPS.
- Tender text fields have server-side length limits.
- File uploads use an allowlist, size limit, server-generated storage keys and authorization checks.
- Storage access is isolated behind `backend/storage.ts`, allowing a future S3/R2/Azure implementation without changing business logic.
- Security-relevant access-control changes are logged to `security_activity`.
- KPI sections are permissions and can be allocated through role definitions.

## KPI permissions

Available KPI views include portfolio, pipeline, deadlines, submissions, personal workload, team workload, access posture and storage health. The API only returns KPI sections allowed by the authenticated user's role.

## Authentication flow

1. A Super Admin provisions the user's company Google email and assigns a role.
2. The user opens BidWatch and selects Google sign-in.
3. Google authenticates the user using the user's normal Google account credentials and MFA where configured.
4. BidWatch receives the authenticated identity, not the user's Google password.
5. BidWatch checks the identity against its provisioned users and role permissions.
6. Suspended, inactive or unprovisioned identities are denied.

## Security direction

The application follows a deny-by-default, least-privilege approach and is intended to be reviewed against OWASP authorization, XSS, IDOR/BOLA, file-upload and authentication guidance before wider production use.

## Deployment

The current deployed application is managed in AppDeploy. GitHub is the source-control mirror for the application architecture and security changes.

Latest verified AppDeploy snapshot: `1789547633778`.
