/**
 * EBO Camp — JotForm Backfill (manual fallback for the webhook)
 *
 * Pulls every submission from the configured JotForm form via the public API
 * and runs each one through the same extract → dedupe-by-email → insert
 * logic the live webhook uses. Idempotent: existing campers (by email) are
 * skipped, so this is safe to run as often as you want.
 *
 * Env vars (set in Netlify dashboard):
 *   JOTFORM_API_KEY    — your JotForm API key
 *   JOTFORM_FORM_ID    — the form ID to pull submissions from
 *   JOTFORM_MIN_DATE   — optional cutoff (e.g. 2026-01-01). Submissions older
 *                        than this are filtered both server-side (via the
 *                        JotForm API filter param) and client-side as a
 *                        safety net. Defaults to 2026-01-01 to keep a
 *                        re-used form from importing previous-year campers.
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *
 * Returns: { ok, fetched, skipped_old, created, updated, duplicates, invalid, errors, details }
 */

const { extractCamper, insertCamper } = require('./_jotform-shared');

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'POST only' });
  }

  const apiKey = process.env.JOTFORM_API_KEY;
  const formId = process.env.JOTFORM_FORM_ID;
  if (!apiKey || !formId) {
    return json(500, { ok: false, error: 'JOTFORM_API_KEY or JOTFORM_FORM_ID not configured' });
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    return json(500, { ok: false, error: 'SUPABASE_URL or SUPABASE_ANON_KEY not configured' });
  }

  // Cutoff date — JotForm forms are often re-used year over year, so
  // skip anything submitted before this date. ISO-ish format YYYY-MM-DD.
  const minDateStr = (process.env.JOTFORM_MIN_DATE || '2026-01-01').trim();
  const minDate = new Date(minDateStr + 'T00:00:00Z');
  // JotForm filter param expects 'YYYY-MM-DD HH:MM:SS' and a JSON shape.
  const filterJson = JSON.stringify({ 'created_at:gt': minDateStr + ' 00:00:00' });

  // Page through submissions in batches of 1000 (JotForm API max).
  const all = [];
  let offset = 0;
  const limit = 1000;
  for (;;) {
    const url = `https://api.jotform.com/form/${formId}/submissions?apiKey=${encodeURIComponent(apiKey)}&limit=${limit}&offset=${offset}&orderby=created_at&filter=${encodeURIComponent(filterJson)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return json(502, { ok: false, error: `JotForm API error ${res.status}`, body });
    }
    const data = await res.json().catch(() => null);
    const page = (data && Array.isArray(data.content)) ? data.content : [];
    all.push(...page);
    if (page.length < limit) break;
    offset += page.length;
    if (offset > 10000) break; // safety stop
  }

  const summary = { fetched: all.length, skipped_old: 0, created: 0, updated: 0, duplicates: 0, invalid: 0, errors: 0, min_date: minDateStr, details: [] };

  for (const sub of all) {
    // Client-side safety filter in case the JotForm filter param ever drifts.
    // sub.created_at format: 'YYYY-MM-DD HH:MM:SS'
    if (sub.created_at) {
      const subDate = new Date(sub.created_at.replace(' ', 'T') + 'Z');
      if (!isNaN(subDate.getTime()) && subDate < minDate) {
        summary.skipped_old++;
        continue;
      }
    }
    // The JotForm API nests answers as { qid: { name, text, answer } }.
    // Flatten to { fieldName: answer } so extractCamper's key-substring lookups still work.
    const flat = {};
    for (const [, item] of Object.entries(sub.answers || {})) {
      if (item && item.name != null) flat[item.name] = item.answer;
    }
    const camper = extractCamper(flat);
    const result = await insertCamper(camper);
    if (result.status === 'created') summary.created++;
    else if (result.status === 'updated') summary.updated++;
    else if (result.status === 'duplicate') summary.duplicates++;
    else if (result.status === 'invalid') summary.invalid++;
    else summary.errors++;
    if (result.status !== 'duplicate') {
      summary.details.push({
        sub_id: sub.id,
        email: camper.email,
        name: `${camper.first_name || ''} ${camper.last_name || ''}`.trim(),
        result: result.status,
        reason: result.reason,
      });
    }
  }

  return json(200, { ok: true, ...summary });
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
