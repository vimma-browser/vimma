# OpenAPI description fixtures

Cut-down copies of three published OpenAPI descriptions, for the agent APIs' converter tests
(`openapi-index.test.ts`; spec [agent-apis](../../../../../docs/specs/agent-apis.md), "Research"
and "Tests"). They keep the real shapes the converter must read (references to shared
parameters and schemas, JSON and form bodies, descriptions with markup, a relative `servers`
entry) at a size that fits the repository.

| File            | Source                                                                                                                                                  | Licence                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `github.json`   | `descriptions/api.github.com/api.github.com.json` of [github/rest-api-description](https://github.com/github/rest-api-description) at `d560905b`, 3.0.3 | MIT ([LICENSE](https://github.com/github/rest-api-description/blob/main/LICENSE.md))                 |
| `stripe.json`   | `openapi/spec3.json` of [stripe/openapi](https://github.com/stripe/openapi) at `a8f2a259`, 3.0.0                                                        | MIT ([LICENSE](https://github.com/stripe/openapi/blob/master/LICENSE))                               |
| `petstore.json` | `https://petstore3.swagger.io/api/v3/openapi.json` (Swagger Petstore 1.0.27, 3.0.4), whole                                                              | Apache-2.0 (its `info.license`; [swagger-petstore](https://github.com/swagger-api/swagger-petstore)) |

How the two large files were cut, on 2026-11-28:

- `github.json` keeps the paths `/repos/{owner}/{repo}/issues`,
  `/repos/{owner}/{repo}/issues/{issue_number}`, `/search/issues`, `/user` and `/markdown`
  (8 operations of 1,281), and every component they reference, directly or through other
  components.
- `stripe.json` keeps `/v1/customers`, `/v1/customers/{customer}`, `/v1/customers/search`,
  `/v1/balance` and `/v1/tax_rates` (9 operations of 612) and the components they reference
  directly. A component referenced only through another one is replaced by
  `{ "type": "object", "description": "Cut from this fixture: see README.md." }`, because
  Stripe's components reference one another so widely that following them all keeps most of the
  8 MB file.
- Both drop the keys `examples`, `example`, `externalDocs` and the vendor extensions
  (`x-github`, `x-stripe*`, `x-expandableFields`, `x-resourceId`), which the converter does not
  read, and are formatted by prettier.

The full files index in about 85 ms (GitHub, 14.28 MB) and 65 ms (Stripe, 8.32 MB) after
parsing, on Node 26 on the machine that cut them.
