/**
 * EBO Camp — JotForm → Supabase Camper Auto-Create
 *
 * Receives JotForm submissions (application/x-www-form-urlencoded with a
 * `rawRequest` field containing JSON), extracts camper fields, inserts into
 * the Supabase `campers` table, and fires off a welcome email with the PIN.
 *
 * Env vars (set in Netlify dashboard):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *
 * Always returns 200 — JotForm retries non-2xx responses aggressively, and we
 * don't want silent duplication. Errors are logged to Netlify function logs.
 */

const PORTAL_URL = 'https://officials-hub.github.io/ebo-camp/';
const SEND_EMAIL_URL = 'https://ebo-camp-emails.netlify.app/.netlify/functions/send-email';
const DEFAULT_STATE = 'CO';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return ok({ note: 'POST only' });
  }

  try {
    const params = new URLSearchParams(event.body || '');
    const raw = params.get('rawRequest');
    if (!raw) {
      console.error('[jotform-webhook] no rawRequest in body');
      return ok({ note: 'no rawRequest' });
    }

    let submission;
    try {
      submission = JSON.parse(raw);
    } catch (e) {
      console.error('[jotform-webhook] rawRequest JSON parse failed:', e.message);
      return ok({ note: 'bad json' });
    }

    const camper = extractCamper(submission);

    if (!camper.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(camper.email)) {
      console.error('[jotform-webhook] invalid email:', camper.email);
      return ok({ note: 'invalid email' });
    }
    if (!camper.first_name || !camper.last_name) {
      console.error('[jotform-webhook] missing name', { first: camper.first_name, last: camper.last_name });
      return ok({ note: 'missing name' });
    }

    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
      console.error('[jotform-webhook] Supabase env vars not configured');
      return ok({ note: 'not configured' });
    }

    // Duplicate check
    const existsUrl = `${process.env.SUPABASE_URL}/rest/v1/campers?email=eq.${encodeURIComponent(camper.email)}&select=id`;
    const existsRes = await fetch(existsUrl, { headers: supabaseHeaders() });
    if (!existsRes.ok) {
      console.error('[jotform-webhook] duplicate check failed:', existsRes.status, await existsRes.text());
      return ok({ note: 'dupcheck failed' });
    }
    const existing = await existsRes.json();
    if (Array.isArray(existing) && existing.length > 0) {
      console.log(`[jotform-webhook] duplicate skipped: ${camper.email}`);
      return ok({ note: 'duplicate', email: camper.email });
    }

    camper.pin = String(Math.floor(1000 + Math.random() * 9000));

    const insRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/campers`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(camper),
    });
    if (!insRes.ok) {
      console.error('[jotform-webhook] insert failed:', insRes.status, await insRes.text());
      return ok({ note: 'insert failed' });
    }

    console.log(`[jotform-webhook] created: ${camper.first_name} ${camper.last_name} (${camper.email})`);

    try {
      await fetch(SEND_EMAIL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to: camper.email,
          from: 'EBO Camp <onboarding@resend.dev>',
          subject: 'Welcome to EBO Camp — Your Login PIN',
          html: buildWelcomeEmail(camper.first_name, camper.pin),
        }),
      });
    } catch (e) {
      console.warn('[jotform-webhook] welcome email dispatch failed:', e.message);
    }

    return ok({ note: 'created', email: camper.email });
  } catch (err) {
    console.error('[jotform-webhook] unexpected error:', err);
    return ok({ note: 'error' });
  }
};

function ok(extra) {
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ok: true, ...extra }),
  };
}

function supabaseHeaders() {
  return {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
  };
}

function extractCamper(sub) {
  const entries = Object.entries(sub);
  const findByKey = (needle) =>
    entries.find(([k]) => k.toLowerCase().includes(needle.toLowerCase()));

  // JotForm "Full Name" widget renders as a composite { first, last } object
  const nameComposite = entries
    .map(([, v]) => v)
    .find((v) => v && typeof v === 'object' && !Array.isArray(v) && ('first' in v || 'last' in v));

  const first = (nameComposite?.first || readVal(findByKey('first'))).toString().trim();
  const last  = (nameComposite?.last  || readVal(findByKey('last'))).toString().trim();

  // JotForm "Phone" widget is typically { full, area, phone }
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

  const bio_resume = buildBio({ level, yrs3, yrs2, area, goals, tshirt, conflicts });

  return { first_name: first, last_name: last, email, phone, city, state, bio_resume };
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

function buildWelcomeEmail(firstName, pin) {
  const fn = (firstName || '').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
  return `<div style="max-width:480px;margin:0 auto;font-family:Arial,Helvetica,sans-serif;background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);">
    <div style="background:#000000;padding:18px 22px;border-bottom:3px solid #A8A8A8;">
      <div style="color:#ffffff;font-size:15px;font-weight:800;letter-spacing:1.5px;line-height:1.2;">ELEVATE BASKETBALL OFFICIATING CAMP</div>
      <div style="color:#C0C0C0;font-size:11px;letter-spacing:1px;margin-top:4px;">APRIL 30 – MAY 3, 2026</div>
    </div>
    <div style="padding:24px 22px 22px;">
      <p style="color:#111;font-size:14px;font-weight:700;margin:0 0 10px;">Welcome, ${fn}!</p>
      <p style="color:#555;font-size:13px;line-height:1.55;margin:0 0 20px;">Your registration is confirmed. Save this PIN — you'll use your last name + PIN to log into the camp portal.</p>
      <table role="presentation" cellspacing="0" cellpadding="0" style="width:100%;border-collapse:separate;border:1px solid #e4e4e4;border-radius:8px;overflow:hidden;margin-bottom:22px;">
        <tr>
          <td style="padding:16px 18px;background:#fafafa;">
            <div style="font-size:10px;color:#888;letter-spacing:.1em;text-transform:uppercase;margin-bottom:4px;">Your PIN</div>
            <div style="font-size:30px;font-weight:900;color:#111;letter-spacing:.14em;line-height:1;">${pin}</div>
          </td>
        </tr>
      </table>
      <div style="text-align:center;margin-bottom:18px;">
        <a href="${PORTAL_URL}" style="display:inline-block;background:#000000;color:#ffffff;font-weight:700;font-size:13px;letter-spacing:.06em;padding:13px 28px;border-radius:999px;text-decoration:none;">Open Camp Portal →</a>
      </div>
      <p style="color:#999;font-size:11px;text-align:center;margin:0;line-height:1.5;">Elevate Basketball Officiating Camp<br>April 30 – May 3, 2026</p>
    </div>
  </div>`;
}
