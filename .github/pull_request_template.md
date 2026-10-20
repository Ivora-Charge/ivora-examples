## What and why

<!-- What this changes and why. Link the issue it closes. -->

## Template

<!-- The one template folder this touches, or "root files". -->

## Checklist

- [ ] Touches one template folder and its workflow only, or root files only.
- [ ] `npm run format:check`, `npm run typecheck`, `npm test` and `npm run build` pass locally in the template folder.
- [ ] Tests need no real credentials or network access.
- [ ] Demo mode still works offline with no credentials, and never sends payment requests, charger commands or emails.
- [ ] Ivora API key and tenant ID are read on the server only.
- [ ] Webhook signatures are verified; writes send idempotency keys.
- [ ] README and `.env.example` are updated for any new variables, setup steps or Ivora API usage.
- [ ] No secrets, `.env` files, real customer or site data, logs or build output are committed.

## Index row (new templates only)

<!-- | template/ | For whom | Ivora API features used | Status | -->
