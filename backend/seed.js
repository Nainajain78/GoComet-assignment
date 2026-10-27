const { db } = require('./server');
const m = (min) => new Date(Date.now() + min * 60000).toISOString();
const ref = 'DEMO-' + Math.floor(Math.random() * 9000 + 1000);
const id = db.prepare(`INSERT INTO rfqs (ref_id,name,bid_start,original_bid_close,bid_close,forced_close,pickup_date,trigger_window_min,extension_min,trigger_type,created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(ref, 'Mumbai to Rotterdam, 1x40ft', m(-5), m(3), m(3), m(15), m(60 * 24 * 7), 2, 2, 'ANY_RANK_CHANGE', m(-5)).lastInsertRowid;
db.prepare("INSERT INTO activity_log (rfq_id,type,message,created_at) VALUES (?,?,?,?)").run(id, 'created', 'RFQ created (X=2 min, Y=2 min)', m(-5));
console.log('Demo RFQ created:', ref);
process.exit(0);