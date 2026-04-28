/**
 * EBO Camp — JotForm → Supabase Camper Auto-Create
 *
 * Receives JotForm submissions (application/x-www-form-urlencoded with a
 * `rawRequest` field containing JSON), extracts camper fields, and inserts
 * into the Supabase `campers` table. No welcome email — admins send PINs
 * manually from the portal via "Send All PINs".
 *
 * Env vars (set in Netlify dashboard):
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *
 * Always returns 200 — JotForm retries non-2xx responses aggressively, and we
 * don't want silent duplication. Errors are logged to Netlify function logs.
 */

const { extractCamper, insertCamper } = require('./_jotform-shared');

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
    const result = await insertCamper(camper);

    if (result.status === 'created') {
      console.log(`[jotform-webhook] created: ${camper.first_name} ${camper.last_name} (${camper.email})`);
    } else if (result.status === 'duplicate') {
      console.log(`[jotform-webhook] duplicate skipped: ${camper.email}`);
    } else {
      console.error(`[jotform-webhook] ${result.status}:`, result.reason || '', result.body || '');
    }

    return ok({ note: result.status, email: camper.email });
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
