# Organisation member lifecycle

Member administration is scoped to the currently selected organisation. The application never deletes a person's Supabase Auth account when removing them from one workspace.

## Invite a new person

A user with the `users.manage` permission can invite a new email address from Administration → Users.

1. The API validates that the selected role belongs to the current organisation.
2. It refuses to assign roles containing sensitive permissions unless the acting user is a platform administrator.
3. Supabase Auth sends an invitation email and creates the Auth identity.
4. BidWatch creates a global identity profile and an organisation membership with status `invited`.
5. The invited person signs in using the same verified email. Supabase Auth automatically links verified OAuth identities with matching email addresses. When the signed-in identity requests its organisation list, BidWatch activates only invitations associated with that exact Auth user UUID.

The browser never receives the Supabase secret key. Invitations and identity creation happen only on the server.

## Add an existing BidWatch user

If the email already belongs to a BidWatch profile, the existing Auth identity is added to the selected organisation. The membership is active immediately. Existing access to other organisations is unchanged.

A confirmed Auth identity that has no BidWatch profile is not silently adopted by email. The administrator should ask that person to sign in to BidWatch first, then invite/add the resulting profile.

## Change role or status

- Role changes are validated against the current organisation's role table.
- A role from another organisation is rejected.
- Sensitive permission bundles cannot be assigned by ordinary organisation administrators.
- Members can be suspended and later reactivated.
- A user cannot suspend or remove their own membership.
- The last active organisation owner cannot be demoted, suspended, or removed.

## Remove a member

Removal changes the membership status to `removed`. It does not delete the Auth user, the global identity profile, records they created, or their memberships in other organisations. This preserves audit/history references and allows a later restore by an authorised administrator.

## Current boundaries

- Invitations use Supabase Auth's configured invitation email template and Site URL. The redirect must be configured in Supabase Auth if a custom destination is needed.
- A user must authenticate with the same verified email address that received the invitation.
- Existing Auth accounts without a BidWatch profile are not automatically attached to a workspace by email alone.
- This implementation does not delete Auth accounts or globally revoke sessions. It revokes access to this organisation by changing the membership status; other active memberships remain valid.
