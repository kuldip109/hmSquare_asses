# Order Ingestion Backend — Backend Engineering Assessment

This is my submission for the Backend Engineering Assessment. It's a Node.js
service that takes an orders CSV file, uploads it to Google Cloud Storage,
validates and parses every row, and writes the data into a sharded
PostgreSQL setup so it can scale horizontally as order volume grows.

Below I've covered setup instructions, how I configured Google ADC, why I
picked the sharding approach I did, and the trade-offs I made along the way.

## Tech stack

- Node.js + Express for the API
- PostgreSQL, split across 4 shards (application-level sharding)
- Google Cloud Storage for storing the raw uploaded file, using ADC only
- `csv-parser` for streaming the file instead of loading it into memory
- `multer` for handling the multipart upload
- `winston` for logging

## Project layout

```
src/
  app.js                    Express app setup and route mounting
  server.js                 Entry point, starts the server, handles shutdown
  config/env.js             Loads and validates environment variables
  db/pool.js                Opens one connection pool per shard
  db/shardRouter.js         Decides which shard a customer_id belongs to
  services/gcsService.js    Handles the GCS upload (ADC-based)
  services/fileProcessorService.js   Streams the CSV, batches rows, inserts them
  services/orderService.js  The actual insert/lookup queries
  services/jobService.js    Tracks upload job status in memory
  validators/orderValidator.js       Row-level validation
  routes/                   upload, orders, health/metrics endpoints
  middleware/errorHandler.js
migrations/001_init_shard.sql   Schema, applied to every shard
scripts/setup-shards.js         Creates the shard databases and runs the migration
scripts/generate-sample-csv.js  Generates a test CSV with ~10k rows
tests/orderValidator.test.js    A few unit tests for validation and shard routing
```

## Before you start

You'll need:
- Node.js 18 or newer
- PostgreSQL running locally (I used a native Windows install, though Docker
  works fine too if you already have it set up)
- A Google Cloud project with a Cloud Storage bucket
- The `gcloud` CLI installed

## Setup instructions

### 1. Install dependencies

```bash
cd backend-assessment
npm install
```

### 2. Set up your environment file

```bash
cp .env.example .env
```

Then open `.env` and fill in your own values for:

```
GCP_PROJECT_ID=<your-project-id>
GCS_BUCKET_NAME=<your-bucket-name>
```

The database settings can stay as-is if you're running Postgres locally
with the default `postgres` user — just make sure the password matches
whatever you set when you installed Postgres.

### 3. Make sure PostgreSQL is running

