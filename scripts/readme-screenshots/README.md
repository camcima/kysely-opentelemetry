# README screenshots

This setup produces the Grafana screenshots in the main README (`assets/grafana-*.png`). It starts Grafana's all-in-one [`otel-lgtm`](https://github.com/grafana/docker-otel-lgtm) image (Grafana, Tempo, Prometheus and an OpenTelemetry Collector) next to Postgres. It then runs a small simulated shop API that queries Postgres through Kysely and this library, and exports traces and metrics over OTLP.

For a fuller example application, see [`kysely-opentelemetry-examples`](https://github.com/camcima/kysely-opentelemetry-examples).

## Run it

From the repository root, build the library (this package installs it from `../..`):

```bash
pnpm install && pnpm build
```

Then start the stack and the traffic generator:

```bash
cd scripts/readme-screenshots
docker compose up -d
pnpm install --ignore-workspace
pnpm start
```

Open <http://localhost:3000> (user `admin`, password `admin`) and go to **Dashboards → Kysely · Database queries**. Traces are under **Explore → Tempo**: search for service `shop-api`.

If ports 3000 or 5432 are taken, choose others:

```bash
GRAFANA_PORT=3300 POSTGRES_PORT=55432 docker compose up -d
DATABASE_URL=postgres://shop:shop@localhost:55432/shop pnpm start
```

Stop everything with `docker compose down`.

## What the traffic looks like

`demo.ts` seeds a shop database (60k products, 400k orders), then runs 12 concurrent workers for five minutes (set `DEMO_DURATION_SECONDS` to change that). Each simulated request is a `SERVER` span with Kysely query spans nested under it:

| Route                  | What it does                                                                     |
| ---------------------- | -------------------------------------------------------------------------------- |
| `GET /products`        | Category listing.                                                                |
| `GET /products/search` | Unindexed `ILIKE` search.                                                        |
| `GET /orders/:id`      | Two joined reads.                                                                |
| `POST /orders`         | Checkout transaction. About 12% roll back on a `CHECK (stock >= 0)` violation.   |
| `GET /reports/revenue` | Hand-written `sql` with inline literals, which appear as `?` in `db.query.text`. |
| `POST /customers`      | Sign-up. About 30% fail on the unique email index (`error.type` = `23505`).      |

The dashboard (`grafana/kysely-dashboard.json`) uses only what the library emits: the `db.client.operation.duration` and `db.client.connection.wait_time` histograms grouped by `db.query.summary` and `error.type`, and a TraceQL query over the spans.

## Retaking the screenshots

Let the traffic run for at least 20 minutes so a 15-minute window starts after the warm-up ramp. Then capture, at 1x scale:

- `grafana-dashboard.png`: the dashboard in kiosk mode (`?kiosk&from=now-15m&to=now`) at a 1600×1180 viewport.
- `grafana-trace-transaction.png`: a `POST /orders` trace that rolled back (TraceQL `{ span.kysely.transaction.outcome = "rolled_back" }`), with the failing `UPDATE products` span expanded. Close the navigation menu and crop to the trace panel.
- `grafana-trace-raw-sql.png`: a `GET /reports/revenue` trace with its `SELECT orders` span expanded, cropped the same way.
