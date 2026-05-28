// Cloudflare Pages Function — JV qualifier form handler
// POST /api/submit
//
// Required env vars (set in Cloudflare → Pages → title-jv-site → Settings → Environment variables):
//   RESEND_API_KEY   — API key from resend.com (free tier: 100/day, 3k/month)
//   FROM_EMAIL       — verified sender, e.g. "JV Review <noreply@ballantynetitle.com>"
//   NOTIFY_EMAILS    — comma-separated recipients, e.g. "aaron@skyway.media,richard@ballantynetitle.com"
//
// Optional (enables GHL contact creation when Richard activates his CRM):
//   GHL_API_KEY      — Private Integration token from GHL
//   GHL_LOCATION_ID  — sub-account location ID

export async function onRequestPost({ request, env }) {
  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return json({ ok: false, error: 'Invalid JSON' }, 400);
  }

  // Basic anti-spam: require email + role
  if (!payload.email || !payload.role) {
    return json({ ok: false, error: 'Missing required fields' }, 400);
  }

  // Honeypot (if you add a hidden field named `website` to the form, bots will fill it)
  if (payload.website) {
    return json({ ok: true, skipped: true });
  }

  const results = { email: null, ghl: null };

  // Fire email and GHL in parallel — both are best-effort, don't block on either
  const [emailRes, ghlRes] = await Promise.allSettled([
    sendNotificationEmail(payload, env),
    createGhlContact(payload, env)
  ]);

  results.email = emailRes.status === 'fulfilled' ? emailRes.value : { ok: false, error: String(emailRes.reason) };
  results.ghl = ghlRes.status === 'fulfilled' ? ghlRes.value : { ok: false, error: String(ghlRes.reason) };

  // Even if both fail, return 200 so the user lands on /thank-you. We log server-side for triage.
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
  const subject = `New JV Review — ${p.role || 'Unknown'} — ${p.company || p.first_name || 'No name'}`;
  const html = renderLeadEmail(p);

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

function renderLeadEmail(p) {
  const rows = [
    ['Role', p.role],
    ['Market', p.market],
    ['Monthly transactions', p.monthly_transactions],
    ['Team size', p.team_size],
    ['Current title relationship', p.current_title],
    ['Main goal', p.goal],
    ['Name', `${p.first_name || ''} ${p.last_name || ''}`.trim()],
    ['Company', p.company],
    ['Email', p.email],
    ['Phone', p.phone],
    ['Source funnel', p.source_funnel],
    ['Intent', p.intent],
    ['Referrer', p.referrer],
    ['Submitted', p.submitted_at],
    ['Suggested GHL tag', p.lead_tag]
  ];
  const tableRows = rows.map(([k, v]) =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eef0f3;font-weight:600;color:#00305B;width:200px;">${escape(k)}</td><td style="padding:8px 12px;border-bottom:1px solid #eef0f3;color:#1f2937;">${escape(v || '—')}</td></tr>`
  ).join('');

  return `<!DOCTYPE html><html><body style="margin:0;font-family:Inter,-apple-system,Segoe UI,Roboto,sans-serif;background:#f6f8fb;padding:32px;">
<div style="max-width:640px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6e9ee;">
  <div style="padding:20px 24px;background:#00305B;color:#fff;">
    <p style="margin:0;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;opacity:0.7;">Ballantyne Title</p>
    <h1 style="margin:6px 0 0;font-size:18px;">New JV Qualification Review</h1>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:14px;">${tableRows}</table>
  <div style="padding:16px 24px;background:#f9fafc;color:#5b6473;font-size:12px;">
    Submitted via the JV qualifier on jv.ballantynetitle.com. Reply directly to email the lead.
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
async function createGhlContact(p, env) {
  if (!env.GHL_API_KEY || !env.GHL_LOCATION_ID) {
    return { ok: false, error: 'GHL not configured' };
  }
  // GHL public API — Contacts > Upsert
  const tags = [
    p.lead_tag,                      // e.g., "JV Mortgage Broker"
    'JV Form Completed',
    p.source_funnel ? `Source: ${p.source_funnel}` : null
  ].filter(Boolean);

  const body = {
    locationId: env.GHL_LOCATION_ID,
    firstName: p.first_name,
    lastName: p.last_name,
    email: p.email,
    phone: p.phone,
    companyName: p.company,
    source: `JV site — ${p.source_funnel || 'homepage'}`,
    tags,
    customFields: [
      { key: 'jv_role', field_value: p.role },
      { key: 'jv_market', field_value: p.market },
      { key: 'jv_monthly_transactions', field_value: p.monthly_transactions },
      { key: 'jv_team_size', field_value: p.team_size },
      { key: 'jv_current_title', field_value: p.current_title },
      { key: 'jv_goal', field_value: p.goal },
      { key: 'jv_intent', field_value: p.intent }
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
