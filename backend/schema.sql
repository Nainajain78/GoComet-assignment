CREATE TABLE IF NOT EXISTS rfqs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ref_id             TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  bid_start          TEXT NOT NULL,            -- ISO, UTC
  original_bid_close TEXT NOT NULL,            -- what the buyer first set
  bid_close          TEXT NOT NULL,            -- current close, moves when extended
  forced_close       TEXT NOT NULL,            -- hard stop
  pickup_date        TEXT NOT NULL,
  trigger_window_min INTEGER NOT NULL CHECK (trigger_window_min > 0),   -- X
  extension_min      INTEGER NOT NULL CHECK (extension_min > 0),        -- Y
  trigger_type       TEXT NOT NULL CHECK (trigger_type IN ('BID_IN_WINDOW','ANY_RANK_CHANGE','L1_CHANGE')),
  created_at         TEXT NOT NULL,
  CHECK (forced_close > original_bid_close),
  CHECK (bid_close <= forced_close)
);

CREATE TABLE IF NOT EXISTS bids (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_id           INTEGER NOT NULL REFERENCES rfqs(id),
  carrier_name     TEXT NOT NULL,
  freight_charges  REAL NOT NULL,
  origin_charges   REAL NOT NULL,
  dest_charges     REAL NOT NULL,
  total            REAL NOT NULL,              -- freight + origin + destination
  transit_days     INTEGER NOT NULL,
  quote_valid_days INTEGER NOT NULL,
  created_at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bids_rfq_total ON bids (rfq_id, total, created_at);

CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  rfq_id     INTEGER NOT NULL REFERENCES rfqs(id),
  type       TEXT NOT NULL CHECK (type IN ('created','bid','extension','info')),
  message    TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_log_rfq ON activity_log (rfq_id, id);