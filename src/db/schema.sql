CREATE TABLE IF NOT EXISTS products (
  sku text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL,
  price integer NOT NULL CHECK (price >= 0),
  currency char(3) NOT NULL,
  provider text NOT NULL DEFAULT 'A'
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'A';

CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY,
  sku text REFERENCES products(sku),
  amount integer NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL,
  delivery_code text,
  delivery_request_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Stage one stored a single SKU on the order. Stage two keeps these columns
-- readable, while all new product instances live in order_items.
ALTER TABLE orders ALTER COLUMN sku DROP NOT NULL;

CREATE TABLE IF NOT EXISTS payment_events (
  event_id text PRIMARY KEY,
  order_id text NOT NULL,
  status text NOT NULL,
  amount integer NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_items (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  position integer NOT NULL,
  sku text NOT NULL REFERENCES products(sku),
  provider text NOT NULL,
  amount integer NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL,
  status text NOT NULL DEFAULT 'awaiting_payment',
  request_version integer NOT NULL DEFAULT 1 CHECK (request_version > 0),
  delivery_code text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(order_id, position)
);

CREATE TABLE IF NOT EXISTS delivery_jobs (
  item_id text PRIMARY KEY REFERENCES order_items(id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider text NOT NULL,
  status text NOT NULL DEFAULT 'waiting_payment',
  priority integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_requests (
  request_id text PRIMARY KEY,
  item_id text NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  provider text NOT NULL,
  sku text NOT NULL,
  state text NOT NULL DEFAULT 'created',
  code text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS issued_codes (
  code text PRIMARY KEY,
  item_id text NOT NULL UNIQUE REFERENCES order_items(id) ON DELETE RESTRICT,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  sku text NOT NULL,
  request_id text NOT NULL UNIQUE REFERENCES provider_requests(request_id) ON DELETE RESTRICT,
  issued_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS money_ledger (
  id bigserial PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  item_id text REFERENCES order_items(id) ON DELETE RESTRICT,
  operation text NOT NULL CHECK (operation IN ('payment', 'refund')),
  amount integer NOT NULL CHECK (amount >= 0),
  currency char(3) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS order_events (
  id bigserial PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,
  item_id text REFERENCES order_items(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS provider_rate_limits (
  provider text PRIMARY KEY,
  limit_per_window integer NOT NULL DEFAULT 60 CHECK (limit_per_window > 0),
  window_ms integer NOT NULL DEFAULT 60000 CHECK (window_ms > 0),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  used integer NOT NULL DEFAULT 0 CHECK (used >= 0)
);

-- Retained so old stage-one data and checks keep working.
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id bigserial PRIMARY KEY,
  order_id text NOT NULL REFERENCES orders(id),
  provider text NOT NULL,
  request_id text NOT NULL,
  outcome text NOT NULL,
  code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider, request_id)
);

INSERT INTO provider_rate_limits(provider) VALUES ('A'), ('B')
ON CONFLICT(provider) DO NOTHING;

CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS payment_events_order_idx ON payment_events(order_id);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items(order_id);
CREATE INDEX IF NOT EXISTS order_items_status_idx ON order_items(status);
CREATE INDEX IF NOT EXISTS delivery_jobs_queue_idx ON delivery_jobs(status, priority DESC, available_at, created_at);
CREATE INDEX IF NOT EXISTS order_events_order_time_idx ON order_events(order_id, created_at, id);
CREATE INDEX IF NOT EXISTS money_ledger_order_time_idx ON money_ledger(order_id, created_at, id);
DROP INDEX IF EXISTS delivery_attempts_one_success_idx;

CREATE OR REPLACE FUNCTION reject_append_only_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS money_ledger_append_only ON money_ledger;
CREATE TRIGGER money_ledger_append_only
BEFORE UPDATE OR DELETE ON money_ledger
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();

DROP TRIGGER IF EXISTS order_events_append_only ON order_events;
CREATE TRIGGER order_events_append_only
BEFORE UPDATE OR DELETE ON order_events
FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
