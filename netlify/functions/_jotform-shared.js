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

  // JotForm phone fields can be named anything — check the common labels.
  // Answer may be a composite object ({area, phone, full}) or a plain string.
  const PHONE_NEEDLES = ['phone', 'cell', 'mobile', 'tel', 'contact'];
  const isPhoneKey = (k) => {
    const lk = k.toLowerCase();
    return PHONE_NEEDLES.some((n) => lk.includes(n));
  };
  const phoneFromObject = (obj) => {
    if (!obj || typeof obj !== 'object') return '';
    if (typeof obj.full === 'string' && obj.full.trim()) return obj.full.trim();
    if (typeof obj.prettyFormat === 'string' && obj.prettyFormat.trim()) return obj.prettyFormat.trim();
    const built = `${obj.area || ''}${obj.phone || ''}`.trim();
    if (built) return built;
    // Last resort: stringify any string values inside
    return Object.values(obj).filter((v) => typeof v === 'string' && v.trim()).join(' ').trim();
  };
  let phone = '';
  for (const [k, v] of entries) {
    if (!isPhoneKey(k)) continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      phone = phoneFromObject(v);
    } else if (typeof v === 'string' && v.trim()) {
      phone = v.trim();
    } else if (Array.isArray(v)) {
      phone = v.filter(Boolean).join(' ').trim();
    }
    if (phone) break;
  }
  // One-time diagnostic so we can see the raw shape JotForm sent if the
  // matcher still misses a phone. Safe to leave on — only fires when phone
  // ends up blank.
  if (!phone) {
    const phoneShapes = entries
      .filter(([k]) => isPhoneKey(k))
      .map(([k, v]) => ({ key: k, type: Array.isArray(v) ? 'array' : typeof v, sample: typeof v === 'object' ? Object.keys(v || {}) : String(v).slice(0, 40) }));
    if (phoneShapes.length) {
      console.warn('[jotform-extract] phone keys present but empty/unrecognized:', JSON.stringify(phoneShapes));
    } else {
      console.warn('[jotform-extract] no phone-like field found. Sample keys:', entries.slice(0, 20).map(([k]) => k).join(', '));
    }
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

  const existsUrl = `${process.env.SUPABASE_URL}/rest/v1/campers?email=eq.${encodeURIComponent(camper.email)}&select=id,phone`;
  const existsRes = await fetch(existsUrl, { headers: supabaseHeaders() });
  if (!existsRes.ok) {
    const body = await existsRes.text().catch(() => '');
    return { status: 'error', reason: `dupcheck failed (${existsRes.status})`, body };
  }
  const existing = await existsRes.json();
  if (Array.isArray(existing) && existing.length > 0) {
    const row = existing[0];
    const existingPhone = (row.phone || '').trim();
    // If the existing row is missing a phone and we just extracted one, patch
    // it. Lets a re-run of backfill add phones to campers already imported.
    if (!existingPhone && camper.phone) {
      const patchRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/campers?id=eq.${row.id}`, {
        method: 'PATCH',
        headers: { ...supabaseHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify({ phone: camper.phone }),
      });
      if (patchRes.ok) return { status: 'updated', email: camper.email, reason: 'added missing phone' };
      const body = await patchRes.text().catch(() => '');
      return { status: 'error', reason: `phone patch failed (${patchRes.status})`, body, email: camper.email };
    }
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
