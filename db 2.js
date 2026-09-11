/**
 * Postgres-backed store for membership records and payment replay protection.
 *
 * Run schema.sql once against your database before starting the server.
 * Requires DATABASE_URL in .env (e.g. from Render, Supabase, RDS, etc.).
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

function rowToRecord(row){
  if (!row) return null;
  return {
    wallet: row.wallet,
    active: row.active,
    startedAt: row.started_at ? Number(row.started_at) : null,
    lastPaidAt: row.last_paid_at ? Number(row.last_paid_at) : null,
    loyaltyGranted: row.loyalty_granted || [],
  };
}

async function getMembership(wallet){
  const { rows } = await pool.query('SELECT * FROM memberships WHERE wallet = $1', [wallet]);
  return rowToRecord(rows[0]);
}

async function upsertMembership(wallet, patch){
  // Merge against the current row so a partial patch (e.g. just { active: false })
  // doesn't wipe out the other fields.
  const existing = await getMembership(wallet);
  const merged = { ...(existing || {}), ...patch, wallet };

  const { rows } = await pool.query(
    `INSERT INTO memberships (wallet, active, started_at, last_paid_at, loyalty_granted)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (wallet) DO UPDATE SET
       active = EXCLUDED.active,
       started_at = EXCLUDED.started_at,
       last_paid_at = EXCLUDED.last_paid_at,
       loyalty_granted = EXCLUDED.loyalty_granted
     RETURNING *`,
    [wallet, Boolean(merged.active), merged.startedAt || null, merged.lastPaidAt || null, JSON.stringify(merged.loyaltyGranted || [])]
  );
  return rowToRecord(rows[0]);
}

async function isSignatureUsed(signature){
  const { rows } = await pool.query('SELECT 1 FROM used_signatures WHERE signature = $1', [signature]);
  return rows.length > 0;
}

async function markSignatureUsed(signature, wallet){
  // ON CONFLICT DO NOTHING keeps this safe if two requests race on the same
  // signature — the unique primary key on `signature` is what actually
  // enforces one-time use; isSignatureUsed() is just an early, cheap check.
  await pool.query(
    `INSERT INTO used_signatures (signature, wallet, used_at) VALUES ($1, $2, $3)
     ON CONFLICT (signature) DO NOTHING`,
    [signature, wallet, Date.now()]
  );
}

module.exports = { getMembership, upsertMembership, isSignatureUsed, markSignatureUsed };
