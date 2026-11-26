# OpsFlow bridge (no Meta account needed)

Runs on an always-on computer, reads the WhatsApp groups you choose, and creates tasks in the same Supabase database as the web app. Steps 1–2 and 5 of the main README (Supabase, Gemini, hosting `index.html`) still apply. Skip Meta and the edge function.

## Before you start
- Use a **dedicated number** (cheap prepaid SIM), never your hotel's main line or a personal number. Install WhatsApp on a spare phone, add that number to the groups, then link the bridge to it.
- This is unofficial and against WhatsApp's terms. The bridge only listens and never sends, which lowers the risk but does not remove it. Have management approve it and tell staff their group messages are processed by AI.
- Only install the packages named in `package.json`. In 2026 researchers found 101 malicious npm packages posing as Baileys forks, so never swap in a "faster" or "anti-ban" fork.

## Run it
```bash
cd bridge
cp .env.example .env     # fill it in
npm install
npm start                # scan the QR with the dedicated phone: Linked devices → Link a device
```
The first run prints every group name. Copy the exact names into `WATCH_GROUPS`, then restart.

## Keep it running 24/7
- Spare PC or Raspberry Pi 4/5 at the hotel (needs Chromium, about 1 GB RAM free), or a free cloud VM such as Oracle Cloud Always Free (check their current terms).
- `npm i -g pm2 && pm2 start index.js --name opsflow && pm2 save && pm2 startup`
- Keep `session/` private (it is the login). The linked phone must come online at least every couple of weeks or WhatsApp unlinks it.
