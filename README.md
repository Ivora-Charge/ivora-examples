# ivora-examples

Open-source starter apps for EV charging businesses, built on the Ivora API.

Each template is a complete, deployable web application for one kind of charging business. You fork it, connect your own Ivora project and payment provider, and run your copy on your own domain. Ivora provides the charger connectivity, sessions, tariffs and billing data through its API; the app, its data and its customers are yours.

Everything here is licensed under [Apache-2.0](LICENSE).

## Templates

| Template                                                             | For whom                                         | Ivora API features used                                                          | Status                                                   | Live demo                                                   |
| -------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| [`installer-kit/`](installer-kit/)                                   | Installers and hardware sellers                  | Station provisioning, OCPP connection details, station status, remote operations | Demo ready; live mode not yet run against a real project | [Demo](https://ivora-example-installer-kit.vercel.app)      |
| [`forecourt-checkout/`](forecourt-checkout/)                         | Fuel and convenience sites with DC fast chargers | Stations and connectors, tariffs, externally funded charging sessions, webhooks  | Demo ready; live mode not yet run against a real project | [Demo](https://ivora-example-forecourt-checkout.vercel.app) |
| [`fleet-depot/`](fleet-depot/)                                       | Fleet depots                                     | RFID authorization, charging sessions, meter values, bills, webhooks             | Demo ready; live mode not yet run against a real project | [Demo](https://ivora-example-fleet-depot.vercel.app)        |
| [Squid](https://github.com/Ivora-Charge/squid) (separate repository) | Vacation-rental hosts                            | Station provisioning, tariffs, externally funded charging sessions, webhooks     | Live                                                     | -                                                           |

- **installer-kit/**: connect a charger, test it, and print a QR sticker for the site.
- **forecourt-checkout/**: drivers pay at the charger with a card, no app or account.
- **fleet-depot/**: RFID cards per driver, charging scheduled to finish by departure time, and cost per vehicle.
- **Squid**: hosts let guests pay for charging by scanning a QR code. It is the first live example and the reference app for the conventions below.

The live demos run in demo mode: sample data, no keys, nothing charged and no charger contacted.

## How templates are organised

Each template lives in its own top-level folder and is self-contained:

- Node.js 22, Next.js App Router, TypeScript and npm, with its own `package.json`, lockfile, `README.md` and `.env.example`.
- A demo mode that runs offline with no credentials and clearly labelled sample data.
- Its own CI workflow at `.github/workflows/<folder>.yml`, limited to changes in that folder, running format, typecheck, unit tests and build.
- A README covering who it is for, a demo screenshot, running locally, connecting real services, deploying, which Ivora API features it uses, and its limits.

To try a template, open its folder and follow its README. Most start with:

```sh
cd <template>
npm ci
npm run dev
```

All templates follow the shared [conventions](docs/conventions.md): server-side API keys, one Ivora project per deployment, verified webhooks, idempotent writes, consistent units, and QR codes on your own domain.

## Ivora API

The [Ivora developer portal](https://ivoracharge.com/developers/guides) documents the API, including [errors and statuses](https://ivoracharge.com/developers/guides/reference/errors). The schema is published as [OpenAPI](https://api.ivoracharge.com/openapi.json).

## Contributing and security

- [CONTRIBUTING.md](CONTRIBUTING.md) explains how to propose a template or change one, and the checks every pull request must pass.
- [SECURITY.md](SECURITY.md) explains how to report a vulnerability privately. Never report one in a public issue.

## License

[Apache-2.0](LICENSE)
