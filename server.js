import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const {
  FRONTEND_URL,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_ANON_KEY,
  STRIPE_PRICE_BRONZE,
  STRIPE_PRICE_SILVER,
  STRIPE_PRICE_GOLD,
  STRIPE_PRICE_PLATINUM,
} = process.env;

if (!FRONTEND_URL) throw new Error("Missing FRONTEND_URL");
if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!STRIPE_WEBHOOK_SECRET) throw new Error("Missing STRIPE_WEBHOOK_SECRET");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");

const stripe = new Stripe(STRIPE_SECRET_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const PLAN_PRICE_MAP = {
  bronze: STRIPE_PRICE_BRONZE,
  silver: STRIPE_PRICE_SILVER,
  gold: STRIPE_PRICE_GOLD,
  platinum: STRIPE_PRICE_PLATINUM,
};

function normalizePlan(plan) {
  if (!plan) return null;
  const p = String(plan).trim().toLowerCase();
  return ["bronze", "silver", "gold", "platinum"].includes(p) ? p : null;
}

function getPlanFromPriceId(priceId) {
  const found = Object.entries(PLAN_PRICE_MAP).find(([, value]) => value === priceId);
  return found ? found[0] : null;
}

function mapStripeStatus(status) {
  switch (status) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
      return "past_due";
    case "canceled":
    case "unpaid":
    case "incomplete":
    case "incomplete_expired":
    default:
      return "inactive";
  }
}

