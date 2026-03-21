require("dotenv").config();

console.log("STRIPE KEY DEBUG:", process.env.STRIPE_SECRET_KEY)
console.log("PRICE PLATINUM DEBUG:", process.env.STRIPE_PRICE_PLATINUM);

const express = require("express");
const cors = require("cors");
const Stripe = require("stripe");
const { createClient } = require("@supabase/supabase-js");

const app = express();

const {
  PORT = 10000,
  NODE_ENV = "development",
  FRONTEND_URL,
  STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  STRIPE_PRICE_BRONZE,
  STRIPE_PRICE_SILVER,
  STRIPE_PRICE_GOLD,
  STRIPE_PRICE_PLATINUM,
} = process.env;

if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");
if (!SUPABASE_URL) throw new Error("Missing SUPABASE_URL");
if (!SUPABASE_SERVICE_ROLE_KEY) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
if (!FRONTEND_URL) throw new Error("Missing FRONTEND_URL");

const stripe = new Stripe(STRIPE_SECRET_KEY);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

app.use(
  cors({
    origin: [
      FRONTEND_URL,
      "http://localhost:3000",
      "http://localhost:5173",
    ],
    credentials: true,
  })
);

app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["stripe-signature"];
      const event = stripe.webhooks.constructEvent(
        req.body,
        signature,
        STRIPE_WEBHOOK_SECRET
      );

      switch (event.type) {
        case "checkout.session.completed":
          console.log("checkout.session.completed");
          break;
        case "customer.subscription.created":
        case "customer.subscription.updated":
        case "customer.subscription.deleted":
        case "invoice.payment_succeeded":
        case "invoice.payment_failed":
          console.log("Webhook event:", event.type);
          break;
        default:
          console.log("Unhandled event:", event.type);
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("Webhook error:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);

app.use(express.json());

const PLANS = {
  bronze: STRIPE_PRICE_BRONZE,
  silver: STRIPE_PRICE_SILVER,
  gold: STRIPE_PRICE_GOLD,
  platinum: STRIPE_PRICE_PLATINUM,
};

app.get("/", (req, res) => {
  res.json({
    ok: true,
    app: "ORION RADAR PRO",
    env: NODE_ENV,
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/create-checkout-session", async (req, res) => {
  try {
    const { plan, userId, email } = req.body;

    if (!plan || !userId || !email) {
      return res.status(400).json({
        error: "plan, userId e email são obrigatórios",
      });
    }

    const priceId = PLANS[String(plan).toLowerCase()];

    if (!priceId) {
      return res.status(400).json({
        error: "Plano inválido",
      });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: email,
      success_url: `${FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/pricing?canceled=true`,
      client_reference_id: userId,
      metadata: {
        user_id: userId,
        plan_key: plan,
        app: "orion_radar_pro",
      },
      subscription_data: {
        metadata: {
          user_id: userId,
          plan_key: plan,
          app: "orion_radar_pro",
        },
      },
    });

    return res.status(200).json({
      url: session.url,
      sessionId: session.id,
    });
  } catch (err) {
    console.error("create-checkout-session error:", err);
    return res.status(500).json({
      error: "Erro ao criar checkout session",
      details: err.message,
    });
  }
});

app.get("/subscription-status/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    const { data, error } = await supabase
      .from("profiles")
      .select("id, email, plan, plan_status, stripe_customer_id, stripe_subscription_id")
      .eq("id", userId)
      .single();

    if (error) throw error;

    return res.json({ ok: true, subscription: data });
  } catch (err) {
    console.error("subscription-status error:", err);
    return res.status(500).json({
      error: "Erro ao consultar assinatura",
      details: err.message,
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 ORION RADAR PRO API running on port ${PORT}`);
});
