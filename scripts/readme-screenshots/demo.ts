/**
 * A small "shop API" that sends kysely-opentelemetry telemetry to the local
 * Grafana stack from docker-compose.yml. It simulates HTTP requests (as
 * SERVER spans) that run real queries against Postgres: catalogue reads, a
 * search, a checkout transaction that sometimes rolls back, a raw-SQL report
 * and a sign-up that sometimes hits a unique-constraint violation.
 *
 *   docker compose up -d && pnpm start   (see README.md)
 *
 * Environment: DATABASE_URL, OTEL_EXPORTER_OTLP_ENDPOINT (default
 * http://localhost:4318), DEMO_DURATION_SECONDS (default 300).
 */
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { metrics } from '@opentelemetry/api';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { Kysely, PostgresDialect, sql, type Generated } from 'kysely';
import { observeDialect } from 'kysely-opentelemetry';
import pg from 'pg';

// --- OpenTelemetry SDK -------------------------------------------------------

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: 'shop-api',
  [ATTR_SERVICE_VERSION]: '1.4.2',
});
const tracerProvider = new NodeTracerProvider({
  resource,
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
});
tracerProvider.register();
const meterProvider = new MeterProvider({
  resource,
  readers: [
    new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 5_000,
    }),
  ],
});
metrics.setGlobalMeterProvider(meterProvider);
const tracer = trace.getTracer('shop-api');

// --- Database ----------------------------------------------------------------

interface Database {
  customers: { id: Generated<number>; email: string; name: string };
  products: {
    id: Generated<number>;
    name: string;
    category: string;
    price: number;
    stock: number;
    active: boolean;
  };
  orders: {
    id: Generated<number>;
    customer_id: number;
    status: string;
    total: number;
    created_at: Generated<Date>;
  };
  order_items: { order_id: number; product_id: number; quantity: number; price: number };
}

const url = new URL(process.env.DATABASE_URL ?? 'postgres://shop:shop@localhost:5432/shop');
const pool = new pg.Pool({ connectionString: url.toString(), max: 8 });
const dialect = new PostgresDialect({ pool });

// Setup and seeding run unobserved, so the dashboard shows only API traffic.
const admin = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
const db = new Kysely<Database>({
  dialect: observeDialect(dialect, {
    namespace: url.pathname.slice(1),
    serverAddress: url.hostname,
    serverPort: Number(url.port || 5432),
  }),
});

async function setup(): Promise<void> {
  await sql`
    DROP TABLE IF EXISTS order_items, orders, products, customers;
    CREATE TABLE customers (id serial PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL);
    CREATE TABLE products (
      id serial PRIMARY KEY, name text NOT NULL, category text NOT NULL,
      price numeric(10,2) NOT NULL, stock int NOT NULL CHECK (stock >= 0),
      active boolean NOT NULL DEFAULT true);
    CREATE TABLE orders (
      id serial PRIMARY KEY, customer_id int NOT NULL REFERENCES customers,
      status text NOT NULL, total numeric(12,2) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE order_items (
      order_id int NOT NULL REFERENCES orders, product_id int NOT NULL REFERENCES products,
      quantity int NOT NULL, price numeric(10,2) NOT NULL);
    INSERT INTO customers (email, name)
      SELECT 'customer' || g || '@example.com', 'Customer ' || g FROM generate_series(1, 5000) g;
    INSERT INTO products (name, category, price, stock)
      SELECT 'Product ' || g || ' ' || md5(g::text),
             (ARRAY['books','games','garden','kitchen','music','outdoor'])[1 + g % 6],
             round((random() * 200 + 5)::numeric, 2), (random() * 40)::int
      FROM generate_series(1, 60000) g;
    INSERT INTO orders (customer_id, status, total, created_at)
      SELECT 1 + (random() * 4999)::int,
             (ARRAY['paid','paid','paid','shipped','refunded'])[1 + g % 5],
             round((random() * 500)::numeric, 2), now() - random() * interval '90 days'
      FROM generate_series(1, 400000) g;
    INSERT INTO order_items (order_id, product_id, quantity, price)
      SELECT g, 1 + (random() * 59999)::int, 1 + (random() * 3)::int, 19.90
      FROM generate_series(1, 400000) g;
    CREATE INDEX ON order_items (order_id);
    ANALYZE;
  `.execute(admin);
}

// --- Simulated endpoints ------------------------------------------------------

const rand = (max: number) => 1 + Math.floor(Math.random() * max);
const pick = <T>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function listProducts(): Promise<void> {
  await db
    .selectFrom('products')
    .select(['id', 'name', 'price'])
    .where('category', '=', pick(['books', 'games', 'garden', 'kitchen', 'music', 'outdoor']))
    .where('active', '=', true)
    .orderBy('price')
    .limit(24)
    .execute();
}

