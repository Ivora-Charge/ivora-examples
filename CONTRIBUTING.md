# Contributing

Thanks for helping build starter apps for EV charging businesses. This guide covers proposing a new template, changing an existing one, and the checks every pull request must pass.

By contributing, you agree that your contribution is licensed under [Apache-2.0](LICENSE).

## Propose a template

1. Open an issue with the **Template proposal** form. Describe who the template is for, the problem it solves, which Ivora API features it uses, and what its demo mode shows.
2. Wait for a maintainer to agree on scope and a folder name before writing code. A template should serve one kind of charging business well, not overlap heavily with an existing one.
3. Build the template in its own top-level folder, following the [conventions](docs/conventions.md).
4. Add its CI workflow at `.github/workflows/<folder>.yml`, with a `paths` filter on the folder and the workflow file.
5. Suggest the row for the template index in your pull request description. Maintainers update the root `README.md`.

## Change a template

- Keep a pull request to one template. Do not edit another template's folder or workflow in the same change.
- Root files (`README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/`, `.github/` outside your workflow) change in their own pull requests.
- Update the template's README and `.env.example` when you add or change environment variables, setup steps or Ivora API usage.
- For bugs, open an issue with the **Bug report** form first unless the fix is small and obvious.

## Required for every template

- **Demo mode.** The template runs with `npm ci && npm run dev` and no credentials or network access. Demo data is clearly labelled, and demo mode never sends payment requests, charger commands or emails.
- **Server-side credentials.** The Ivora API key and tenant ID are only read on the server.
- **Webhooks and writes.** Webhook signatures are verified, and writes to the Ivora API send idempotency keys.
- **README.** Who it is for, a demo screenshot, run locally, connect real services (environment variable table), deploy (a Deploy to Vercel button), what it uses from the Ivora API, limits and next steps.

## Required checks

Run these in the template folder before opening a pull request. CI runs the same commands.

```sh
npm ci
npm run format:check
npm run typecheck
npm test
npm run build
```

Tests must not need real credentials or network access.

For changes to root files, CI checks Markdown formatting with Prettier and that relative links resolve. To check locally from the repository root:

```sh
npx prettier@3.6.2 --check "*.md" "docs/**/*.md" ".github/**/*.md" ".github/*.yml" ".github/ISSUE_TEMPLATE/*.yml" ".github/workflows/repo.yml" ".github/scripts/*.mjs"
node .github/scripts/check-relative-links.mjs
```

## Never commit

- API keys, webhook secrets, passwords or other credentials, and `.env` files other than `.env.example`.
- Real customer, driver, site or charger data. Use clearly fictional sample data.
- Build output, logs or databases.

If you find a security issue, follow [SECURITY.md](SECURITY.md) instead of opening an issue or pull request.
