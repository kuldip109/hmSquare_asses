# Backend Orders Ingestion Service

A Node.js service that ingests an orders CSV (~10,000 records), uploads the
raw file to Google Cloud Storage using Application Default Credentials
(ADC), and stores the parsed data in a horizontally-sharded PostgreSQL
layer — built for the Backend Engineering Assessment.

## 1. Tech Stack

- Node.js (Express)
- PostgreSQL (application-level sharding, 4 shards by default)
- Google Cloud Storage (`@google-cloud/storage`, ADC-only auth)
- `csv-parser` for streaming CSV parsing
- `multer` (disk storage) for file upload
- `winston` for logging

## 2. Project Structure

```
src/
  app.js                    Express app + route wiring
  server.js                 Entrypoint, graceful shutdown
  config/env.js             Central env/config loader
  db/pool.js                Creates one pg Pool per shard
  db/shardRouter.js         hash(customer_id) -> shard routing
  services/gcsService.js    GCS upload via ADC
  services/fileProcessorService.js   Streaming parse + per-shard batch insert
  services/orderService.js  Batch insert / idempotent upsert / reads
  services/jobService.js    In-memory job/status tracking
  validators/orderValidator.js       Row validation & normalization
  routes/                   upload, order, health/metrics routes
  middleware/errorHandler.js
migrations/001_init_shard.sql   Schema applied to every shard DB
scripts/setup-shards.js         Creates shard DBs + runs migration
scripts/generate-sample-csv.js  Generates a ~10k row test file
tests/orderValidator.test.js    Unit tests (validator + shard hashing)
```

## 3. Prerequisites

- Node.js 18+ (20 recommended)
- PostgreSQL 14+ running locally (or via Docker)
- A Google Cloud project with a GCS bucket
- `gcloud` CLI installed (for ADC)

## 4. Local Setup (step by step)

### Step 1 — Install dependencies

```bash
cd backend-assessment
npm install
```

### Step 2 — Configure environment

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```
GCP_PROJECT_ID=<your-gcp-project-id>
GCS_BUCKET_NAME=<your-bucket-name>
```

Leave the `DB_*` and `SHARD_COUNT` values as-is for local dev (they assume
a local PostgreSQL server on `localhost:5432` with user `postgres` /
password `postgres` — adjust to match your local Postgres install).

### Step 3 — Start PostgreSQL

Either use your existing local Postgres server, **or** start one with Docker:

```bash
docker run --name orders-postgres -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres:16-alpine
```

### Step 4 — Create the shard databases and schema

This creates `orders_shard_0` … `orders_shard_3` (4 shards by default) and
applies `migrations/001_init_shard.sql` to each one:

```bash
npm run setup:shards
```

You should see output like:

```
Created database: orders_shard_0
Applied migration to: orders_shard_0
...
All shards are set up.
```

Re-running this command is safe — it's idempotent.

### Step 5 — Authenticate to Google Cloud with ADC

**This is the important part of requirement 7 — no key files are used.**

```bash
gcloud auth login
gcloud config set project <your-gcp-project-id>
gcloud auth application-default login
```

The last command opens a browser, logs you in, and writes credentials to
`~/.config/gcloud/application_default_credentials.json`. The
`@google-cloud/storage` client library automatically discovers and uses
this file — nothing needs to be referenced in code or `.env`.

Make sure the bucket exists (or create it):

```bash
gsutil mb -l us-central1 gs://<your-bucket-name>
```

Grant your ADC identity (your own Google account, in local dev) the
`Storage Object Admin` role on the bucket/project if uploads fail with a
permission error.

### Step 6 — Run the server

```bash
npm start
```

You should see:

```
Server listening on port 3000 (development)
Configured for 4 shard(s)
```

### Step 7 — Generate a sample file and test the upload

```bash
node scripts/generate-sample-csv.js 10000 sample-orders.csv

curl -X POST http://localhost:3000/upload-orders \
  -F "file=@sample-orders.csv"
```

Response:

```json
{ "message": "File accepted and is being processed", "jobId": "…", "statusUrl": "/upload-orders/…" }
```

### Step 8 — Poll job status

```bash
curl http://localhost:3000/upload-orders/<jobId>
```

```json
{
  "jobId": "…",
  "status": "completed",
  "totalRows": 10000,
  "insertedRows": 9897,
  "failedRows": 103,
  "gcsPath": "gs://<bucket>/orders/<jobId>/sample-orders.csv"
}
```

### Step 9 — Try the read endpoints

```bash
curl "http://localhost:3000/orders?customerId=cust-42"
curl "http://localhost:3000/orders/<some-order-id>"
curl http://localhost:3000/health
curl http://localhost:3000/metrics
```

### Step 10 — Run tests

```bash
npm test
```

## 5. Running with Docker (bonus)

```bash
cp .env.example .env   # fill in GCP_PROJECT_ID / GCS_BUCKET_NAME
docker compose up --build
```

`docker-compose.yml` starts a Postgres container plus the app container,
and mounts your **host's** `~/.config/gcloud` folder read-only into the
container so the app can reuse your `gcloud auth application-default
login` credentials — no key file is ever baked into the image. After the
containers are up, run the shard setup once against the containerized DB:

```bash
docker compose exec app npm run setup:shards
```

## 6. Sharding Strategy (requirement 4)

**Chosen approach:** application-level sharding, shard key = `hash(customer_id) % SHARD_COUNT`.

- Each shard is a fully independent PostgreSQL database
  (`orders_shard_0` … `orders_shard_N`), each with an identical schema.
- `src/db/shardRouter.js` computes the shard index for a given
  `customer_id` (MD5 hash of the key, mod shard count — see
  `src/utils/hash.js`) and returns the corresponding connection pool.
