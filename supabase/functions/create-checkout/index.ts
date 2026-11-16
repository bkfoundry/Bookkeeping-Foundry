import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

// Starts a Stripe Checkout for the logged-in member.
// Body: { plan: "workspace" | "membership" | "growth" | "alumni", code?: string, return_url: string }
// Secrets needed in Supabase: STRIPE_SECRET_KEY.
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { httpClient: Stripe.createFetchHttpClient() });
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const PLANS = ["workspace", "membership", "growth", "alumni"];
const ALLOWED_HOSTS = [/^(www\.)?bkfoundry\.com$/, /^(bkfoundry|gem-foundry|foundry-membership-test)\.netlify\.app$/, /^[a-z0-9-]+--(bkfoundry|gem-foundry|foundry-membership-test)\.netlify\.app$/];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

function safeReturn(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || !ALLOWED_HOSTS.some((r) => r.test(u.hostname))) return null;
    return u.origin + u.pathname;
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ error: "method_not_allowed" }, 405);
  if (!Deno.env.get("STRIPE_SECRET_KEY")) return reply({ error: "not_configured" }, 503);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "");
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user) return reply({ error: "not_logged_in" }, 401);

  let body: { plan?: string; code?: string; return_url?: string };
  try { body = await req.json(); } catch { return reply({ error: "bad_request" }, 400); }
  const plan = String(body.plan ?? "");
  if (!PLANS.includes(plan)) return reply({ error: "unknown_plan" }, 400);
  const back = safeReturn(String(body.return_url ?? "")) ?? "https://bkfoundry.com/";

  const email = (user.email ?? "").toLowerCase();
  if (plan === "growth") {
    const { data: ok } = await admin.from("growth_approvals").select("email").eq("email", email).maybeSingle();
    if (!ok) return reply({ error: "not_approved" }, 403);
  }

  const { data: existing } = await admin.from("memberships")
    .select("plan,status,stripe_customer_id,stripe_subscription_id").eq("user_id", user.id).maybeSingle();
  if (existing?.status === "active" && existing.stripe_subscription_id) {
    return reply({ error: "already_member", plan: existing.plan }, 409);
  }

  const livemode = (Deno.env.get("STRIPE_SECRET_KEY") ?? "").startsWith("sk_live") || (Deno.env.get("STRIPE_SECRET_KEY") ?? "").startsWith("rk_live");
  const { data: price } = await admin.from("stripe_prices").select("price_id")
    .eq("plan", plan).eq("livemode", livemode).order("created_at", { ascending: false }).limit(1).maybeSingle();
  if (!price) return reply({ error: "plan_not_for_sale" }, 400);

  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "subscription",
    line_items: [{ price: price.price_id, quantity: 1 }],
    client_reference_id: user.id,
    subscription_data: { metadata: { user_id: user.id, plan } },
    success_url: back + "?checkout=success",
    cancel_url: back + "?checkout=canceled#pricing",
  };
  if (existing?.stripe_customer_id) params.customer = existing.stripe_customer_id;
  else params.customer_email = user.email ?? undefined;

  const code = String(body.code ?? "").trim().toUpperCase();
  if (code) {
    const found = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
    if (!found.data.length) return reply({ error: "bad_code" }, 400);
    params.discounts = [{ promotion_code: found.data[0].id }];
  } else {
    params.allow_promotion_codes = true;
  }

  try {
    const session = await stripe.checkout.sessions.create(params);
    return reply({ url: session.url });
  } catch (err) {
    const msg = (err as Error).message ?? "";
    console.error("Checkout failed", msg);
    if (/coupon|promotion|discount/i.test(msg)) return reply({ error: "code_not_for_plan" }, 400);
    return reply({ error: "checkout_failed" }, 500);
  }
});
