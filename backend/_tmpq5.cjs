const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL_PROBE, ssl: { rejectUnauthorized: false } });
(async () => {
  await pool.query(`UPDATE ai_model_registry SET enabled = false WHERE provider_id NOT IN ('google','nemotron','mistral')`);
  await pool.query(`UPDATE ai_model_registry SET enabled = true  WHERE provider_id IN ('google','nemotron','mistral')`);
  const rows = await pool.query(`SELECT provider_id, count(*)::int AS enabled FROM ai_model_registry WHERE enabled GROUP BY provider_id ORDER BY provider_id`);
  console.log("ENABLED_PROVIDERS", JSON.stringify(rows.rows));
  const models = await pool.query(`SELECT e.provider_id, e.model_id, e.display_name, e.entitlement FROM ai_model_registry e JOIN (SELECT provider_id, min(priority) p FROM ai_model_registry WHERE enabled GROUP BY provider_id) m ON e.provider_id=m.provider_id AND e.priority=m.p ORDER BY provider_id`);
  console.log("TOP_MODELS", JSON.stringify(models.rows));
  await pool.end();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
