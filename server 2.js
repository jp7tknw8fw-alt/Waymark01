/**
 * Waymark membership backend.
 *
 * This exists to fix the core problem with the front-end-only version:
 * a browser can claim "the payment confirmed" without it being true. This
 * server independently re-checks every payment against Solana itself before
 * granting membership, and it — not the browser's clock — decides how long
 * a membership has been active, since a user can edit or fake local storage.
 *
 * Setup:
 *   npm install
 *   cp .env.example .env    # then fill in TREASURY_KEYPAIR_PATH etc.
 *   node server.js
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} = require('@solana/web3.js');
const {
  getOrCreateAssociatedTokenAccount,
  transfer: splTransfer,
} = require('@solana/spl-token');
const db = require('./db');

const PORT = process.env.PORT || 8787;
const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com'; // point this at Helius/QuickNode for real traffic — public RPC rate-limits hard
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS; // e.g. Bp35y1d7ioGVfyrKbs3Kcozdc48oiE6Tdsgu5pFZooFq
const MINT_ADDRESS = process.env.MINT_ADDRESS; // from create-token.js
const MEMBERSHIP_USD = Number(process.env.MEMBERSHIP_USD || 2);
const SOL_PRICE_FALLBACK = Number(process.env.SOL_USD_PRICE_FALLBACK || 150);
const PAYMENT_TOLERANCE = 0.9; // accept payments down to 90% of expected (price can move between quote and send)
const PAYMENT_MAX_AGE_MS = 10 * 60 * 1000; // reject signatures older than 10 minutes (replay/staleness guard)
const LAPSE_MS = 35 * 24 * 3600 * 1000; // membership lapses if unpaid for 35 days
const TOKEN_USD_VALUE = Number(process.env.TOKEN_USD_VALUE || 0.02);
const LOYALTY_MILESTONES = [
  { months: 5, usd: 10 },
  { months: 12, usd: 20 },
];

if (!TREASURY_ADDRESS){
  console.error('Set TREASURY_ADDRESS in .env');
  process.exit(1);
}

const connection = new Connection(RPC_URL, 'confirmed');

// Only needed for actually paying out loyalty tokens (see payoutLoyalty below).
// This is the same keypair used in create-token.js — the one holding the
// pre-minted $MARK supply. Keep it out of source control; load from a path
// outside the repo in production, or a secrets manager.
let treasuryKeypair = null;
if (process.env.TREASURY_KEYPAIR_PATH && fs.existsSync(process.env.TREASURY_KEYPAIR_PATH)){
  const secret = JSON.parse(fs.readFileSync(process.env.TREASURY_KEYPAIR_PATH, 'utf8'));
  treasuryKeypair = Keypair.fromSecretKey(new Uint8Array(secret));
}

async function getSolUsdPrice(){
  try{
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const data = await res.json();
    const price = data?.solana?.usd;
    return typeof price === 'number' ? price : SOL_PRICE_FALLBACK;
  }catch(e){
    return SOL_PRICE_FALLBACK;
  }
}

function isValidPubkey(str){
  try{ new PublicKey(str); return true; }catch(e){ return false; }
}

/**
 * The actual verification step. Re-derives what should have happened
 * on-chain and checks the real transaction against it — never trusts
 * anything the client says about its own payment.
 */
