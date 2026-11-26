# OpsFlow – setup status and remaining steps

Route used: WhatsApp Web bridge (no Meta account). The `supabase/functions/whatsapp-webhook` folder is the optional official-API route and is not deployed.

## Already done
- Supabase project `opsflow` (eu-central-1): tables `tasks`, `activity`, `messages`, row-level security and realtime are in place; one staff user exists.
- `index.html` already points at your Supabase project (it only contains the public publishable key, which is safe in a web page).

## 1. Put the app online (Vercel, free)
1. Create a GitHub repo and upload **everything in this folder** (`index.html` and `vercel.json` must be at the repo root).
2. Vercel → Add New → Project → import that repo. Framework Preset: **Other**. Leave Build Command and Output Directory empty. Deploy.
3. Open the `.vercel.app` URL and sign in with your Supabase user (email + password).
4. Add more staff: Supabase → Authentication → Users → *Add user*. Turn off public sign-ups in Authentication → Sign In / Providers.
5. Every `git push` to `main` redeploys automatically.

## 2. Start the WhatsApp bridge
See `bridge/README.md`. You need: a Gemini key (https://aistudio.google.com/apikey), your Supabase **service_role** key (Project Settings → API; keep it secret, only in `bridge/.env`), and a dedicated phone number.

## Notes
- Do not upload `bridge/.env` or `bridge/session/` to GitHub (the included `.gitignore` already excludes them).
- Optional hardening: enable "Leaked password protection" in Supabase Authentication settings if your plan offers it.
