# How templates relate to Ivora

Polished templates are welcome. Neutrality is about who owns and operates a template, not how good it is.

1. Ivora never hosts or operates a template as its own service. You deploy it in your own account, under your own brand.
   - **Exception: Ivora-run hosted demos.** Ivora may run a hosted demo of a template where a visitor connects one of their own projects to see it with their own data, within exactly these limits ([design](connect-and-app-modes.md)). The demo reads with read-only scopes and never offers write access; it stores no refresh token; the connection ends with the browser session or after a short fixed time, and Disconnect revokes it; nothing from the visitor's project is persisted; and a "Live data from your project" banner is always shown. The demo never makes changes in the project, takes payments, serves drivers, registers webhooks or runs as an installable app. Anything beyond these limits is operation, and you run it in your own deployment.
2. Templates use only the public Ivora API, nothing a partner or customer can't use.
3. They are Apache-2.0 starting points that you own and may fork, rebrand and sell.
4. Ivora never uses platform data to build or tune a template that competes with a customer's or partner's product.
5. Partner-built apps get equal listing next to Ivora's templates.
6. Ivora earns only from the platform, never from a template, and never holds the driver or customer relationship.

Ivora's own apps, such as Squid, are listed separately in the README, use only the public API, pay the same platform fee and get no data privilege.

## Review rule

A pull request fails review if it adds any of the following:

- Ivora-hosted operation of a template, meaning anything Ivora runs beyond the hosted-demo exception in rule 1 (for example write access, stored refresh tokens or project data, or serving drivers from an Ivora-run deployment).
- A fee or charge that exists only because of the template.
- A call to any non-public Ivora API.
