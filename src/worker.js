/**
 * Bitrion contact-form Worker.
 *
 * - Serves the static site from ./public (Workers static assets).
 * - Handles POST /api/contact: honeypot → field validation → Turnstile → SMTP to your own mail server.
 *
 * Secrets (Cloudflare dashboard → Worker → Settings → Variables and Secrets, type "Secret"):
 *   SMTP_USER, SMTP_PASS, TURNSTILE_SECRET
 * Plain vars (wrangler.jsonc → "vars"):
 *   SITE_NAME, MAIL_TO, MAIL_FROM (blank = SMTP_USER), SMTP_HOST, SMTP_PORT, SMTP_SECURE ("tls" for 465, "starttls" for 587)
 */
import { connect } from 'cloudflare:sockets';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/contact') {
      if (request.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);
      try {
        return await handleContact(request, env);
      } catch (err) {
        console.error('contact handler failed:', (err && err.stack) || err);
        return json({ success: false, error: 'Failed to send message. Please try again or email us directly.' }, 502);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

const MAX = { name: 100, email: 254, service: 100, message: 5000 };

async function handleContact(request, env) {
  const form = await request.formData();
  const get = (k) => String(form.get(k) ?? '').trim();

  // Honeypot: humans never see this field. A bot that fills it gets a fake success and nothing is sent.
  if (get('company_website')) return json({ success: true });

  const first = get('first_name');
  const last = get('last_name');
  const email = get('email');
  const service = get('service');
  const message = get('message');

  if (!first || !last || !email || !service || !message) {
    return json({ success: false, error: 'All fields are required.' }, 400);
  }
  if (first.length > MAX.name || last.length > MAX.name || service.length > MAX.service ||
      email.length > MAX.email || message.length > MAX.message) {
    return json({ success: false, error: 'One of the fields is too long.' }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ success: false, error: 'Invalid email address.' }, 400);
  }

  // Turnstile (bot protection). Fails closed if the secret is missing.
  if (!env.TURNSTILE_SECRET) {
    console.error('TURNSTILE_SECRET is not set');
    return json({ success: false, error: 'Form is not configured yet.' }, 500);
  }
  const token = get('cf-turnstile-response');
  if (!token) return json({ success: false, error: 'Please complete the verification challenge.' }, 400);
  const ip = request.headers.get('CF-Connecting-IP') || '';
  if (!(await verifyTurnstile(env.TURNSTILE_SECRET, token, ip))) {
    return json({ success: false, error: 'Verification failed. Please try again.' }, 400);
  }

  // Mail configuration
  const missing = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'].filter((k) => !env[k]);
  if (missing.length) {
    console.error('Missing mail config:', missing.join(', '));
    return json({ success: false, error: 'Form is not configured yet.' }, 500);
  }

  const site = env.SITE_NAME || new URL(request.url).hostname;
  const country = request.headers.get('CF-IPCountry') || '';
  const text = [
    `New contact form submission from ${site}`,
    '',
    `Name:    ${first} ${last}`,
    `Email:   ${email}`,
    `Service: ${service}`,
    '',
    'Message:',
    message,
    '',
    '---',
    `Sent:    ${new Date().toISOString()}`,
    `IP:      ${ip || 'unknown'}${country ? ' (' + country + ')' : ''}`,
    `Agent:   ${request.headers.get('User-Agent') || ''}`,
  ].join('\r\n');

  await sendMail(
    {
      host: env.SMTP_HOST,
      port: Number(env.SMTP_PORT || 465),
      secure: String(env.SMTP_SECURE || 'tls').toLowerCase(),
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
      ehlo: site,
    },
    {
      from: env.MAIL_FROM || env.SMTP_USER,
      fromName: `${site} Contact Form`,
      to: env.MAIL_TO,
      replyTo: email,
      replyToName: `${first} ${last}`,
      subject: `[${site}] ${service} inquiry from ${first} ${last}`,
      text,
      domain: site,
    }
  );

  return json({ success: true });
}

async function verifyTurnstile(secret, token, ip) {
  const body = new URLSearchParams({ secret, response: token });
  if (ip) body.set('remoteip', ip);
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!data.success) console.warn('turnstile rejected:', JSON.stringify(data['error-codes'] || data));
  return data.success === true;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

/* ────────────────── Minimal SMTP client over Cloudflare TCP sockets ────────────────── */

