// api/chat.js — Vercel serverless function
// Add these environment variables in your Vercel dashboard:
//   ANTHROPIC_API_KEY     — your Anthropic API key
//   SUPABASE_URL          — your Supabase project URL
//   SUPABASE_SERVICE_KEY  — Supabase service role key (NOT the anon key)
//   APP_SECRET            — any random string, must match the app

import { createClient } from "@supabase/supabase-js";

const FREE_ANALYSES = 2;
const MAX_PER_HOUR = 5;

export default async function handler(req, res) {
  // ── Method check ───────────────────────────────────────────────
  if (req.method !== "POST") return res.status(405).end();

  // ── App secret check ───────────────────────────────────────────
  if (req.headers["x-app-secret"] !== process.env.APP_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  // ── Auth check ─────────────────────────────────────────────────
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing auth token" });
  }
  const token = authHeader.slice(7);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  // Verify the JWT is a real Supabase session
  const { data: { user }, error: authError } = await supabase.auth.getUser(token);
  if (authError || !user) {
    return res.status(401).json({ error: "Invalid session" });
  }

  // ── Rate limit check (per-hour) ────────────────────────────────
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: recentCount } = await supabase
    .from("usage_log")
    .select("*", { count: "exact", head: true })
    .eq("user_id", user.id)
    .gte("created_at", hourAgo);

  if (recentCount >= MAX_PER_HOUR) {
    return res.status(429).json({ error: "Rate limit: max 5 analyses per hour" });
  }

  // ── Subscription / usage gate ──────────────────────────────────
  const { data: sub } = await supabase
    .from("subscriptions")
    .select("status, expires_at")
    .eq("user_id", user.id)
    .single();

  const isSubscribed =
    sub?.status === "active" &&
    (!sub.expires_at || new Date(sub.expires_at) > new Date());

  if (!isSubscribed) {
    const { data: usage } = await supabase
      .from("usage")
      .select("count")
      .eq("user_id", user.id)
      .single();

    const usageCount = usage?.count ?? 0;
    if (usageCount >= FREE_ANALYSES) {
      return res.status(402).json({ error: "Free limit reached", code: "UPGRADE_REQUIRED" });
    }
  }

  // ── Log this call ──────────────────────────────────────────────
  await supabase.from("usage_log").insert({ user_id: user.id });

  // ── Forward to Anthropic ───────────────────────────────────────
  const anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(req.body),
  });

  const data = await anthropicRes.json();
  return res.status(anthropicRes.status).json(data);
}