- On ingestion, every validated row is routed to its shard by
  `customer_id`, buffered, and flushed via a single multi-row `INSERT`
  per batch, per shard.

**Why `customer_id` over `order_id` or time-based sharding:**

| Option | Trade-off |
|---|---|
| `customer_id` (chosen) | Most queries are "orders for a customer" → single-shard read. Good cardinality → even write distribution. Downside: looking up a single order by `order_id` alone requires scatter-gather. |
| `hash(order_id)` | Perfectly even distribution, but *every* useful query (by customer) becomes scatter-gather, which is worse for the common case. |
| time-based (`order_date`) | Great for time-range analytics/archival, but recent shards become write hotspots (all new orders land on the newest shard). |

**Where this shows up in the code:**
- `GET /orders?customerId=` — single-shard query (fast path).
- `GET /orders/:orderId` — scatter-gather across all shards, since
  `order_id` doesn't encode shard placement under this strategy. This is
  an explicit, documented trade-off rather than an oversight.

**Adding shards later:** because routing is a pure hash function of
`customer_id`, growing `SHARD_COUNT` requires a re-sharding/data migration
step (standard for hash-based sharding — consistent hashing or a
shard-mapping table are the usual production upgrades, called out below).

## 7. How ADC is configured (requirement 7)

- `src/services/gcsService.js` constructs `new Storage({ projectId })`
  with **no** `keyFilename` or embedded credentials.
- Locally: `gcloud auth application-default login` writes a credentials
  file outside the repo; the client library finds it automatically via the
  standard ADC lookup chain.
- In GCP (Cloud Run / GKE / GCE): the attached service account (ideally
  via Workload Identity) is picked up automatically — no code change
  needed.
- `.gitignore` excludes `.env` and any key files; `.env.example` only
  documents an optional `GOOGLE_APPLICATION_CREDENTIALS` path for edge
  cases, with an explicit warning never to commit it.

## 8. Performance & Scalability (requirement 5)

- **Streaming, not buffering:** the file is read with
  `fs.createReadStream` piped through `csv-parser`; rows are processed one
  at a time and the whole file is never materialized in memory.
- **Per-shard batching:** rows are grouped into an in-memory buffer per
  shard and flushed with one multi-row `INSERT ... VALUES (...), (...), ...`
  once a buffer reaches `BATCH_SIZE` (default 500) — never one-by-one.
- **Transactions:** each batch flush runs inside `BEGIN … COMMIT`, with
  `ROLLBACK` on any error, so a bad batch can't partially land.
- **Backpressure:** the source stream is `.pause()`d while a flush is
  in-flight and `.resume()`d once it completes, so buffered memory stays
  bounded regardless of file size or DB latency.
- **Idempotency:** `orders.order_id` has a `UNIQUE` constraint and inserts
  use `ON CONFLICT (order_id) DO NOTHING`, so re-uploading the same file or
  retrying a failed job never creates duplicates.
- **Background processing:** `POST /upload-orders` responds `202
  Accepted` immediately with a `jobId`; the GCS upload and DB ingestion
  happen after the response is sent. Status is polled via `GET
  /upload-orders/:jobId`.

## 9. Error Handling & Logging (requirement 8)

- Invalid rows (bad date, missing `customer_id`, invalid `status`, etc.)
  are **not** dropped silently — they're written to a `failed_orders`
  table (`raw_row` + `error`), and counted in the job status response.
- File-filter rejects non-CSV uploads with a 4xx before any processing
  starts.
- All unhandled route errors flow through `src/middleware/errorHandler.js`
  and are logged with `winston` (console + `logs/error.log` +
  `logs/combined.log`).
- `GET /health` checks connectivity to every shard individually and
  reports per-shard status.
- `GET /metrics` reports job counts by status and total rows
  inserted/failed across all jobs (in-memory, resets on restart).

## 10. Design Decisions & Trade-offs

- **In-memory job tracking:** sufficient for a single-instance
  assessment/demo. For a real multi-instance deployment, job state should
  move to a durable store (e.g. a `jobs` table, or a real queue like
  Cloud Tasks / BullMQ + Redis / pg-boss) so status survives restarts and
  is visible across instances. Called out as a clear "next step" rather
  than implemented, to keep scope in the 24-hour budget.
- **Shard databases on one Postgres server for local dev:** the
  `SHARD_URLS` env var lets each shard point at a genuinely separate host
  in production without any code change.
- **Failed rows have no natural shard key** (a row can be invalid
  *because* `customer_id` itself is missing), so all `failed_orders` are
  written to a single fixed "home" shard (shard 0) rather than scattered
  unpredictably.
- **CSV only:** the spec allows CSV or Excel; CSV was chosen because it
  streams naturally and is the more common ingestion format for
  high-volume batch data. Excel (`.xlsx`) support could be added with a
  streaming SAX-style reader (e.g. `xlsx-stream-reader`) behind the same
  `fileProcessorService` interface.
- **Status enum:** `orderValidator.js` restricts `status` to a fixed set
  (`pending, processing, shipped, delivered, cancelled, refunded`) to
  demonstrate real validation; this list is easy to change to match a
  real system's domain.

## 11. API Summary

| Method | Path | Description |
|---|---|---|
| POST | `/upload-orders` | Upload a CSV file (`multipart/form-data`, field `file`). Returns `202` + `jobId`. |
| GET | `/upload-orders/:jobId` | Poll ingestion job status/counts. |
| GET | `/orders?customerId=` | List recent orders for a customer (single-shard). |
| GET | `/orders/:orderId` | Look up one order by ID (scatter-gather). |
| GET | `/health` | Per-shard DB connectivity check. |
| GET | `/metrics` | Aggregate job/row counters. |