async function sendMail(smtp, mail) {
  const mode = smtp.secure === 'starttls' ? 'starttls' : smtp.secure === 'none' ? 'off' : 'on'; // "none" is for local tests only
  let socket = connect({ hostname: smtp.host, port: smtp.port }, { secureTransport: mode, allowHalfOpen: false });
  let io = smtpIO(socket);
  try {
    await io.expect(220, 'greeting');
    let ehlo = await io.cmd(`EHLO ${smtp.ehlo}`, 250);
    if (mode === 'starttls') {
      await io.cmd('STARTTLS', 220);
      io.release();
      socket = socket.startTls();
      io = smtpIO(socket);
      ehlo = await io.cmd(`EHLO ${smtp.ehlo}`, 250);
    }
    const auth = (ehlo.lines.find((l) => /^AUTH[ =]/i.test(l)) || '').toUpperCase();
    if (auth.includes('PLAIN') || !auth.includes('LOGIN')) {
      await io.cmd(`AUTH PLAIN ${b64(`\u0000${smtp.user}\u0000${smtp.pass}`)}`, 235);
    } else {
      await io.cmd('AUTH LOGIN', 334);
      await io.cmd(b64(smtp.user), 334);
      await io.cmd(b64(smtp.pass), 235);
    }
    await io.cmd(`MAIL FROM:<${mail.from}>`, 250);
    await io.cmd(`RCPT TO:<${mail.to}>`, [250, 251]);
    await io.cmd('DATA', 354);
    await io.cmd(buildMessage(mail) + '\r\n.', 250);
    await io.cmd('QUIT', 221).catch(() => {});
  } finally {
    io.release();
    try { await socket.close(); } catch { /* already closed */ }
  }
}

function smtpIO(socket, timeoutMs = 20000) {
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = '';

  const withTimeout = (p, what) => {
    let t;
    const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`SMTP timeout during ${what}`)), timeoutMs); });
    return Promise.race([p, timeout]).finally(() => clearTimeout(t));
  };

  async function readResponse() {
    for (;;) {
      const lines = buf.split('\r\n');
      const complete = lines.slice(0, -1); // last element is the unterminated remainder
      const end = complete.findIndex((l) => /^\d{3}(?: |$)/.test(l)); // "250 text" or bare "250" ends a reply; "250-text" continues it
      if (end !== -1) {
        const reply = complete.slice(0, end + 1);
        buf = [...complete.slice(end + 1), lines[lines.length - 1]].join('\r\n');
        return { code: parseInt(reply[end].slice(0, 3), 10), lines: reply.map((l) => l.slice(4)), raw: reply.join(' | ') };
      }
      const { value, done } = await withTimeout(reader.read(), 'read');
      if (done) throw new Error('SMTP connection closed unexpectedly');
      buf += dec.decode(value, { stream: true });
    }
  }

  async function expect(codes, what) {
    const r = await readResponse();
    if (![].concat(codes).includes(r.code)) throw new Error(`SMTP ${what} failed: ${r.raw}`);
    return r;
  }

  async function cmd(line, codes) {
    await withTimeout(writer.write(enc.encode(line + '\r\n')), 'write');
    // Never echo credentials or the message body into error text.
    const what = line.includes('\r\n') ? 'message' : (/^AUTH/i.test(line) || /^[A-Za-z0-9+/=]+$/.test(line)) ? 'AUTH' : line.split(/[ :]/)[0];
    return expect(codes, what);
  }

  function release() {
    try { reader.releaseLock(); } catch { /* noop */ }
    try { writer.releaseLock(); } catch { /* noop */ }
  }

  return { expect, cmd, release };
}

function buildMessage(m) {
  const headers = [
    `From: ${headerText(m.fromName)} <${m.from}>`,
    `To: <${m.to}>`,
    `Reply-To: ${headerText(m.replyToName)} <${m.replyTo}>`,
    `Subject: ${headerText(m.subject)}`,
    `Date: ${new Date().toUTCString().replace(/GMT$/, '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${m.domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  ];
  const body = b64(m.text).replace(/.{76}/g, '$&\r\n');
  // Dot-stuffing (RFC 5321 §4.5.2) so no line in the payload can terminate DATA early.
  return (headers.join('\r\n') + '\r\n\r\n' + body).replace(/(^|\r\n)\./g, '$1..');
}

// Header-safe text: strips line breaks (no header injection), quotes plain ASCII, RFC 2047-encodes anything else.
function headerText(s) {
  const clean = String(s).replace(/[\r\n]+/g, ' ').trim();
  if (/^[\x20-\x7e]*$/.test(clean)) return `"${clean.replace(/["\\]/g, '')}"`;
  const words = [];
  for (let i = 0; i < clean.length; i += 11) words.push(`=?UTF-8?B?${b64(clean.slice(i, i + 11))}?=`); // ≤ 44 bytes per encoded word, under the 75-char limit
  return words.join(' ');
}

function b64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
