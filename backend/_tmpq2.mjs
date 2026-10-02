import { pool } from "./src/shared/db.js";
const q = await pool.query(`SELECT provider_id, model_id, display_name, enabled, entitlement, health, coding_optimized, image_generation FROM ai_model_registry WHERE provider_id IN ('gemma','google','nemotron','z_code_5_3','ox_alpha','mistral','kimi','north') ORDER BY provider_id, model_id`);
for (const r of q.rows) console.log(JSON.stringify(r));
await pool.end();
