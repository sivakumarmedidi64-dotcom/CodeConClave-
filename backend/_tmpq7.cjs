const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL_PROBE, ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query(`UPDATE ai_model_registry SET enabled = CASE WHEN model_id='gemini-3.7-flash' THEN true ELSE false END WHERE provider_id='google'`);
  await pool.query(`UPDATE ai_model_registry SET enabled = true WHERE provider_id='mistral'`);
  await pool.query(`UPDATE ai_model_registry SET enabled = true, entitlement = 'FREE' WHERE provider_id='nemotron'`);
  const rows = await pool.query(`SELECT e.provider_id, e.model_id, e.display_name, e.entitlement FROM ai_model_registry e WHERE e.enabled ORDER BY e.provider_id, e.priority`);
  for (const r of rows.rows) console.log(JSON.stringify(r));
  await pool.end();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
