# bitrion.qa

Single-page marketing site for bitrion.qa, derived from the IPSwat site and served by a
Cloudflare Worker. The contact form posts to `/api/contact` on the same Worker, which sends
the message to **info@bitrion.qa** through your own mail server. No secrets live in this repo.

## Files

| Path | What it is |
|---|---|
| `public/index.html` | The whole site. CSS and JS are inlined. |
| `src/worker.js` | Serves `public/` and handles the contact form: honeypot, Turnstile check, SMTP send. |
| `wrangler.jsonc` | Worker config and non-secret variables. |

## Deploy (one time)

1. **Push this folder to GitHub.** The repo root must be this folder (where `wrangler.jsonc` is).
2. **Create the Worker from the repo.** Cloudflare dashboard → Workers & Pages → Create →
   *Import a repository* → pick the repo. Leave *Build command* empty, keep the default deploy
   command `npx wrangler deploy`, and deploy.
3. **Attach the domain.** Worker → Settings → Domains & Routes → Add → Custom domain →
   `bitrion.qa`. Add `www.bitrion.qa` too if you want it. If a DNS record already exists for the
   name, Cloudflare asks to replace it.
4. **Turnstile (bot protection).** Dashboard → Turnstile → Add widget → hostname `bitrion.qa`,
   widget mode *Managed*.
   - Put the **Site key** into `public/index.html` in place of `REPLACE_WITH_TURNSTILE_SITE_KEY`,
     then commit and push. (The site key is public by design.)
   - Put the **Secret key** into Worker → Settings → Variables and Secrets → Add →
     type **Secret** → name `TURNSTILE_SECRET`.
5. **Mail credentials.** Same place, two more secrets:
   - `SMTP_USER`: a mailbox login on your mail server, e.g. `noreply@bitrion.net`
   - `SMTP_PASS`: that mailbox's password
   Click *Deploy* after saving secrets.
6. **Test.** Open `https://bitrion.qa`, send a message, check info@bitrion.qa. If it fails, open
   Worker → Logs: the real SMTP or Turnstile error is printed there, while the visitor only sees
   a generic message.

## Variables you may change (`wrangler.jsonc` → `vars`)

| Variable | Default | Notes |
|---|---|---|
| `MAIL_TO` | `info@bitrion.qa` | Where submissions are delivered. |
| `MAIL_FROM` | blank | Sender address. Blank means "same as `SMTP_USER`", which Postfix usually requires. |
| `SMTP_HOST` | `fox.ipswat.com` | Must match the name on the mail server's TLS certificate. The server behind `mail.bitrion.net` presents a certificate for `fox.ipswat.com`, so that name is used. Cloudflare refuses connections whose certificate does not match. |
| `SMTP_PORT` / `SMTP_SECURE` | `465` / `tls` | Alternative: `587` / `starttls`. Port 25 is blocked by Cloudflare. |
| `SITE_NAME` | `bitrion.qa` | Used in the subject line and the EHLO greeting. |

## Local preview

```sh
npx wrangler dev          # then open http://localhost:8787
```

To exercise the form locally, create a `.dev.vars` file (gitignored) with `SMTP_USER`,
`SMTP_PASS` and `TURNSTILE_SECRET`. Cloudflare's always-pass test keys are
`1x00000000000000000000AA` (site key) and `1x0000000000000000000000000000000AA` (secret).

## Changing the page

Edit `public/index.html` directly and push. The page was generated from the IPSwat source by
`tools/build.py` in the parent workspace; rerun that only if you want to regenerate both sites
from scratch.
