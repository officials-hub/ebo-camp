/**
 * Shared helpers for the Jotform webhook + backfill functions.
 * Extracts camper fields from a Jotform submission payload and inserts
 * a new row in Supabase, deduping by email.
 *
 * Underscore-prefixed filename keeps Netlify from treating this file
 * as its own deployable function (it only auto-deploys top-level files).
 */

const DEFAULT_STATE = 'CO';

function supabaseHeaders() {
  return {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
  };
}

function readVal(entry) {
  if (!entry) return '';
  const v = entry[1];
  if (v == null) return '';
  if (Array.isArray(v)) return v.filter(Boolean).join(', ');
  if (typeof v === 'object') return Object.values(v).filter(Boolean).join(' ');
  return String(v);
}

function buildBio(f) {
  const lines = [];
  const push = (label, val) => {
    const s = (val == null ? '' : String(val)).trim();
    if (s) lines.push(`${label}: ${s}`);
  };
  push('Experience Level', f.level);
  push('Years 3-person', f.yrs3);
  push('Years 2-person', f.yrs2);
  push('Area', f.area);
  push('Goals', f.goals);
  push('T-shirt Size', f.tshirt);
  push('Scheduling Conflicts', f.conflicts);
  return lines.join('\n');
}

/**
 * Extract camper fields from a JotForm submission body (the parsed JSON of
 * the `rawRequest` field for webhooks, or the `answers` map for the API).
 */
function extractCamper(sub) {
  const entries = Object.entries(sub);
  const findByKey = (needle) =>
    entries.find(([k]) => k.toLowerCase().includes(needle.toLowerCase()));

  const nameComposite = entries
    .map(([, v]) => v)
    .find((v) => v && typeof v === 'object' && !Array.isArray(v) && ('first' in v || 'last' in v));

  const first = (nameComposite?.first || readVal(findByKey('first'))).toString().trim();
  const last  = (nameComposite?.last  || readVal(findByKey('last'))).toString().trim();

  const phoneEntry = entries.find(
    ([k, v]) => k.toLowerCase().includes('phone') && v && typeof v === 'object' && !Array.isArray(v)
  );
  const phoneComposite = phoneEntry?.[1];
  let phone = '';
  if (phoneComposite) {
    if (typeof phoneComposite.full === 'string' && phoneComposite.full.trim()) {
      phone = phoneComposite.full.trim();
    } else {
      phone = `${phoneComposite.area || ''}${phoneComposite.phone || ''}`.trim();
    }
  } else {
    phone = readVal(findByKey('phone')).toString().trim();
  }

  const email = readVal(findByKey('email')).toString().trim().toLowerCase();
  const city  = readVal(findByKey('city')).toString().trim();
  const stateRaw = readVal(findByKey('state')).toString().trim();
  const state = stateRaw || DEFAULT_STATE;

  const level     = readVal(findByKey('level'));
  const yrs3      = readVal(findByKey('3 person')) || readVal(findByKey('three person'));
  const yrs2      = readVal(findByKey('2 person')) || readVal(findByKey('two person'));
  const area      = readVal(findByKey('area'));
  const goals     = readVal(findByKey('goals'));
  const tshirt    = readVal(findByKey('tshirt')) || readVal(findByKey('t-shirt')) || readVal(findByKey('size'));
  const conflicts = readVal(findByKey('conflict'));

  const bio = buildBio({ level, yrs3, yrs2, area, goals, tshirt, conflicts });

  return { first_name: first, last_name: last, email, phone, city, state, bio };
}

/**
 * Insert a camper row, skipping if an existing row with the same email is found.
 * Returns one of: 'created' | 'duplicate' | 'invalid' | 'error'.
 */
async function insertCamper(camper) {
  if (!camper.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(camper.email)) {
    return { status: 'invalid', reason: 'invalid email', email: camper.email };
  }
  if (!camper.first_name || !camper.last_name) {
    return { status: 'invalid', reason: 'missing name', email: camper.email };
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return { status: 'error', reason: 'supabase env not configured' };
  }

  const existsUrl = `${process.env.SUPABASE_URL}/rest/v1/campers?email=eq.${encodeURIComponent(camper.email)}&select=id`;
  const existsRes = await fetch(existsUrl, { headers: supabaseHeaders() });
  if (!existsRes.ok) {
    const body = await existsRes.text().catch(() => '');
    return { status: 'error', reason: `dupcheck failed (${existsRes.status})`, body };
  }
  const existing = await existsRes.json();
  if (Array.isArray(existing) && existing.length > 0) {
    return { status: 'duplicate', email: camper.email };
  }

  const row = { ...camper, pin: String(Math.floor(1000 + Math.random() * 9000)) };
  const insRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/campers`, {
    method: 'POST',
    headers: { ...supabaseHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!insRes.ok) {
    const body = await insRes.text().catch(() => '');
    return { status: 'error', reason: `insert failed (${insRes.status})`, body, email: camper.email };
  }

  return { status: 'created', email: camper.email };
}

module.exports = { extractCamper, insertCamper, supabaseHeaders };
