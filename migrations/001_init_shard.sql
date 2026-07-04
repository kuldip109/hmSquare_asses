-- Applied identically to every shard database (orders_shard_0 .. orders_shard_N).
-- Each shard is a self-contained database holding a partition of customers.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Main orders table.
CREATE TABLE IF NOT EXISTS orders (
    id             BIGSERIAL PRIMARY KEY,
    order_id       UUID NOT NULL,
    customer_id    TEXT NOT NULL,
    order_date     TIMESTAMPTZ NOT NULL,
    order_amount   NUMERIC(12, 2) NOT NULL CHECK (order_amount >= 0),
    status         TEXT NOT NULL,
    job_id         UUID,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- Enforces idempotency: re-uploading the same file / re-running a
    -- failed job will not create duplicate orders.
    CONSTRAINT uq_orders_order_id UNIQUE (order_id)
);

-- customer_id is the shard key AND the most common query filter, so it
-- gets a dedicated index. order_date supports range/reporting queries.
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders (customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_order_date  ON orders (order_date);
CREATE INDEX IF NOT EXISTS idx_orders_status      ON orders (status);

-- Rows that failed validation are stored here (per requirement 3.2) rather
-- than silently dropped, so they can be inspected / reprocessed later.
CREATE TABLE IF NOT EXISTS failed_orders (
    id           BIGSERIAL PRIMARY KEY,
    job_id       UUID,
    raw_row      JSONB NOT NULL,
    error        TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_failed_orders_job_id ON failed_orders (job_id);
