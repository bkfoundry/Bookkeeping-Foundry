import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import Stripe from "npm:stripe@17";
import { createClient } from "npm:@supabase/supabase-js@2";

// Turns Stripe subscription events into rows in public.memberships.
// Secrets needed in Supabase: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET.
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY") ?? "", { httpClient: Stripe.createFetchHttpClient() });
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const GRACE_DAYS = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mapStatus(s: string): string {
  if (s === "active" || s === "trialing") return "active";
  if (s === "past_due") return "past_due";
  if (s === "incomplete") return "incomplete";
  return "canceled";
}

async function planFor(sub: Stripe.Subscription): Promise<string | null> {
  for (const item of sub.items.data) {
    const { data } = await admin.from("stripe_prices").select("plan").eq("price_id", item.price.id).maybeSingle();
    if (data) return data.plan;
  }
  return null;
}

function periodEnd(sub: Stripe.Subscription): string | null {
  // Newer Stripe API versions keep the period on each item.
  const ends = sub.items.data.map((i) => (i as unknown as { current_period_end?: number }).current_period_end ?? 0);
  const end = Math.max(0, ...ends, (sub as unknown as { current_period_end?: number }).current_period_end ?? 0);
  if (!end) return null;
  return new Date((end + GRACE_DAYS * 86400) * 1000).toISOString();
}

async function isFounder(sub: Stripe.Subscription): Promise<boolean> {
  const discounts = (sub.discounts ?? []) as Array<string | Stripe.Discount>;
  for (const d of discounts) {
    const disc = typeof d === "string" ? null : d;
    const pc = disc?.promotion_code;
    if (!pc) continue;
    const promo = typeof pc === "string" ? await stripe.promotionCodes.retrieve(pc) : pc;
    if (promo.code?.toUpperCase().startsWith("FOUNDER")) return true;
  }
  return false;
}

async function knownUser(id: string | null | undefined): Promise<string | null> {
  if (!id || !UUID.test(id)) return null;
  const { data: u } = await admin.auth.admin.getUserById(id);
  return u?.user ? id : null;
}

async function syncSubscription(sub: Stripe.Subscription, userId?: string | null) {
  const plan = await planFor(sub);
  if (!plan) { console.error("No plan mapped for subscription", sub.id); return; }
  const row: Record<string, unknown> = {
    plan,
    status: mapStatus(sub.status),
    stripe_customer_id: typeof sub.customer === "string" ? sub.customer : sub.customer.id,
    stripe_subscription_id: sub.id,
    current_period_end: periodEnd(sub),
  };
  if (await isFounder(sub)) row.is_founding_member = true;

  // The checkout function stamps the member id on the subscription itself.
  if (!userId) userId = await knownUser(sub.metadata?.user_id);

  if (userId) {
    const { data: existing } = await admin.from("memberships").select("id,stripe_subscription_id").eq("user_id", userId).maybeSingle();
    // Ignore late events from an older subscription once the member has a newer one.
    if (existing?.stripe_subscription_id && existing.stripe_subscription_id !== sub.id && row.status === "canceled") return;
    if (existing) await admin.from("memberships").update(row).eq("user_id", userId);
    else await admin.from("memberships").insert({ user_id: userId, ...row });
    return;
  }
  const { data: bySub } = await admin.from("memberships").select("id").eq("stripe_subscription_id", sub.id).maybeSingle();
  if (bySub) await admin.from("memberships").update(row).eq("id", bySub.id);
  else console.error("Subscription not linked to a member yet", sub.id);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const signature = req.headers.get("Stripe-Signature");
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!signature || !secret) return new Response("Not configured", { status: 400 });
  const body = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, secret, undefined, cryptoProvider);
  } catch (err) {
    console.error("Bad signature", (err as Error).message);
    return new Response("Bad signature", { status: 400 });
  }

  const { error: dupe } = await admin.from("stripe_events").insert({ id: event.id, type: event.type });
  if (dupe) return new Response("Already handled", { status: 200 });

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.mode === "subscription" && session.subscription) {
        const userId = await knownUser(session.client_reference_id);
        if (!userId) console.error("Checkout without a known member id", session.id);
        else {
          const sub = await stripe.subscriptions.retrieve(String(session.subscription), { expand: ["discounts.promotion_code"] });
          await syncSubscription(sub, userId);
        }
      }
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      const sub = await stripe.subscriptions.retrieve((event.data.object as Stripe.Subscription).id, { expand: ["discounts.promotion_code"] });
      await syncSubscription(sub, null);
    }
  } catch (err) {
    console.error("Webhook handling failed", event.type, (err as Error).message);
    await admin.from("stripe_events").delete().eq("id", event.id);
    return new Response("Error", { status: 500 });
  }
  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