async function searchProducts(): Promise<void> {
  // An unindexed ILIKE: the query that shows up as the slowest pattern.
  await db
    .selectFrom('products')
    .select(['id', 'name', 'price'])
    .where('name', 'ilike', `%${pick(['blue', 'a1', 'ff', '42', 'deluxe', 'c0'])}%`)
    .limit(20)
    .execute();
}

async function getOrder(): Promise<void> {
  const id = rand(400000);
  await db
    .selectFrom('orders')
    .innerJoin('customers', 'customers.id', 'orders.customer_id')
    .select(['orders.id', 'orders.status', 'orders.total', 'customers.name'])
    .where('orders.id', '=', id)
    .executeTakeFirst();
  await db
    .selectFrom('order_items')
    .innerJoin('products', 'products.id', 'order_items.product_id')
    .select(['products.name', 'order_items.quantity', 'order_items.price'])
    .where('order_items.order_id', '=', id)
    .execute();
}

async function checkout(): Promise<void> {
  const productId = rand(60000);
  // Asking for more than is in stock trips the CHECK (stock >= 0) constraint
  // and rolls the whole transaction back.
  const quantity = Math.random() < 0.12 ? 50 : rand(3);
  try {
    await db.transaction().execute(async (trx) => {
      const product = await trx
        .selectFrom('products')
        .select(['price'])
        .where('id', '=', productId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const order = await trx
        .insertInto('orders')
        .values({
          customer_id: rand(5000),
          status: 'paid',
          total: Number(product.price) * quantity,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await trx
        .insertInto('order_items')
        .values({ order_id: order.id, product_id: productId, quantity, price: product.price })
        .execute();
      await trx
        .updateTable('products')
        .set((eb) => ({ stock: eb('stock', '-', quantity) }))
        .where('id', '=', productId)
        .execute();
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23514') throw new HttpError(409, 'out of stock');
    throw error;
  }
}

async function revenueReport(): Promise<void> {
  // Hand-written SQL with inline literals: they reach Grafana as `?`.
  await sql`
    SELECT date_trunc('day', created_at) AS day, count(*) AS orders, sum(total) AS revenue
    FROM orders
    WHERE status = 'paid' AND created_at > now() - interval '30 days'
    GROUP BY 1 ORDER BY 1 DESC
  `.execute(db);
}

async function signUp(): Promise<void> {
  // Re-registering an existing address fails on the unique index.
  const n = Math.random() < 0.3 ? rand(5000) : 10000 + rand(1_000_000_000);
  try {
    await db
      .insertInto('customers')
      .values({ email: `customer${n}@example.com`, name: `Customer ${n}` })
      .execute();
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new HttpError(409, 'email taken');
    throw error;
  }
}

const routes = [
  { method: 'GET', route: '/products', weight: 30, run: listProducts },
  { method: 'GET', route: '/products/search', weight: 10, run: searchProducts },
  { method: 'GET', route: '/orders/:id', weight: 25, run: getOrder },
  { method: 'POST', route: '/orders', weight: 20, run: checkout },
  { method: 'GET', route: '/reports/revenue', weight: 3, run: revenueReport },
  { method: 'POST', route: '/customers', weight: 8, run: signUp },
] as const;
const totalWeight = routes.reduce((sum, r) => sum + r.weight, 0);

function pickRoute(): (typeof routes)[number] {
  let n = Math.random() * totalWeight;
  for (const route of routes) {
    n -= route.weight;
    if (n < 0) return route;
  }
  return routes[0];
}

async function handleRequest(): Promise<void> {
  const { method, route, run } = pickRoute();
  await tracer.startActiveSpan(
    `${method} ${route}`,
    {
      kind: SpanKind.SERVER,
      attributes: { 'http.request.method': method, 'http.route': route },
    },
    async (span) => {
      let status = 200;
      try {
        await run();
      } catch (error) {
        status = error instanceof HttpError ? error.status : 500;
        if (status >= 500) span.setStatus({ code: SpanStatusCode.ERROR });
      } finally {
        span.setAttribute('http.response.status_code', status);
        span.end();
      }
    },
  );
}

// --- Main ----------------------------------------------------------------------

const durationMs = Number(process.env.DEMO_DURATION_SECONDS ?? 300) * 1000;
console.log('Seeding the shop database...');
await setup();
console.log(`Generating traffic for ${durationMs / 1000}s. Open Grafana to watch it.`);
const deadline = Date.now() + durationMs;
await Promise.all(
  Array.from({ length: 12 }, async () => {
    while (Date.now() < deadline) {
      await handleRequest();
      await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 120));
    }
  }),
);
await db.destroy();
await tracerProvider.shutdown();
await meterProvider.shutdown();
console.log('Done.');
