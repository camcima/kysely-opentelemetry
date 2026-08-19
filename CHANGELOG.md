# Changelog

## [0.2.1](https://github.com/camcima/kysely-opentelemetry/compare/v0.2.0...v0.2.1) (2026-08-19)

### Bug Fixes

* architecture review findings — raw-SQL table extraction, queryText validation, diag warnings, package-shape checks ([#23](https://github.com/camcima/kysely-opentelemetry/issues/23)) ([28ad28f](https://github.com/camcima/kysely-opentelemetry/commit/28ad28f8be34694dc9756dc3599c108a04b1d9cc))

## [0.2.0](https://github.com/camcima/kysely-opentelemetry/compare/v0.1.1...v0.2.0) (2026-07-10)

### Features

* **analysis:** add stripSqlComments sharing the maskSqlText scanner ([d099b0c](https://github.com/camcima/kysely-opentelemetry/commit/d099b0ca9cb039cac64681ad11e4dc38d9f4dedc))
* **options:** add recordErrorMessages opt-out for span status messages ([c582bca](https://github.com/camcima/kysely-opentelemetry/commit/c582bca90e253a705f5f38a09c25058e0b97defb))

### Bug Fixes

* **analysis:** blank unterminated SQL regions in stripSqlComments (fail closed) ([414427d](https://github.com/camcima/kysely-opentelemetry/commit/414427dae5f5b3d0f725b3fbd64b4a79888deb27))
* **analysis:** strip SQL comments from fingerprints and sanitized query text ([bf8ee78](https://github.com/camcima/kysely-opentelemetry/commit/bf8ee786f05797d8a3f91fe8faa32490f6fba0a3))
* **dialect:** recognize wrappers from other package copies via Symbol.for marker ([9c1ffb7](https://github.com/camcima/kysely-opentelemetry/commit/9c1ffb70954e72f0244415ddf7c2442ac60a7936))
* **dialect:** route isObserved marker cast through unknown ([75911d8](https://github.com/camcima/kysely-opentelemetry/commit/75911d8489d6c3c34bf64872c7d9f8288bb54b0e))
* **options:** validate maxQueryTextLength, falling back to the default on invalid input ([e861fab](https://github.com/camcima/kysely-opentelemetry/commit/e861fab16d2301777167470075cf15238600fa6b))
* **stream:** end the query span when the inner streamQuery throws synchronously ([a26e307](https://github.com/camcima/kysely-opentelemetry/commit/a26e307c951265b1939562f395e7b8d45873e034))
* **test:** stop hardcoding the package version in the smoke test ([2b77715](https://github.com/camcima/kysely-opentelemetry/commit/2b7771591754071e8dedd44086ccc357977caac5))

## [0.1.1](https://github.com/camcima/kysely-opentelemetry/compare/v0.1.0...v0.1.1) (2026-07-07)

### Features

* add cached query analyzer producing QueryContext ([ad5e547](https://github.com/camcima/kysely-opentelemetry/commit/ad5e5471615e18df570eb1919ef25b768e661350))
* add db.query.summary generation ([70fca93](https://github.com/camcima/kysely-opentelemetry/commit/70fca93228a651b66b4a83ffe0b0b7a916a2d615))
* add internal LRU cache ([b087ab1](https://github.com/camcima/kysely-opentelemetry/commit/b087ab10fa68babb7cdb4ca1c6512db873c1b386))
* add ObservedConnection with query and stream spans ([c38453a](https://github.com/camcima/kysely-opentelemetry/commit/c38453a2b2d558b2017d7223ac62ee00c19c6d9a))
* add ObservedDriver with transaction spans and pool acquire timing ([4fab071](https://github.com/camcima/kysely-opentelemetry/commit/4fab071866bc0d533a2a6762afe88f6a675b3738))
* add observeDialect public API ([83e7b67](https://github.com/camcima/kysely-opentelemetry/commit/83e7b676ac15a1aa003302155c898af20b0b64cc))
* add options interface with safe defaults ([ee6dcf0](https://github.com/camcima/kysely-opentelemetry/commit/ee6dcf02931f2067207a24cc065455cd6830d1f6))
* add regex SQL fingerprinting ([39b3bb9](https://github.com/camcima/kysely-opentelemetry/commit/39b3bb968f5d276d90d3646aae6f3caa90d2a3ba))
* add sha256 fingerprint hash ([8389b8d](https://github.com/camcima/kysely-opentelemetry/commit/8389b8ddab88b5093d1e4c615ae44ce86a3256cb))
* add span attribute constants and builder ([846d173](https://github.com/camcima/kysely-opentelemetry/commit/846d173114d52c44eb60bfb955b724b35c7b330e))
* add span error recording and duration histogram ([a7af9cc](https://github.com/camcima/kysely-opentelemetry/commit/a7af9cce6247afdfb6061ea865d9f2d871a613a0))
* auto-detect db.system.name from dialect adapter ([2e3fb9e](https://github.com/camcima/kysely-opentelemetry/commit/2e3fb9e3f22a65745fe3d2f6c80e7b74920898ac))
* db.namespace, server.address and server.port via options ([e5ec14c](https://github.com/camcima/kysely-opentelemetry/commit/e5ec14cf675bb6fd59058c4a9b15e75bf66adeb2))
* derive operation name from Kysely AST ([08ba503](https://github.com/camcima/kysely-opentelemetry/commit/08ba503b2f534d3476fbbaeee73514d474abf4b0))
* extract table names from Kysely AST and raw SQL ([29e19c7](https://github.com/camcima/kysely-opentelemetry/commit/29e19c7d5e57607228e278c7fdf82e958058d459))
* harden telemetry analysis and metrics from self-review ([e6d8d6d](https://github.com/camcima/kysely-opentelemetry/commit/e6d8d6d9213e777ca49690df80f8532f8ceb4fe4))
* kysely.query.tables_truncated attribute for capped table lists ([298f382](https://github.com/camcima/kysely-opentelemetry/commit/298f382185c8c9a02f584640c004d435d48c4bb6))
* optional tracerProvider/meterProvider injection ([9b5a92c](https://github.com/camcima/kysely-opentelemetry/commit/9b5a92ce02ca0b90c97cabf23921bc5585fa22de))
* public ObservedDialect constructor and double-wrap guard ([3cc14b4](https://github.com/camcima/kysely-opentelemetry/commit/3cc14b455e26515b3a808c43fb1fe83bfa4ca4d9))
* recover db.system.name across duplicated kysely instances ([c4e6347](https://github.com/camcima/kysely-opentelemetry/commit/c4e634738893dca2f2ec78fd1f9edcc13cbe27e2))
* shouldObserve filter to skip spans and metrics per query ([ded78b7](https://github.com/camcima/kysely-opentelemetry/commit/ded78b770e397ee0987d93b762f2ef73aa085a49))

### Bug Fixes

* address final-review findings (stream metric hygiene, release safety, docs) ([624b4d3](https://github.com/camcima/kysely-opentelemetry/commit/624b4d393c88b23f7be50d6f0818a7b83e5b312b))
* cap instrumentation warnings per failure context with accurate messages ([9986a96](https://github.com/camcima/kysely-opentelemetry/commit/9986a969eaf1517d1b30c5cd5773e86a9324dbed))
* **ci:** drop Node 18 (vitest 4 needs 20+) and ignore npm ecosystem in osv-scanner ([212f367](https://github.com/camcima/kysely-opentelemetry/commit/212f36764dee2f112b4753499a66e5a97d875702))
* **ci:** read pnpm version from packageManager, not a version input ([9c93766](https://github.com/camcima/kysely-opentelemetry/commit/9c93766e9e8ae21ffb3729e87919ff454a7186ef))
* close abandoned stream spans on connection release and never rethrow undefined ([54b84a7](https://github.com/camcima/kysely-opentelemetry/commit/54b84a75e10a347a94c0e5234b8b93a34e88f44d))
* de-ambiguate fingerprint single-quote regex to prevent ReDoS ([92353c5](https://github.com/camcima/kysely-opentelemetry/commit/92353c5f4d14e4c5443ce924944490e105388067))
* guard stream returned_rows setAttribute and drop unused finishSuccess param ([5af4074](https://github.com/camcima/kysely-opentelemetry/commit/5af4074384f110b46dd871184bd2a294127b637a))
* handle backslash-escaped quotes and document double-quote limitation in fingerprint ([f1d891c](https://github.com/camcima/kysely-opentelemetry/commit/f1d891cc5214d50776a2ba76e7efb4793cc89f13))
* include query kind in analyzer cache key to prevent raw/builder collision ([17309a7](https://github.com/camcima/kysely-opentelemetry/commit/17309a71ffb30f379e6484882391a75301fba8cb))
* nest exports types per condition and document error.message telemetry channel ([eef4b57](https://github.com/camcima/kysely-opentelemetry/commit/eef4b57304ae6415158b1f8eae518cde52fc80c8))
* parent transaction queries under user-created spans when present ([be51a24](https://github.com/camcima/kysely-opentelemetry/commit/be51a2435f794b29e1d8b7d81b886f0d3308f94f))
* point legacy types field at the CJS declaration file ([4946704](https://github.com/camcima/kysely-opentelemetry/commit/49467042290e30dd6c1855ced81ac1afb3ef074f))
* re-truncate after redact, hash full fingerprint, freeze cached tables ([afc6d98](https://github.com/camcima/kysely-opentelemetry/commit/afc6d98832af11465fb5bd19172c0f3e816ed666))
* respect summary option on the duration metric's attributes ([d7567be](https://github.com/camcima/kysely-opentelemetry/commit/d7567be10ae7851ef2b432d28ff9c3de96a03731))
* skip analyzer-cache admission for SQL over 32KB to bound memory ([85ba23a](https://github.com/camcima/kysely-opentelemetry/commit/85ba23a46b141509e808804de79239b91d536e18))
* tag backstop-closed stream spans with kysely.stream.outcome ([f6e1be1](https://github.com/camcima/kysely-opentelemetry/commit/f6e1be18aa94c4c151cae91516d2b70707b37c53))
