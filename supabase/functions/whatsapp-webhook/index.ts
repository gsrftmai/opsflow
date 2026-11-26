// OpsFlow WhatsApp webhook: Meta Cloud API → Gemini (free tier) → tasks table.
import { createClient } from "npm:@supabase/supabase-js@2";

const E = (k: string, d = "") => Deno.env.get(k) ?? d;
const sb = createClient(E("SUPABASE_URL"), E("SUPABASE_SERVICE_ROLE_KEY"));
const MODEL = E("GEMINI_MODEL", "gemini-2.5-flash"); // pick a free-tier Flash model from AI Studio
const TZ = E("TIMEZONE", "Europe/Nicosia");
const DEPTS = E("DEPARTMENTS", "Front Office,Housekeeping,Maintenance,Bell Team,Concierge,F&B").split(",").map(s => s.trim());
const ALLOWED = E("ALLOWED_SENDERS").split(",").map(s => s.trim()).filter(Boolean); // e.g. 35799123456 (optional)
const REPLY = E("REPLY_ENABLED", "true") === "true";
const enc = new TextEncoder();

async function validSig(raw: string, header: string | null) {
  if (!header) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(E("WA_APP_SECRET")), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(raw)));
  const hex = "sha256=" + [...sig].map(b => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== header.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ header.charCodeAt(i);
  return diff === 0;
}

async function extract(text: string) {
  const now = new Date().toLocaleString("en-GB", { timeZone: TZ, dateStyle: "full", timeStyle: "short" });
  const prompt = `You triage WhatsApp messages for a hotel operations team. Current local time: ${now}.
Decide if the message contains an actionable operational request (guest request, maintenance issue, housekeeping, bell team, front office, lost and found, urgent issue, etc.). Greetings, thanks, acknowledgements and chit-chat are NOT tasks.
If it is a task: write a short imperative title (include room number if given), put useful details in description, choose the best department from: ${DEPTS.join(", ")}, set priority (urgent = safety, guest-affecting emergency or "ASAP"; high = guest waiting; medium = normal; low = no rush), and due_in_minutes only if a time or deadline is stated or implied (else null).
Message: """${text.slice(0, 1500)}"""`;
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": E("GEMINI_API_KEY") },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            is_task: { type: "BOOLEAN" },
            title: { type: "STRING" },
            description: { type: "STRING" },
            department: { type: "STRING", enum: DEPTS },
            priority: { type: "STRING", enum: ["low", "medium", "high", "urgent"] },
            due_in_minutes: { type: "INTEGER", nullable: true },
          },
          required: ["is_task"],
        },
      },
    }),
  });
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return JSON.parse(j.candidates[0].content.parts[0].text);
}

async function reply(to: string, body: string) {
  if (!REPLY) return;
  const r = await fetch(`https://graph.facebook.com/v21.0/${E("WA_PHONE_ID")}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${E("WA_TOKEN")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, text: { body } }),
  });
  if (!r.ok) console.error("WhatsApp reply failed", r.status, await r.text());
}

async function handle(m: any, name: string) {
  const from: string = m.from;
  if (ALLOWED.length && !ALLOWED.includes(from)) return;
  const body: string | undefined = m.text?.body ?? m.image?.caption ?? m.video?.caption ?? m.document?.caption;
  const who = name || from;

  const { error: dup } = await sb.from("messages").insert({ wamid: m.id, sender: who, body: body ?? `[${m.type}]` });
  if (dup) { if (dup.code !== "23505") console.error("messages insert", dup); return; } // 23505 = already processed
  if (!body) { await reply(from, "OpsFlow reads text messages only for now. Please send the request as text."); return; }

  let r;
  try { r = await extract(body); }
  catch (e) { // AI down or rate-limited: keep the message as a plain task so nothing is lost
    console.error(e);
    r = { is_task: true, title: body.slice(0, 80), description: body, department: DEPTS[0], priority: "medium", due_in_minutes: null };
  }
  if (!r.is_task) { await sb.from("messages").update({ result: "ignored" }).eq("wamid", m.id); return; }

  const mins = r.due_in_minutes ?? (r.priority === "urgent" ? 60 : r.priority === "high" ? 240 : null);
  const { data: t, error } = await sb.from("tasks").insert({
    title: r.title || body.slice(0, 80), description: r.description || "",
    department: DEPTS.includes(r.department) ? r.department : DEPTS[0],
    priority: r.priority || "medium",
    due: mins ? new Date(Date.now() + mins * 60000).toISOString() : null,
    source: "whatsapp", sender: who, source_message: body,
  }).select("id,title,department,priority").single();
  if (error) { console.error("task insert", error); return; }

  await sb.from("messages").update({ task_id: t.id, result: "task" }).eq("wamid", m.id);
  await sb.from("activity").insert({ m: `WhatsApp task from ${who}: ${t.title}` });
  await reply(from, `✅ Task created: ${t.title}\n${t.department} · ${t.priority}`);
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  if (req.method === "GET") { // Meta webhook verification
    if (url.searchParams.get("hub.mode") === "subscribe" && url.searchParams.get("hub.verify_token") === E("WA_VERIFY_TOKEN"))
      return new Response(url.searchParams.get("hub.challenge"), { status: 200 });
    return new Response("Forbidden", { status: 403 });
  }
  const raw = await req.text();
  if (!(await validSig(raw, req.headers.get("x-hub-signature-256")))) return new Response("Bad signature", { status: 401 });
  try {
    const payload = JSON.parse(raw);
    for (const entry of payload.entry ?? []) for (const ch of entry.changes ?? []) {
      const v = ch.value ?? {};
      const names: Record<string, string> = {};
      for (const c of v.contacts ?? []) names[c.wa_id] = c.profile?.name ?? "";
      for (const m of v.messages ?? []) await handle(m, names[m.from] ?? "");
    }
  } catch (e) { console.error(e); }
  return new Response("ok", { status: 200 }); // always 200 so Meta doesn't retry-storm; wamid dedupe covers retries anyway
});
