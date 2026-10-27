const express = require('express');
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const db = new Database(process.env.DB_FILE || path.join(__dirname, 'auction.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));

const TRIGGERS = ['BID_IN_WINDOW', 'ANY_RANK_CHANGE', 'L1_CHANGE'];
const TRIGGER_TEXT = {
  BID_IN_WINDOW: 'a bid came in during the last {X} min',
  ANY_RANK_CHANGE: 'supplier ranking changed in the last {X} min',
  L1_CHANGE: 'the lowest bidder (L1) changed in the last {X} min',
};
const ms = (iso) => new Date(iso).getTime();
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

function statusOf(r, now = Date.now()) {
  if (now < ms(r.bid_start)) return 'Upcoming';
  if (now < ms(r.bid_close)) return 'Active';
  return ms(r.bid_close) >= ms(r.forced_close) ? 'Force Closed' : 'Closed';
}

// best bid per supplier, cheapest first; ties go to whoever bid earlier
function rankings(rfqId) {
  const rows = db.prepare('SELECT * FROM bids WHERE rfq_id=? ORDER BY total ASC, created_at ASC, id ASC').all(rfqId);
  const seen = new Set();
  const out = [];
  for (const b of rows) {
    const k = b.carrier_name.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(b); }
  }
  return out.map((b, i) => ({ ...b, rank: i + 1 }));
}

const addLog = (rfqId, type, message, at) =>
  db.prepare('INSERT INTO activity_log (rfq_id,type,message,created_at) VALUES (?,?,?,?)').run(rfqId, type, message, at.toISOString());

function validateRfq(b) {
  const need = ['ref_id', 'name', 'bid_start', 'bid_close', 'forced_close', 'pickup_date', 'trigger_window_min', 'extension_min', 'trigger_type'];
  for (const k of need) if (b[k] === undefined || b[k] === '') throw bad(`${k} is required`);
  for (const k of ['bid_start', 'bid_close', 'forced_close', 'pickup_date'])
    if (isNaN(ms(b[k]))) throw bad(`${k} is not a valid date`);
  if (ms(b.bid_close) <= ms(b.bid_start)) throw bad('Bid close time must be after bid start time');
  if (ms(b.forced_close) <= ms(b.bid_close)) throw bad('Forced close time must be later than bid close time');
  const x = Number(b.trigger_window_min), y = Number(b.extension_min);
  if (!Number.isInteger(x) || x < 1) throw bad('Trigger window (X) must be a whole number of minutes, 1 or more');
  if (!Number.isInteger(y) || y < 1) throw bad('Extension duration (Y) must be a whole number of minutes, 1 or more');
  if (!TRIGGERS.includes(b.trigger_type)) throw bad('Unknown extension trigger');
  return { x, y };
}

const placeBid = db.transaction((rfqId, b, now) => {
  const rfq = db.prepare('SELECT * FROM rfqs WHERE id=?').get(rfqId);
  if (!rfq) throw Object.assign(new Error('RFQ not found'), { status: 404 });
  const st = statusOf(rfq, now.getTime());
  if (st !== 'Active') throw bad(st === 'Upcoming' ? 'Bidding has not started yet' : 'Bidding is closed for this RFQ');

  const name = String(b.carrier_name || '').trim();
  const nums = ['freight_charges', 'origin_charges', 'dest_charges'].map((k) => Number(b[k]));
  const transit = Number(b.transit_days), valid = Number(b.quote_valid_days);
  if (!name) throw bad('Carrier name is required');
  if (nums.some((n) => !isFinite(n) || n < 0)) throw bad('Charges must be numbers, 0 or more');
  if (!Number.isInteger(transit) || transit < 1) throw bad('Transit time must be a whole number of days');
  if (!Number.isInteger(valid) || valid < 1) throw bad('Quote validity must be a whole number of days');
  const total = nums[0] + nums[1] + nums[2];
  if (total <= 0) throw bad('Total quote must be more than 0');

  const before = rankings(rfqId);
  const mine = before.find((r) => r.carrier_name.toLowerCase() === name.toLowerCase());
  if (mine && total >= mine.total) throw bad(`Your new total must be lower than your current bid (${mine.total})`);

  db.prepare(`INSERT INTO bids (rfq_id,carrier_name,freight_charges,origin_charges,dest_charges,total,transit_days,quote_valid_days,created_at)
              VALUES (?,?,?,?,?,?,?,?,?)`).run(rfqId, name, nums[0], nums[1], nums[2], total, transit, valid, now.toISOString());
  const after = rankings(rfqId);
  const rank = after.find((r) => r.carrier_name.toLowerCase() === name.toLowerCase()).rank;
  addLog(rfqId, 'bid', `${name} bid ${total} (now L${rank})`, now);

  // ---- British auction extension logic ----
  const close = ms(rfq.bid_close);
  const inWindow = now.getTime() >= close - rfq.trigger_window_min * 60000 && now.getTime() < close;
  if (!inWindow) return;

  const bo = before.map((r) => r.carrier_name), ao = after.map((r) => r.carrier_name);
  let hit = false;
  if (rfq.trigger_type === 'BID_IN_WINDOW') hit = true;
  if (rfq.trigger_type === 'ANY_RANK_CHANGE') hit = bo.some((n, i) => ao[i] !== n);
  if (rfq.trigger_type === 'L1_CHANGE') hit = bo[0] !== ao[0];
  if (!hit) return;

  const reason = TRIGGER_TEXT[rfq.trigger_type].replace('{X}', rfq.trigger_window_min);
  const newClose = Math.min(close + rfq.extension_min * 60000, ms(rfq.forced_close));
  if (newClose === close) {
    addLog(rfqId, 'info', `Extension skipped, already at forced close (${reason})`, now);
    return;
  }
  db.prepare('UPDATE rfqs SET bid_close=? WHERE id=?').run(new Date(newClose).toISOString(), rfqId);
  const capped = newClose === ms(rfq.forced_close) ? ' (capped at forced close)' : '';
  addLog(rfqId, 'extension', `Close time moved ${new Date(close).toISOString()} to ${new Date(newClose).toISOString()}${capped}. Reason: ${reason}`, now);
});

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

const wrap = (fn) => (req, res) => {
  try { res.json(fn(req)); }
  catch (e) {
    const dup = /UNIQUE/.test(e.message);
    res.status(dup ? 400 : e.status || 500).json({ error: dup ? 'That RFQ reference ID is already used' : e.message });
  }
};

app.get('/api/rfqs', wrap(() =>
  db.prepare('SELECT * FROM rfqs ORDER BY id DESC').all().map((r) => {
    const top = rankings(r.id)[0];
    return { ...r, status: statusOf(r), lowest_bid: top ? top.total : null, lowest_carrier: top ? top.carrier_name : null };
  })));

app.post('/api/rfqs', wrap((req) => {
  const b = req.body, { x, y } = validateRfq(b);
  const now = new Date();
  const id = db.prepare(`INSERT INTO rfqs (ref_id,name,bid_start,original_bid_close,bid_close,forced_close,pickup_date,trigger_window_min,extension_min,trigger_type,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(String(b.ref_id).trim(), String(b.name).trim(), b.bid_start, b.bid_close, b.bid_close, b.forced_close, b.pickup_date, x, y, b.trigger_type, now.toISOString()).lastInsertRowid;
  addLog(id, 'created', `RFQ created (X=${x} min, Y=${y} min)`, now);
  return { id };
}));

app.get('/api/rfqs/:id', wrap((req) => {
  const rfq = db.prepare('SELECT * FROM rfqs WHERE id=?').get(req.params.id);
  if (!rfq) throw Object.assign(new Error('RFQ not found'), { status: 404 });
  return {
    rfq, status: statusOf(rfq), now: new Date().toISOString(),
    ranking: rankings(rfq.id),
    bids: db.prepare('SELECT * FROM bids WHERE rfq_id=? ORDER BY total ASC, created_at ASC').all(rfq.id),
    activity: db.prepare('SELECT * FROM activity_log WHERE rfq_id=? ORDER BY id DESC').all(rfq.id),
  };
}));

app.post('/api/rfqs/:id/bids', wrap((req) => { placeBid(Number(req.params.id), req.body, new Date()); return { ok: true }; }));

const port = process.env.PORT || 3000;
if (require.main === module) app.listen(port, () => console.log(`Running on http://localhost:${port}`));
module.exports = { app, db };