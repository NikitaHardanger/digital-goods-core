CREATE TABLE IF NOT EXISTS products (
  sku text PRIMARY KEY, name text NOT NULL, type text NOT NULL, price integer NOT NULL CHECK (price >= 0), currency char(3) NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id text PRIMARY KEY, sku text NOT NULL REFERENCES products(sku), amount integer NOT NULL, currency char(3) NOT NULL,
  status text NOT NULL, delivery_code text, delivery_request_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payment_events (
  event_id text PRIMARY KEY, order_id text NOT NULL, status text NOT NULL, amount integer NOT NULL, currency char(3) NOT NULL,
  created_at timestamptz NOT NULL, received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS delivery_attempts (
  id bigserial PRIMARY KEY, order_id text NOT NULL REFERENCES orders(id), provider text NOT NULL, request_id text NOT NULL,
  outcome text NOT NULL, code text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(provider, request_id)
);
CREATE INDEX IF NOT EXISTS orders_status_idx ON orders(status);
CREATE INDEX IF NOT EXISTS payment_events_order_idx ON payment_events(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS delivery_attempts_one_success_idx ON delivery_attempts(order_id) WHERE outcome = 'ok';
