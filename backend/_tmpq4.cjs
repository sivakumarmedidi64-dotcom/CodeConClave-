const { Pool } = require("pg");
const pool = new Pool({ connectionString: process.env.DATABASE_URL_PROBE, ssl: { rejectUnauthorized: false } });
(async () => {
  const swap = await pool.query(`UPDATE ai_model_registry SET enabled = CASE model_id WHEN 'gemma-4-31b-it' THEN false WHEN 'gemma-3-27b-it' THEN true ELSE enabled END WHERE provider_id='gemma'`);
  const gemma = await pool.query(`SELECT model_id, enabled FROM ai_model_registry WHERE provider_id='gemma' ORDER BY model_id`);
  console.log("GEMMA", JSON.stringify(gemma.rows));
  const mistral = await pool.query(`UPDATE ai_model_registry SET model_id='mistral-small-latest', display_name='Mistral Small (free tier)' WHERE provider_id='mistral' AND model_id='mistral-large-2411' RETURNING model_id, enabled`);
  console.log("MISTRAL", JSON.stringify(mistral.rows));
  const z = await pool.query(`UPDATE ai_model_registry SET enabled=true WHERE provider_id='z_code_5_3' RETURNING model_id, enabled`);
  console.log("Z", JSON.stringify(z.rows));
  const qwenKept = await pool.query(`SELECT provider_id, count(*)::int AS enabled FROM ai_model_registry WHERE enabled GROUP BY provider_id ORDER BY provider_id`);
  console.log("ENABLED_BY_PROVIDER", JSON.stringify(qwenKept.rows));
  await pool.end();
})().catch(e => { console.error("ERR", e.message); process.exit(1); });
