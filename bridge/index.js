// OpsFlow bridge: WhatsApp Web (linked device, LISTEN-ONLY) → Gemini → Supabase tasks.
require("dotenv").config();
const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const { createClient } = require("@supabase/supabase-js");

const E = (k, d = "") => process.env[k] ?? d;
const sb = createClient(E("SUPABASE_URL"), E("SUPABASE_SERVICE_ROLE_KEY"));
const MODEL = E("GEMINI_MODEL", "gemini-2.5-flash");
const TZ = E("TIMEZONE", "Europe/Nicosia");
const DEPTS = E("DEPARTMENTS", "Front Office,Housekeeping,Maintenance,Bell Team,Concierge,F&B").split(",").map(s => s.trim());
const GROUPS = E("WATCH_GROUPS").split("|").map(s => s.trim()).filter(Boolean);
const READ_DIRECT = E("READ_DIRECT", "true") === "true";

async function extract(text) {
  const now = new Date().toLocaleString("en-GB", { timeZone: TZ, dateStyle: "full", timeStyle: "short" });
  const prompt = `You triage WhatsApp messages for a hotel operations team. Current local time: ${now}.
Decide if the message contains an actionable operational request (guest request, maintenance issue, housekeeping, bell team, front office, lost and found, urgent issue, etc.). Greetings, thanks, acknowledgements, "done"/"ok" replies and chit-chat are NOT tasks.
If it is a task: write a short imperative title (include room number if given), put useful details in description, choose the best department from: ${DEPTS.join(", ")}, set priority (urgent = safety, guest-affecting emergency or "ASAP"; high = guest waiting; medium = normal; low = no rush), and due_in_minutes only if a time or deadline is stated or implied (else null).
Message: """${text.slice(0, 1500)}"""`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": E("GEMINI_API_KEY") },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1, responseMimeType: "application/json",
        responseSchema: { type: "OBJECT", required: ["is_task"], properties: {
          is_task: { type: "BOOLEAN" }, title: { type: "STRING" }, description: { type: "STRING" },
          department: { type: "STRING", enum: DEPTS },
          priority: { type: "STRING", enum: ["low", "medium", "high", "urgent"] },
          due_in_minutes: { type: "INTEGER", nullable: true } } },
      },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return JSON.parse(j.candidates[0].content.parts[0].text);
}

async function handle(msg) {
  if (msg.fromMe || msg.from === "status@broadcast" || msg.type !== "chat" || !msg.body?.trim()) return;
  const chat = await msg.getChat();
  if (chat.isGroup ? !GROUPS.includes(chat.name) : !READ_DIRECT) return;
  const contact = await msg.getContact();
  const who = (contact.pushname || contact.name || (msg.author || msg.from).split("@")[0]) + (chat.isGroup ? ` (${chat.name})` : "");
  const body = msg.body.trim();

  const { error: dup } = await sb.from("messages").insert({ wamid: msg.id._serialized, sender: who, body });
  if (dup) { if (dup.code !== "23505") console.error("messages insert", dup); return; }

  let r;
  try { r = await extract(body); }
  catch (e) { // AI unavailable: keep the message as a plain task so nothing is lost
    console.error(e.message);
    r = { is_task: true, title: body.slice(0, 80), description: body, department: DEPTS[0], priority: "medium", due_in_minutes: null };
  }
  if (!r.is_task) { await sb.from("messages").update({ result: "ignored" }).eq("wamid", msg.id._serialized); return; }

  const mins = r.due_in_minutes ?? (r.priority === "urgent" ? 60 : r.priority === "high" ? 240 : null);
  const { data: t, error } = await sb.from("tasks").insert({
    title: r.title || body.slice(0, 80), description: r.description || "",
    department: DEPTS.includes(r.department) ? r.department : DEPTS[0], priority: r.priority || "medium",
    due: mins ? new Date(Date.now() + mins * 60000).toISOString() : null,
    source: "whatsapp", sender: who, source_message: body,
  }).select("id,title").single();
  if (error) return console.error("task insert", error);
  await sb.from("messages").update({ task_id: t.id, result: "task" }).eq("wamid", msg.id._serialized);
  await sb.from("activity").insert({ m: `WhatsApp task from ${who}: ${t.title}` });
  console.log("Task created:", t.title);
}

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "./session" }),
  puppeteer: { headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] },
});
client.on("qr", qr => { console.log("Scan this QR: WhatsApp → Linked devices → Link a device"); qrcode.generate(qr, { small: true }); });
client.on("ready", async () => {
  console.log("OpsFlow bridge connected (listen-only: it never sends messages).");
  const groups = (await client.getChats()).filter(c => c.isGroup).map(c => c.name);
  console.log("Groups on this number:\n - " + groups.join("\n - "));
  console.log("Watching:", GROUPS.length ? GROUPS.join(", ") : "(none: set WATCH_GROUPS in .env)");
});
client.on("message", m => handle(m).catch(e => console.error("handle", e)));
client.on("disconnected", r => { console.error("Disconnected:", r); process.exit(1); }); // pm2/systemd restarts it
client.initialize();