function unixToIso(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

function safeStr(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s.length ? s : null;
}

async function findProfileByUserId(userId) {
  const id = safeStr(userId);
  if (!id) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function findProfileByCustomerId(customerId) {
  const id = safeStr(customerId);
  if (!id) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("stripe_customer_id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function findProfileBySubscriptionId(subscriptionId) {
  const id = safeStr(subscriptionId);
  if (!id) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("stripe_subscription_id", id)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function findProfileByEmail(email) {
  const e = safeStr(email);
  if (!e) return null;

  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("email", e)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function resolveProfile({
  userId,
  email,
  stripeCustomerId,
  stripeSubscriptionId,
}) {
  let profile = null;

  if (userId) profile = await findProfileByUserId(userId);
  if (!profile && stripeCustomerId) profile = await findProfileByCustomerId(stripeCustomerId);
  if (!profile && stripeSubscriptionId) profile = await findProfileBySubscriptionId(stripeSubscriptionId);
  if (!profile && email) profile = await findProfileByEmail(email);

  return profile;
}

async function saveProfileBilling({
  userId,
  email,
  selectedPlan,
  activePlan,
  billingStatus,
  stripeCustomerId,
  stripeSubscriptionId,
  stripePriceId,
  currentPeriodStart,
  currentPeriodEnd,
  cancelAtPeriodEnd,
}) {
  const normalizedUserId = safeStr(userId);
  const normalizedEmail = safeStr(email);
  const normalizedCustomerId = safeStr(stripeCustomerId);
  const normalizedSubscriptionId = safeStr(stripeSubscriptionId);
  const normalizedPriceId = safeStr(stripePriceId);

  const existing = await resolveProfile({
    userId: normalizedUserId,
    email: normalizedEmail,
    stripeCustomerId: normalizedCustomerId,
    stripeSubscriptionId: normalizedSubscriptionId,
  });

  const payload = {
    email: normalizedEmail ?? existing?.email ?? null,
    selected_plan: selectedPlan ?? existing?.selected_plan ?? null,
    active_plan: activePlan ?? existing?.active_plan ?? null,
    billing_status: billingStatus ?? existing?.billing_status ?? "inactive",
    stripe_customer_id: normalizedCustomerId ?? existing?.stripe_customer_id ?? null,
    stripe_subscription_id:
      normalizedSubscriptionId ?? existing?.stripe_subscription_id ?? null,
    stripe_price_id: normalizedPriceId ?? existing?.stripe_price_id ?? null,
    current_period_start: currentPeriodStart ?? existing?.current_period_start ?? null,
    current_period_end: currentPeriodEnd ?? existing?.current_period_end ?? null,
    cancel_at_period_end:
      typeof cancelAtPeriodEnd === "boolean"
        ? cancelAtPeriodEnd
        : existing?.cancel_at_period_end ?? false,
    updated_at: new Date().toISOString(),
  };

  if (existing?.id) {
    const { data, error } = await supabase
      .from("profiles")
      .update(payload)
      .eq("id", existing.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  if (!normalizedUserId) {
    throw new Error("Could not resolve profile and no userId provided for insert");
  }

  const insertPayload = {
    id: normalizedUserId,
    ...payload,
  };

  const { data, error } = await supabase
    .from("profiles")
    .insert(insertPayload)
    .select()
    .single();

  if (error) throw error;
  return data;
}

const allowedOrigins = new Set([
  FRONTEND_URL,
  "http://localhost:8000",
  "http://127.0.0.1:8000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://orionradar.netlify.app",
]);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.has(origin)) return callback(null, true);
      return callback(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
  })
);

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    service: "ORION RADAR PRO API",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/billing/success", (req, res) => {
  const sessionId = req.query.session_id || "";
  res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; padding: 40px;">
        <h1>Payment completed successfully</h1>
        <p>Your subscription has been processed.</p>
        <p>Session ID: ${sessionId}</p>
      </body>
    </html>
  `);
});

app.get("/billing/cancel", (_req, res) => {
  res.send(`
    <html>
      <body style="font-family: Arial, sans-serif; padding: 40px;">
        <h1>Payment canceled</h1>
        <p>You can try again whenever you want.</p>
      </body>
    </html>
  `);
});

app.get("/debug-env", (_req, res) => {
  res.json({
    supabase_url: process.env.SUPABASE_URL,
    frontend_url: process.env.FRONTEND_URL,
    has_service_role: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    has_anon_key: !!process.env.SUPABASE_ANON_KEY,
    has_stripe_key: !!process.env.STRIPE_SECRET_KEY,
    has_webhook_secret: !!process.env.STRIPE_WEBHOOK_SECRET,
  });
});

app.get("/debug-profile/:id", async (req, res) => {
  try {
    const profile = await findProfileByUserId(req.params.id);
    res.json({ profile });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/check-email-status", async (req, res) => {
  try {
    const email = safeStr(req.query.email);

    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }

    let authExists = false;
    let profileExists = false;

    let page = 1;
    const perPage = 200;

    while (true) {
      const { data, error } = await supabase.auth.admin.listUsers({
        page,
        perPage,
      });

      if (error) {
        throw error;
      }

      const users = data?.users || [];
      if (!users.length) break;

      const found = users.find(
        (u) => (u.email || "").trim().toLowerCase() === email.toLowerCase()
      );

      if (found) {
        authExists = true;
        break;
      }

      if (users.length < perPage) break;
      page += 1;
    }

    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("id,email")
      .eq("email", email)
      .maybeSingle();

    if (profileError) {
      throw profileError;
    }

    if (profile) {
      profileExists = true;
    }

    return res.json({
      exists: authExists || profileExists,
      auth_exists: authExists,
      profile_exists: profileExists,
    });
  } catch (err) {
    console.error("check-email-status error:", err);
    return res.status(500).json({
      error: "Could not check email status",
      details: err.message,
    });
  }
});

app.get("/reset-password", (_req, res) => {
  res.send(`
    <!doctype html>
    <html lang="en">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Reset Password</title>
      <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #0f172a;
          color: white;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          margin: 0;
        }
        .box {
          background: #111827;
          padding: 24px;
          border-radius: 16px;
          width: 100%;
          max-width: 420px;
          box-shadow: 0 10px 30px rgba(0,0,0,.35);
        }
        h1 { margin-top: 0; font-size: 24px; }
        p { color: #cbd5e1; }
        input {
          width: 100%;
          padding: 12px;
          margin: 8px 0 16px;
          border-radius: 10px;
          border: 1px solid #334155;
          background: #0b1220;
          color: white;
          box-sizing: border-box;
        }
        button {
          width: 100%;
          padding: 12px;
          border: 0;
          border-radius: 10px;
          background: #22c55e;
          color: white;
          font-weight: bold;
          cursor: pointer;
        }
        .msg { margin-top: 16px; font-size: 14px; }
        .ok { color: #4ade80; }
        .err { color: #f87171; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>Reset your password</h1>
        <p>Enter your new password below.</p>
        <form id="resetForm">
          <input id="password" type="password" placeholder="New password" required />
          <input id="confirmPassword" type="password" placeholder="Confirm new password" required />
          <button type="submit">Update password</button>
        </form>
        <div id="msg" class="msg"></div>
      </div>

      <script>
        const supabaseUrl = ${JSON.stringify(process.env.SUPABASE_URL)};
        const supabaseAnonKey = ${JSON.stringify(process.env.SUPABASE_ANON_KEY || "")};
        const msg = document.getElementById("msg");
        const form = document.getElementById("resetForm");

        if (!supabaseUrl || !supabaseAnonKey) {
          msg.className = "msg err";
          msg.textContent = "Missing SUPABASE_URL or SUPABASE_ANON_KEY on server.";
        } else {
          const client = window.supabase.createClient(supabaseUrl, supabaseAnonKey);

          form.addEventListener("submit", async (e) => {
            e.preventDefault();
            const password = document.getElementById("password").value;
            const confirmPassword = document.getElementById("confirmPassword").value;

            if (password !== confirmPassword) {
              msg.className = "msg err";
              msg.textContent = "Passwords do not match.";
              return;
            }

            if (password.length < 6) {
              msg.className = "msg err";
              msg.textContent = "Password must be at least 6 characters.";
              return;
            }

            const { error } = await client.auth.updateUser({ password });

            if (error) {
              msg.className = "msg err";
              msg.textContent = error.message;
              return;
            }

            msg.className = "msg ok";
            msg.textContent = "Password updated successfully. You can log in now.";
          });
        }
      </script>
    </body>
    </html>
  `);
});

app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;

    try {
      const signature = req.headers["stripe-signature"];
      event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          const customerId = safeStr(session.customer);
          const subscriptionId = safeStr(session.subscription);
          const userId = safeStr(session.metadata?.user_id);
          const selectedPlan = normalizePlan(session.metadata?.plan);
          const email = safeStr(
            session.customer_details?.email || session.metadata?.email
          );

          let activePlan = null;
          let billingStatus = "active";
          let stripePriceId = null;
          let currentPeriodStart = null;
          let currentPeriodEnd = null;
          let cancelAtPeriodEnd = false;

          if (subscriptionId) {
            const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
              expand: ["items.data.price"],
            });

            stripePriceId = safeStr(subscription.items?.data?.[0]?.price?.id);
            activePlan =
              normalizePlan(subscription.metadata?.plan) ||
              getPlanFromPriceId(stripePriceId) ||
              selectedPlan;

            billingStatus = mapStripeStatus(subscription.status);
            currentPeriodStart = unixToIso(subscription.current_period_start);
            currentPeriodEnd = unixToIso(subscription.current_period_end);
            cancelAtPeriodEnd = subscription.cancel_at_period_end || false;
          } else {
            activePlan = selectedPlan;
          }

          await saveProfileBilling({
            userId,
            email,
            selectedPlan,
            activePlan,
            billingStatus,
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            stripePriceId,
            currentPeriodStart,
            currentPeriodEnd,
            cancelAtPeriodEnd,
          });

          break;
        }

        case "customer.subscription.created":
        case "customer.subscription.updated": {
          const subscription = event.data.object;

          const customerId = safeStr(subscription.customer);
          const subscriptionId = safeStr(subscription.id);
          const userIdFromMetadata = safeStr(subscription.metadata?.user_id);
          const emailFromMetadata = safeStr(subscription.metadata?.email);
          const stripePriceId = safeStr(subscription.items?.data?.[0]?.price?.id);

          const activePlan =
            normalizePlan(subscription.metadata?.plan) ||
            getPlanFromPriceId(stripePriceId);

          await saveProfileBilling({
            userId: userIdFromMetadata,
            email: emailFromMetadata,
            selectedPlan: activePlan,
            activePlan,
            billingStatus: mapStripeStatus(subscription.status),
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            stripePriceId,
            currentPeriodStart: unixToIso(subscription.current_period_start),
            currentPeriodEnd: unixToIso(subscription.current_period_end),
            cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
          });

          break;
        }

        case "customer.subscription.deleted": {
          const subscription = event.data.object;

          const customerId = safeStr(subscription.customer);
          const subscriptionId = safeStr(subscription.id);
          const userIdFromMetadata = safeStr(subscription.metadata?.user_id);
          const emailFromMetadata = safeStr(subscription.metadata?.email);

          await saveProfileBilling({
            userId: userIdFromMetadata,
            email: emailFromMetadata,
            selectedPlan: null,
            activePlan: null,
            billingStatus: "inactive",
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
            stripePriceId: null,
            currentPeriodStart: null,
            currentPeriodEnd: null,
            cancelAtPeriodEnd: false,
          });

          break;
        }

        case "invoice.payment_failed": {
          const invoice = event.data.object;

          const customerId = safeStr(invoice.customer);
          const subscriptionId =
            typeof invoice.subscription === "string"
              ? safeStr(invoice.subscription)
              : safeStr(invoice.subscription?.id);

          let profile = await resolveProfile({
            stripeCustomerId: customerId,
            stripeSubscriptionId: subscriptionId,
          });

          if (profile) {
            await saveProfileBilling({
              userId: profile.id,
              email: profile.email,
              selectedPlan: profile.selected_plan,
              activePlan: profile.active_plan,
              billingStatus: "past_due",
              stripeCustomerId: profile.stripe_customer_id,
              stripeSubscriptionId: profile.stripe_subscription_id,
              stripePriceId: profile.stripe_price_id,
              currentPeriodStart: profile.current_period_start,
              currentPeriodEnd: profile.current_period_end,
              cancelAtPeriodEnd: profile.cancel_at_period_end,
            });
          }

          break;
        }

        default:
          console.log("Unhandled event:", event.type);
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("Webhook processing error:", err);
      return res.status(500).json({
        error: "Webhook handler failed",
        details: err.message,
      });
    }
  }
);

app.use(express.json());

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { plan, userId, email } = req.body;

    const normalizedPlan = normalizePlan(plan);
    if (!normalizedPlan) {
      return res.status(400).json({ error: "Invalid plan" });
    }

    const normalizedUserId = safeStr(userId);
    const normalizedEmail = safeStr(email);

    const priceId = PLAN_PRICE_MAP[normalizedPlan];
    if (!priceId) {
      return res.status(400).json({ error: "Price not configured for this plan" });
    }

    let customerId = null;

    if (normalizedUserId) {
      const profile = await findProfileByUserId(normalizedUserId);

      if (!profile) {
        return res.status(404).json({ error: "Profile not found" });
      }

      customerId = profile.stripe_customer_id || null;

      await saveProfileBilling({
        userId: normalizedUserId,
        email: normalizedEmail || profile.email || null,
        selectedPlan: normalizedPlan,
        activePlan: profile.active_plan,
        billingStatus: profile.billing_status || "inactive",
        stripeCustomerId: profile.stripe_customer_id,
        stripeSubscriptionId: profile.stripe_subscription_id,
        stripePriceId: profile.stripe_price_id,
        currentPeriodStart: profile.current_period_start,
        currentPeriodEnd: profile.current_period_end,
        cancelAtPeriodEnd: profile.cancel_at_period_end,
      });
    }

    if (!customerId && normalizedEmail) {
      const customers = await stripe.customers.list({
        email: normalizedEmail,
        limit: 1,
      });
      customerId = customers.data?.[0]?.id || null;
    }

    const metadata = {
      user_id: normalizedUserId,
      email: normalizedEmail,
      plan: normalizedPlan,
    };

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      customer: customerId || undefined,
      customer_email: customerId ? undefined : normalizedEmail || undefined,
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata,
      subscription_data: {
        metadata,
      },
      success_url: `${FRONTEND_URL}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/billing/cancel`,
      allow_promotion_codes: true,
    });

    return res.json({ url: session.url });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({
      error: "Could not create checkout session",
      details: err.message,
    });
  }
});

app.post("/create-customer-portal-session", async (req, res) => {
  try {
    const { userId } = req.body;
    const normalizedUserId = safeStr(userId);

    if (!normalizedUserId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const profile = await findProfileByUserId(normalizedUserId);

    if (!profile?.stripe_customer_id) {
      return res.status(404).json({ error: "Stripe customer not found" });
    }

    const portalSession = await stripe.billingPortal.sessions.create({
      customer: profile.stripe_customer_id,
      return_url: `${FRONTEND_URL}/dashboard`,
    });

    return res.json({ url: portalSession.url });
  } catch (err) {
    console.error("create-customer-portal-session error:", err);
    return res.status(500).json({
      error: "Could not create portal session",
      details: err.message,
    });
  }
});

app.get("/subscription-status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;
    const profile = await findProfileByUserId(userId);

    if (!profile) {
      return res.status(404).json({ error: "Profile not found" });
    }

    return res.json({
      id: profile.id,
      email: profile.email,
      selected_plan: profile.selected_plan,
      active_plan: profile.active_plan,
      billing_status: profile.billing_status,
      stripe_customer_id: profile.stripe_customer_id,
      stripe_subscription_id: profile.stripe_subscription_id,
      stripe_price_id: profile.stripe_price_id,
      current_period_start: profile.current_period_start,
      current_period_end: profile.current_period_end,
      cancel_at_period_end: profile.cancel_at_period_end,
    });
  } catch (err) {
    console.error("subscription-status error:", err);
    return res.status(500).json({
      error: "Could not fetch subscription status",
      details: err.message,
    });
  }
});

app.post("/sync-subscription", async (req, res) => {
  try {
    const { userId } = req.body;
    const normalizedUserId = safeStr(userId);

    if (!normalizedUserId) {
      return res.status(400).json({ error: "userId is required" });
    }

    const profile = await findProfileByUserId(normalizedUserId);

    if (!profile?.stripe_subscription_id) {
      return res.status(404).json({ error: "No subscription found" });
    }

    const subscription = await stripe.subscriptions.retrieve(
      profile.stripe_subscription_id,
      { expand: ["items.data.price"] }
    );

    const stripePriceId = safeStr(subscription.items?.data?.[0]?.price?.id);
    const activePlan =
      normalizePlan(subscription.metadata?.plan) ||
      getPlanFromPriceId(stripePriceId) ||
      profile.active_plan;

    const updated = await saveProfileBilling({
      userId: profile.id,
      email: profile.email,
      selectedPlan: profile.selected_plan || activePlan,
      activePlan,
      billingStatus: mapStripeStatus(subscription.status),
      stripeCustomerId: subscription.customer,
      stripeSubscriptionId: subscription.id,
      stripePriceId,
      currentPeriodStart: unixToIso(subscription.current_period_start),
      currentPeriodEnd: unixToIso(subscription.current_period_end),
      cancelAtPeriodEnd: subscription.cancel_at_period_end || false,
    });

    return res.json({ ok: true, profile: updated });
  } catch (err) {
    console.error("sync-subscription error:", err);
    return res.status(500).json({
      error: "Could not sync subscription",
      details: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`ORION RADAR PRO API running on port ${PORT}`);
});