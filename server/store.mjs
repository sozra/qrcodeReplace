// Sandbox schema initialization is idempotent; no remote provisioning/configuration.
export async function database(env) {
  const db = env.BILLING_DB;
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS auth_users (id TEXT PRIMARY KEY, google_sub TEXT NOT NULL UNIQUE, email TEXT NOT NULL, name TEXT NOT NULL, stripe_customer TEXT, created INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS auth_sessions (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires)'),
    db.prepare('CREATE TABLE IF NOT EXISTS auth_flows (state_hash TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL, legacy_buyer TEXT, previous_session TEXT, expires INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS auth_flows_expiry ON auth_flows(expires)'),
    db.prepare('CREATE TABLE IF NOT EXISTS billing_owners (buyer TEXT PRIMARY KEY, user_id TEXT NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS billing_owners_user ON billing_owners(user_id)'),
    db.prepare('CREATE TABLE IF NOT EXISTS billing_checkout_locks (user_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, expires INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS billing_orders (session TEXT PRIMARY KEY, buyer TEXT NOT NULL, plan TEXT NOT NULL, price TEXT NOT NULL, customer TEXT, subscription TEXT, payment_intent TEXT, confirmed INTEGER NOT NULL DEFAULT 0, paid INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT \'pending\', created INTEGER NOT NULL)'),
    db.prepare('CREATE TABLE IF NOT EXISTS billing_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, processed INTEGER NOT NULL)'),
    db.prepare('CREATE INDEX IF NOT EXISTS billing_orders_buyer ON billing_orders(buyer, created)'),
    db.prepare('CREATE INDEX IF NOT EXISTS billing_orders_customer ON billing_orders(customer)'),
    db.prepare('CREATE INDEX IF NOT EXISTS billing_orders_subscription ON billing_orders(subscription)'),
  ]);
  return db;
}
