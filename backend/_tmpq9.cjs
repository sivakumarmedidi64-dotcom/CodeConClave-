const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL_PROBE, ssl: { rejectUnauthorized: false } });
(async () => {
  const u = await pool.query(`SELECT id, email, state FROM users ORDER BY created_at LIMIT 5`);
  console.log("USERS", JSON.stringify(u.rows));
  const d = await pool.query(`SELECT id, name, state, user_id, capabilities, last_seen_at FROM devices ORDER BY created_at LIMIT 10`);
  console.log("DEVICES", JSON.stringify(d.rows));
  const s = await pool.query(`SELECT state, count(*)::int AS n FROM sessions GROUP BY state`);
  console.log("SESSIONS", JSON.stringify(s.rows));
  await pool.end();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
