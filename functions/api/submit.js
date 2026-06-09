// Cloudflare Pages Function — JV landing-page form handler
// POST /api/submit
//
// Accepts submissions from /jointventure/realtor, /jointventure/mortgage, /jointventure/entrepreneur.
// Each landing page POSTs a normalized payload with source_funnel and lead_tag set.
//
// Required env vars (Cloudflare → Pages → title-jv-site → Settings → Environment variables):
//   RESEND_API_KEY   — API key from resend.com (free tier: 100/day, 3k/month)
//   FROM_EMAIL       — verified sender, e.g. "JV Leads <noreply@ballantynetitle.com>"
//   NOTIFY_EMAILS    — comma-separated recipients
//
// Optional (Aaron flips these on when GHL is configured):
//   GHL_API_KEY      — Private Integration token
//   GHL_LOCATION_ID  — sub-account location ID

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  // Honeypot — bots fill the hidden `website` field
  if (payload.website) {
    return json({ ok: true, skipped: true });
  }

  // Minimum-viable validation
  if (!payload.email || !payload.first_name) {
    return json({ ok: false, error: 'Missing required fields' }, 400);
  }

  // Normalize the funnel — only accept known values, default to "unknown"
  const allowedFunnels = ['realtor', 'mortgage', 'entrepreneur', 'homepage', 'qualify'];
  if (!allowedFunnels.includes(payload.source_funnel)) {
    payload.source_funnel = 'unknown';
  }

  // Fire email + GHL in parallel — both are best-effort
  const [emailRes, ghlRes] = await Promise.allSettled([
    sendNotificationEmail(payload, env),
    createGhlContact(payload, env)
  ]);

  const results = {
    email: emailRes.status === 'fulfilled' ? emailRes.value : { ok: false, error: String(emailRes.reason) },
    ghl: ghlRes.status === 'fulfilled' ? ghlRes.value : { ok: false, error: String(ghlRes.reason) }
  };

  // 200 even if both side effects failed — visitor still lands on thank-you.
  // Errors get logged in the Cloudflare dashboard for triage.
  return json({ ok: true, results });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

// ---------- Email via Resend ----------
async function sendNotificationEmail(p, env) {
  if (!env.RESEND_API_KEY || !env.FROM_EMAIL || !env.NOTIFY_EMAILS) {
    return { ok: false, error: 'Email not configured' };
  }
  const to = env.NOTIFY_EMAILS.split(',').map(s => s.trim()).filter(Boolean);
  const funnelLabel = funnelDisplayName(p.source_funnel);
  const subject = `[${funnelLabel} JV] ${p.first_name} ${p.last_name || ''} — ${p.organization || ''}`.trim();
  const html = renderLeadEmail(p, funnelLabel);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to,
      subject,
      html,
      reply_to: p.email
    })
  });

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, status: res.status, body };
  }
  return { ok: true };
}

function funnelDisplayName(funnel) {
  switch (funnel) {
    case 'realtor': return 'Realtor';
    case 'mortgage': return 'Mortgage';
    case 'entrepreneur': return 'Entrepreneur';
    case 'homepage': return 'Homepage';
    case 'qualify': return 'Qualifier';
    default: return 'Unknown';
  }
}

function renderLeadEmail(p, funnelLabel) {
  const orgLabel = p.organization_label || 'Organization';
  const metricLabel = p.qualifying_metric_label || 'Qualifying metric';

  const rows = [
    ['Funnel', funnelLabel],
    ['Pipeline tag', p.pipeline || p.lead_tag || '—'],
    ['Name', `${p.first_name || ''} ${p.last_name || ''}`.trim()],
    [orgLabel, p.organization],
    [metricLabel, p.qualifying_metric],
    ['State', p.state],
    ['Phone', p.phone],
    ['Email', p.email],
    ['Page URL', p.page_url],
    ['Referrer', p.referrer || '(direct)'],
    ['Submitted', p.submitted_at]
  ];
  const tableRows = rows.map(([k, v]) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eef0f3;font-weight:600;color:#00305B;width:200px;">${escape(k)}</td><td style="padding:8px 12px;border-bottom:1px solid #eef0f3;color:#1f2937;">${escape(v || '—')}</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html><body style="margin:0;font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f8fb;padding:32px;">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6e9ee;">
  <div style="padding:20px 24px;background:#00305B;color:#fff;">
    <p style="margin:0;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.7;">Ballantyne Title &mdash; ${escape(funnelLabel)} Funnel</p>
    <h1 style="margin:6px 0 0;font-size:18px;">New JV Lead</h1>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">${tableRows}</table>
  <div style="padding:16px 24px;background:#f9fafc;color:#5b6473;font-size:12px;">
    Submitted via the ${escape(funnelLabel.toLowerCase())} funnel on jv.ballantynetitle.com. Reply directly to email the lead.
  </div>
</div>
</body></html>`;
}

function escape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- GHL contact creation ----------
// When Aaron turns on GHL_API_KEY + GHL_LOCATION_ID, every lead is upserted with
// the correct tags. Until then this is a no-op and only email fires.
async function createGhlContact(p, env) {
  if (!env.GHL_API_KEY || !env.GHL_LOCATION_ID) {
    return { ok: false, error: 'GHL not configured' };
  }

  const tags = [
    p.lead_tag || 'JV Unknown',          // JV Realtor / JV Mortgage / JV Entrepreneur
    'JV Form Completed',
    `Source: ${p.source_funnel}`
  ].filter(Boolean);

  const body = {
    locationId: env.GHL_LOCATION_ID,
    firstName: p.first_name,
    lastName: p.last_name,
    email: p.email,
    phone: p.phone,
    companyName: p.organization,
    state: p.state,
    source: `JV site — ${p.source_funnel}`,
    tags,
    customFields: [
      { key: 'jv_funnel', field_value: p.source_funnel },
      { key: 'jv_pipeline', field_value: p.pipeline || p.lead_tag },
      { key: 'jv_qualifying_metric_label', field_value: p.qualifying_metric_label },
      { key: 'jv_qualifying_metric_value', field_value: p.qualifying_metric },
      { key: 'jv_organization_label', field_value: p.organization_label },
      { key: 'jv_page_url', field_value: p.page_url },
      { key: 'jv_referrer', field_value: p.referrer }
    ]
  };

  const res = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GHL_API_KEY}`,
      'Content-Type': 'application/json',
      'Version': '2021-07-28'
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const text = await res.text();
    return { ok: false, status: res.status, body: text };
  }
  const data = await res.json();
  return { ok: true, contactId: data.contact?.id || data.id || null };
}