If you're on Windows, the easiest route is installing Postgres directly
(https://www.postgresql.org/download/windows/) rather than fighting with
Docker Desktop. Just remember the password you set for the `postgres` user
during install — it needs to match your `.env`.

### 4. Create the shard databases

This is the part that actually sets up the 4 shard databases
(`orders_shard_0` through `orders_shard_3`) and applies the schema to each:

```bash
npm run setup:shards
```

This is safe to run more than once — it checks if a database already
exists before trying to create it.

### 5. Authenticate with Google Cloud (ADC)

This is the important bit for requirement 7 — no key files anywhere:

```bash
gcloud auth login
gcloud config set project <your-project-id>
gcloud auth application-default login
```

The last command is the one that matters. It logs you in through the
browser and stores credentials locally, which the `@google-cloud/storage`
library then picks up automatically. I never reference a key file
anywhere in the code — the `Storage` client is initialized with just the
project ID, nothing else.

Also make sure your bucket actually exists:

```bash
gsutil mb -l us-central1 gs://<your-bucket-name>
```

### 6. Start the server

```bash
npm start
```

You should see:

```
Server listening on port 3000 (development)
Configured for 4 shard(s)
```

### 7. Try uploading a file

Generate a test file:

```bash
node scripts/generate-sample-csv.js 10000 sample-orders.csv
```

Upload it:

```bash
curl -X POST http://localhost:3000/upload-orders -F "file=@sample-orders.csv"
```

You'll get back a job ID right away — the actual processing happens in
the background, so this response comes back almost instantly even though
parsing and inserting 10,000 rows takes a bit longer:

```json
{"message":"File accepted and is being processed","jobId":"...","statusUrl":"/upload-orders/..."}
```

### 8. Check on the job

```bash
curl http://localhost:3000/upload-orders/<jobId>
```

Once it's done, you'll see something like:

```json
{
  "status": "completed",
  "totalRows": 10000,
  "insertedRows": 9897,
  "failedRows": 103,
  "gcsPath": "gs://<bucket>/orders/<jobId>/sample-orders.csv"
}
```

### 9. Look at the other endpoints

```bash
curl "http://localhost:3000/orders?customerId=cust-42"
curl "http://localhost:3000/orders/<some-order-id>"
curl http://localhost:3000/health
curl http://localhost:3000/metrics
```

### 10. Run the tests

```bash
npm test
```

## Running it with Docker instead

If you'd rather not install Postgres directly, there's a `docker-compose.yml`
that spins up Postgres and the app together:

```bash
cp .env.example .env
docker compose up --build
docker compose exec app npm run setup:shards
```

It mounts your local `~/.config/gcloud` folder into the container so it
can reuse the same ADC login you already did on your host machine —
nothing gets copied or baked into the image.

## How I configured Google ADC

I wanted to avoid the classic mistake of dropping a service account JSON
key into the project, so the GCS client in `src/services/gcsService.js`
is created with only a project ID:

```js
const storage = new Storage({ projectId: config.gcp.projectId });
```

No `keyFilename`, no credentials object. Locally, this works because
`gcloud auth application-default login` writes credentials to a file
outside the project folder (in your home directory), and the Google Cloud
client libraries know to look for it there automatically. If this were
deployed to Cloud Run or GKE, the same code would just pick up whatever
service account is attached to that environment — again, no code changes
needed.

The `.env.example` does mention `GOOGLE_APPLICATION_CREDENTIALS` as an
option, but only as a fallback for edge cases, with a clear warning not to
commit that file if you do use it.

## Sharding strategy

I went with **application-level sharding**, using `hash(customer_id) % 4`
as the shard key. Each shard is its own independent PostgreSQL database
(`orders_shard_0` to `orders_shard_3`), and the app decides which one to
write to based on a hash of the customer ID (`src/db/shardRouter.js`).

**Why customer_id instead of order_id or order_date:**

I thought about all three options the assessment mentions:

- **Hashing order_id** would spread writes very evenly, but it makes the
  most common real-world query — "show me this customer's orders" — turn
  into a query across every shard, which defeats the point of sharding in
  the first place.
- **Time-based sharding on order_date** is nice for archiving old data,
  but it means all new writes pile onto whichever shard represents "now,"
  so you end up with one hot shard doing all the work while the others sit
  idle.
- **customer_id** gives a good balance — since there are many distinct
  customers, the hash spreads write load fairly evenly across shards, and
  it means the most common read pattern (all orders for one customer)
  only ever needs to touch a single shard.

The trade-off I accepted: looking up a single order by `order_id` alone
(without knowing which customer it belongs to) means the app doesn't know
which shard to check, so it has to query all four shards and return
whichever one has a match. That's implemented in `orderService.getOrderById`.
I think that's a reasonable trade to make since customer-based lookups are
far more common than random single-order lookups in most systems like this.

If this needed to scale beyond 4 shards later, that would require an
actual data migration since the hash function assumes a fixed shard
count — that's a known limitation of simple modulo-based hashing, and
something you'd normally solve with consistent hashing or a shard-mapping
table if you expected to reshard frequently. I didn't build that out since
it felt out of scope for this assessment.

## Performance and how I avoided loading the whole file into memory

The file is read using `fs.createReadStream` piped into `csv-parser`, so
rows come through one at a time rather than the whole file getting loaded
into a big array. As rows come in, I validate them and push them into a
buffer — one buffer per shard, since different customers land on
different shards. Once a buffer hits 500 rows (configurable via
`BATCH_SIZE`), it gets flushed with a single `INSERT ... VALUES (...), (...), ...`
wrapped in a transaction, rather than inserting rows one at a time.

While a flush is happening, I pause the read stream so it doesn't keep
pulling more rows into memory while waiting on a slow database write, and
resume it once the insert finishes. That backpressure handling is what
keeps memory usage flat no matter how big the file is.

I also added a unique constraint on `order_id` with
`ON CONFLICT DO NOTHING` on insert, so if the same file gets uploaded
twice by accident (or a job needs to be retried), it won't create
duplicate rows.

## Background processing

`POST /upload-orders` doesn't make the caller wait for all 10,000 rows to
be processed. It saves the file, kicks off processing in the background,
and immediately responds with a job ID. The actual GCS upload and database
insertion happen after that response is sent, and you can check progress
any time with `GET /upload-orders/:jobId`. I used an in-memory map to
track job status rather than a full queue system like BullMQ or Cloud
Tasks — for a single-instance setup like this it's enough, but I noted in
the code that a real production version running on multiple instances
would need a shared, durable store instead (a database table or an actual
queue) since job state would otherwise disappear on restart and wouldn't
be visible across instances.

## Handling bad data

Rows that fail validation (bad dates, missing customer_id, invalid
status values, etc.) don't just get silently dropped — they're written to
a separate `failed_orders` table along with the original row data and the
reason it failed, so nothing gets lost and you can go back and inspect
what went wrong. The job status response also reports how many rows
failed versus how many succeeded.

One small thing worth mentioning: the assessment doc's own example table
has a typo, `order_amout` instead of `order_amount`. I made the validator
accept either column name so a file generated exactly from the spec's
column names still works correctly.

## Other design decisions

- I picked CSV over Excel for the upload format since streaming a CSV is
  much simpler and more common for this kind of high-volume batch
  ingestion. Excel could be added later behind the same processor
  interface if needed, using a streaming XLSX reader.
- Failed rows don't really have a natural shard (a row can fail validation
  precisely because its `customer_id` is missing or broken), so I decided
  to always write those to shard 0 rather than trying to guess a shard for
  them.
- I kept the status field restricted to a fixed set of values
  (pending, processing, shipped, delivered, cancelled, refunded) just to
  show real validation is happening — that list would obviously be
  adjusted to match whatever a real system actually needs.

## API endpoints

| Method | Path | What it does |
|---|---|---|
| POST | `/upload-orders` | Upload a CSV file (`multipart/form-data`, field name `file`). Returns a job ID right away. |
| GET | `/upload-orders/:jobId` | Check the status of a processing job. |
| GET | `/orders?customerId=` | Get recent orders for a customer (single-shard lookup). |
| GET | `/orders/:orderId` | Look up one order by ID (checks all shards). |
| GET | `/health` | Checks that every shard's database connection is alive. |
| GET | `/metrics` | Basic counts of jobs and rows processed. |
