// Taskify push notifications
//  - {type:"reminders"}  called by pg_cron every 5 min (header x-cron-secret)
//  - {type:"notify", to, title, body, taskId}  called by a signed-in member to ping the other member
import webpush from "npm:web-push@3.6.7";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

webpush.setVapidDetails(
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:taskify@example.com",
  Deno.env.get("VAPID_PUBLIC_KEY")!,
  Deno.env.get("VAPID_PRIVATE_KEY")!,
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });

type Payload = { title: string; body: string; tag?: string; url?: string };

async function sendTo(userIds: string[] | null, payload: Payload) {
  let q = admin.from("push_subscriptions").select("*");
  if (userIds) q = q.in("user_id", userIds);
  const { data: subs } = await q;
  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 12 },
      );
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        await admin.from("push_subscriptions").delete().eq("endpoint", s.endpoint);
      } else console.error("push failed", code, String(e));
    }
  }));
  return sent;
}

function fmtDue(iso: string) {
  return new Date(iso).toLocaleString("th-TH", {
    timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

async function reminders() {
  const now = Date.now();
  const { data: tasks, error } = await admin.from("tasks")
    .select("id,title,due_at,remind_before,assignee")
    .neq("status", "done")
    .is("reminded_at", null)
    .not("remind_before", "is", null)
    .not("due_at", "is", null)
    .lte("due_at", new Date(now + 8 * 864e5).toISOString());
  if (error) throw error;
  let count = 0;
  for (const t of tasks ?? []) {
    const fireAt = new Date(t.due_at).getTime() - t.remind_before * 60000;
    if (fireAt > now) continue;
    const overdue = new Date(t.due_at).getTime() < now;
    await sendTo(t.assignee ? [t.assignee] : null, {
      title: overdue ? "⏰ ถึงกำหนดแล้ว" : "⏰ ใกล้ถึงกำหนด",
      body: `${t.title} · ${fmtDue(t.due_at)}`,
      tag: t.id,
      url: `./?task=${t.id}`,
    });
    await admin.from("tasks").update({ reminded_at: new Date().toISOString() }).eq("id", t.id);
    count++;
  }
  return count;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "method" }, 405);
  const body = await req.json().catch(() => ({}));

  try {
    if (body.type === "reminders") {
      if (req.headers.get("x-cron-secret") !== Deno.env.get("CRON_SECRET")) return json({ error: "forbidden" }, 403);
      return json({ reminded: await reminders() });
    }

    if (body.type === "notify") {
      const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
      const { data: { user } } = await admin.auth.getUser(token);
      if (!user?.email) return json({ error: "unauthorized" }, 401);

      const { data: members } = await admin.from("members").select("email,user_id,display_name");
      const me = members?.find((m) => m.email === user.email.toLowerCase());
      const target = members?.find((m) => m.user_id === body.to);
      // only ping the other member, except an explicit self-test from settings
      if (!me || !target || (target.user_id === user.id && body.test !== true)) return json({ error: "forbidden" }, 403);

      const sent = await sendTo([target.user_id], {
        title: String(body.title ?? "Taskify").slice(0, 80),
        body: `${me.display_name}: ${String(body.body ?? "").slice(0, 160)}`,
        tag: body.taskId ? String(body.taskId) : undefined,
        url: body.taskId ? `./?task=${encodeURIComponent(body.taskId)}` : "./",
      });
      return json({ sent });
    }

    return json({ error: "unknown type" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: String(e) }, 500);
  }
});