async function verifyMembershipPayment(wallet, signature){
  if (await db.isSignatureUsed(signature)){
    return { ok: false, reason: 'This payment has already been used to activate a membership.' };
  }

  const tx = await connection.getTransaction(signature, {
    commitment: 'confirmed',
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) return { ok: false, reason: 'Transaction not found on-chain yet — try again in a few seconds.' };
  if (tx.meta?.err) return { ok: false, reason: 'That transaction failed on-chain.' };

  if (tx.blockTime && (Date.now() - tx.blockTime * 1000) > PAYMENT_MAX_AGE_MS){
    return { ok: false, reason: 'That payment is too old to accept — please send a new one.' };
  }

  const accountKeys = tx.transaction.message.getAccountKeys
    ? tx.transaction.message.getAccountKeys().staticAccountKeys
    : tx.transaction.message.accountKeys;
  const walletIndex = accountKeys.findIndex(k => k.toBase58() === wallet);
  const treasuryIndex = accountKeys.findIndex(k => k.toBase58() === TREASURY_ADDRESS);
  if (walletIndex === -1 || treasuryIndex === -1){
    return { ok: false, reason: 'Transaction does not involve the expected wallet and treasury.' };
  }

  // Compare balances instead of parsing instruction data — robust to how the
  // transfer instruction was built client-side.
  const preTreasury = tx.meta.preBalances[treasuryIndex];
  const postTreasury = tx.meta.postBalances[treasuryIndex];
  const preWallet = tx.meta.preBalances[walletIndex];
  const postWallet = tx.meta.postBalances[walletIndex];
  const treasuryGained = postTreasury - preTreasury;
  const walletLost = preWallet - postWallet; // includes the transfer + fee if wallet paid the fee

  const solPrice = await getSolUsdPrice();
  const expectedLamports = Math.round((MEMBERSHIP_USD / solPrice) * LAMPORTS_PER_SOL);
  const minAcceptable = expectedLamports * PAYMENT_TOLERANCE;

  if (treasuryGained < minAcceptable || walletLost < minAcceptable){
    return { ok: false, reason: `Payment amount was lower than expected (~${MEMBERSHIP_USD} USD in SOL).` };
  }

  return { ok: true };
}

function monthsActive(record){
  if (!record || !record.active || !record.startedAt) return 0;
  return (Date.now() - record.startedAt) / (30 * 24 * 3600 * 1000);
}

/** Actually sends $MARK from the treasury token account to the member's wallet. */
async function payoutLoyalty(wallet, usdAmount){
  if (!treasuryKeypair || !MINT_ADDRESS){
    console.warn(`Loyalty payout of $${usdAmount} owed to ${wallet} but TREASURY_KEYPAIR_PATH/MINT_ADDRESS not configured — recorded, not sent.`);
    return null;
  }
  const mint = new PublicKey(MINT_ADDRESS);
  const treasuryAta = await getOrCreateAssociatedTokenAccount(connection, treasuryKeypair, mint, treasuryKeypair.publicKey);
  const memberAta = await getOrCreateAssociatedTokenAccount(connection, treasuryKeypair, mint, new PublicKey(wallet));
  const amountTokens = usdAmount / TOKEN_USD_VALUE;
  const decimals = 6;
  const rawAmount = BigInt(Math.round(amountTokens * 10 ** decimals));
  const sig = await splTransfer(connection, treasuryKeypair, treasuryAta.address, memberAta.address, treasuryKeypair, rawAmount);
  return sig;
}

const app = express();

// Restrict to your real frontend's origin — leaving this open lets any
// website make requests against your treasury-adjacent endpoints.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;
if (!ALLOWED_ORIGIN){
  console.warn('ALLOWED_ORIGIN not set — CORS is wide open. Fine for local testing, not for production.');
}
app.use(cors(ALLOWED_ORIGIN ? { origin: ALLOWED_ORIGIN } : {}));
app.use(express.json());

// Payment verification calls Solana RPC and (on milestones) sends real tokens —
// keep it from being hammered. 10 attempts per 10 minutes per IP is generous
// for a legitimate user paying for membership, tight for someone probing it.
const activateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
});
const statusLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// Generous — this carries every wallet-balance read and transaction the game
// makes, not just membership actions. Tune based on your real provider's
// plan limits; the point is just to stop unbounded abuse, not to throttle
// normal play.
const rpcLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

// Proxies Solana JSON-RPC calls so RPC_URL (which may embed a paid provider's
// API key) never has to be shipped to the browser. The frontend's
// Connection points at this endpoint instead of at Helius/QuickNode directly.
app.post('/api/rpc', rpcLimiter, async (req, res) => {
  try{
    const upstream = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
    });
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  }catch(e){
    console.error('RPC proxy error:', e);
    res.status(502).json({ error: 'Could not reach Solana RPC.' });
  }
});

app.post('/api/membership/activate', activateLimiter, async (req, res) => {
  const { wallet, signature } = req.body || {};
  if (!wallet || !isValidPubkey(wallet)) return res.status(400).json({ error: 'Invalid wallet address.' });
  if (!signature || typeof signature !== 'string') return res.status(400).json({ error: 'Missing transaction signature.' });

  try{
    const result = await verifyMembershipPayment(wallet, signature);
    if (!result.ok) return res.status(402).json({ error: result.reason });

    await db.markSignatureUsed(signature, wallet);
    const existing = await db.getMembership(wallet);
    const wasLapsed = existing && existing.active === false;
    const record = await db.upsertMembership(wallet, {
      active: true,
      startedAt: (!existing || wasLapsed) ? Date.now() : existing.startedAt, // lapsing resets the loyalty clock
      lastPaidAt: Date.now(),
      loyaltyGranted: (!existing || wasLapsed) ? [] : (existing.loyaltyGranted || []),
    });

    res.json({ active: true, startedAt: record.startedAt, monthsActive: monthsActive(record) });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'Verification failed unexpectedly — please try again.' });
  }
});

app.get('/api/membership/status', statusLimiter, async (req, res) => {
  const wallet = req.query.wallet;
  if (!wallet || !isValidPubkey(wallet)) return res.status(400).json({ error: 'Invalid wallet address.' });

  let record = await db.getMembership(wallet);
  if (!record) return res.json({ active: false, monthsActive: 0, loyaltyGranted: [] });

  if (record.active && Date.now() - record.lastPaidAt > LAPSE_MS){
    record = await db.upsertMembership(wallet, { active: false });
  }

  const months = monthsActive(record);
  const newlyGranted = [];
  for (const m of LOYALTY_MILESTONES){
    if (record.active && months >= m.months && !(record.loyaltyGranted || []).includes(m.months)){
      const sig = await payoutLoyalty(wallet, m.usd).catch(err => { console.error('Payout failed:', err); return null; });
      record = await db.upsertMembership(wallet, { loyaltyGranted: [...(record.loyaltyGranted || []), m.months] });
      newlyGranted.push({ months: m.months, usd: m.usd, signature: sig });
    }
  }

  res.json({ active: record.active, startedAt: record.startedAt, monthsActive: months, loyaltyGranted: record.loyaltyGranted || [], newlyGranted });
});

app.listen(PORT, () => console.log(`Waymark membership backend listening on :${PORT}`));
