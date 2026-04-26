/**
 * EBO Camp — Email Send Function (Resend-backed)
 *
 * Receives the same payload shape as the VH1 SendGrid function so the portal's
 * existing fetch() calls work without modification:
 *   POST /.netlify/functions/send-email
 *   { to, from, subject, html, fromName? }
 *
 * Forwards to Resend's API. API key is read from the RESEND_API_KEY env var
 * (set in Netlify dashboard — never commit it).
 *
 * Returns:
 *   200 { ok: true, id }   on success
 *   4xx/5xx { ok: false, error }   on failure
 */

exports.handler = async (event) => {
  // CORS preflight — portal is hosted on a different origin (GitHub Pages)
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: 'Method not allowed' }),
    };
  }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: 'RESEND_API_KEY not configured' }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch (e) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: 'Invalid JSON body' }),
    };
  }

  const { to, from, subject, html, fromName } = payload;

  if (!to || !subject || !html) {
    return {
      statusCode: 400,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: 'Missing required fields: to, subject, html' }),
    };
  }

  // Build the "from" field.
  // The portal passes from='EBO Camp <noreply@elevatebasketballofficiate.org>' (already formatted).
  // If `fromName` is separately provided, prepend it. If nothing is passed, fall back
  // to the verified domain sender.
  let fromField = from || 'EBO Camp <noreply@elevatebasketballofficiate.org>';
  if (fromName && !fromField.includes('<')) {
    fromField = `${fromName} <${fromField}>`;
  }

  // Reply-To: once ebocamp@gmail.com is created, set REPLY_TO env var to it.
  // Until then, leave unset — Resend handles that gracefully.
  const replyTo = process.env.REPLY_TO || undefined;

  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromField,
        to: Array.isArray(to) ? to : [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      return {
        statusCode: resp.status,
        headers: corsHeaders,
        body: JSON.stringify({
          ok: false,
          error: data.message || data.error || `Resend error: HTTP ${resp.status}`,
          details: data,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ ok: true, id: data.id }),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: corsHeaders,
      body: JSON.stringify({ ok: false, error: `Upstream error: ${err.message}` }),
    };
  }
};
