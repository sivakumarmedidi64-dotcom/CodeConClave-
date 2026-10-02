const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL_PROBE, ssl: { rejectUnauthorized: false } });
(async () => {
  const rows = await pool.query(`SELECT e.provider_id, e.model_id, e.display_name, e.entitlement, e.image_generation FROM ai_model_registry e WHERE e.enabled AND e.provider_id IN ('google','nemotron','mistral') ORDER BY e.provider_id, e.priority`);
  for (const r of rows.rows) console.log(JSON.stringify(r));
  await pool.end();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
