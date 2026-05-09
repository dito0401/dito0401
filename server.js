require("dotenv").config();

const express = require("express");
const Stripe = require("stripe");
const axios = require("axios");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
  { auth: { persistSession: false } }
);

const app = express();

// Map payment link IDs → Discord role IDs
const ROLE_MAP = {
  // $1697 — full access
  "plink_1TTP3VJ8mEMTtXZSMRjJWTUY": [
    process.env.ROLE_MEMBER,
    process.env.ROLE_VERIFIED,
    process.env.ROLE_BEGINNER,
  ],
  // $249 — member only
  "plink_1TTP3jJ8mEMTtXZSYer0QXBG": [process.env.ROLE_MEMBER],
  // $79 — member only
  "plink_1TTP3vJ8mEMTtXZSzE5ieRLq": [process.env.ROLE_MEMBER],
};

// ============================================================
// WEBHOOK ROUTE — must come BEFORE express.json() and use raw body
// ============================================================
app.post(
  "/stripe/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        process.env.STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("Webhook signature verification failed:", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Idempotency: skip if we've already processed this event
    const { data: seen } = await supabase
      .from("stripe_bot_processed_events")
      .select("event_id")
      .eq("event_id", event.id)
      .maybeSingle();

    if (seen) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      if (event.type === "checkout.session.completed") {
        const s = event.data.object;
        if (s.payment_status === "paid") {
          // Upsert: preserve discord_user_id if it was already set by the OAuth callback
          const { data: existing } = await supabase
            .from("stripe_bot_sessions")
            .select("discord_user_id")
            .eq("session_id", s.id)
            .maybeSingle();

          await supabase.from("stripe_bot_sessions").upsert({
            session_id: s.id,
            payment_intent_id: s.payment_intent,
            payment_link_id: s.payment_link,
            customer_id: s.customer,
            discord_user_id: existing?.discord_user_id || null,
            status: "paid",
          });
          console.log("Payment recorded:", s.id, "link:", s.payment_link);
        }
      }

      if (
        event.type === "charge.refunded" ||
        event.type === "charge.dispute.created"
      ) {
        const pi = event.data.object.payment_intent;
        const { data: row } = await supabase
          .from("stripe_bot_sessions")
          .select("*")
          .eq("payment_intent_id", pi)
          .maybeSingle();

        if (row?.discord_user_id) {
          const roles = ROLE_MAP[row.payment_link_id] || [];
          for (const roleId of roles) {
            try {
              await axios.delete(
                `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${row.discord_user_id}/roles/${roleId}`,
                {
                  headers: {
                    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                  },
                }
              );
              console.log(
                "Removed role",
                roleId,
                "from",
                row.discord_user_id
              );
            } catch (e) {
              console.error(
                "Role removal failed:",
                roleId,
                e.response?.data || e.message
              );
            }
          }

          // For disputes, also kick from the server
          if (event.type === "charge.dispute.created") {
            try {
              await axios.delete(
                `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${row.discord_user_id}`,
                {
                  headers: {
                    Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
                  },
                }
              );
              console.log("Kicked disputed user:", row.discord_user_id);
            } catch (e) {
              console.error("Kick failed:", e.response?.data || e.message);
            }
          }

          await supabase
            .from("stripe_bot_sessions")
            .update({
              status:
                event.type === "charge.refunded" ? "refunded" : "disputed",
            })
            .eq("session_id", row.session_id);
        } else {
          console.log("No discord_user_id on file for payment_intent:", pi);
        }
      }

      // Mark this event as processed
      await supabase
        .from("stripe_bot_processed_events")
        .insert({ event_id: event.id });

      res.json({ received: true });
    } catch (err) {
      console.error("Webhook handler error:", err);
      // Don't mark as processed — let Stripe retry
      res.status(500).json({ error: "handler failed" });
    }
  }
);

// ============================================================
// JSON parser for everything else (must come AFTER webhook)
// ============================================================
app.use(express.json());

// ============================================================
// ROUTES
// ============================================================
app.get("/", (req, res) => {
  res.send("Discord Stripe Bot Running");
});

app.get("/success", async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) return res.status(400).send("Missing session ID");

  // Verify the session is paid before doing anything
  let session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId);
  } catch {
    return res.status(400).send("Invalid session");
  }

  if (session.payment_status !== "paid") {
    return res
      .status(402)
      .send(
        "Payment is still processing. Please refresh this page in a few seconds."
      );
  }

  // Generate a real CSRF state token
  const state = crypto.randomBytes(32).toString("hex");
  await supabase.from("stripe_bot_oauth_states").insert({
    state,
    session_id: sessionId,
  });

  // Make sure the session row exists (webhook may not have arrived yet)
  await supabase.from("stripe_bot_sessions").upsert(
    {
      session_id: session.id,
      payment_intent_id: session.payment_intent,
      payment_link_id: session.payment_link,
      customer_id: session.customer,
      status: "paid",
    },
    { onConflict: "session_id", ignoreDuplicates: true }
  );

  const params = new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID,
    response_type: "code",
    redirect_uri: process.env.BASE_URL + "/discord/callback",
    scope: "identify guilds.join",
    state,
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/discord/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).send("Missing code or state");

  // Validate state and extract session
  const { data: stateRow } = await supabase
    .from("stripe_bot_oauth_states")
    .select("session_id")
    .eq("state", state)
    .maybeSingle();

  if (!stateRow) {
    return res.status(400).send("Invalid or expired state token");
  }

  // Consume the state (one-time use)
  await supabase.from("stripe_bot_oauth_states").delete().eq("state", state);

  const { data: sessionRow } = await supabase
    .from("stripe_bot_sessions")
    .select("*")
    .eq("session_id", stateRow.session_id)
    .maybeSingle();

  if (!sessionRow || sessionRow.status !== "paid") {
    return res.status(402).send("Payment not verified.");
  }

  try {
    // Exchange code for access token
    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.BASE_URL + "/discord/callback",
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );
    const accessToken = tokenRes.data.access_token;

    // Get the Discord user
    const userRes = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const discordUser = userRes.data;

    // Save the discord_user_id against the session
    await supabase
      .from("stripe_bot_sessions")
      .update({ discord_user_id: discordUser.id })
      .eq("session_id", sessionRow.session_id);

    const roles = ROLE_MAP[sessionRow.payment_link_id] || [];
    if (roles.length === 0) {
      console.error(
        "No roles mapped for payment_link_id:",
        sessionRow.payment_link_id
      );
      return res
        .status(500)
        .send(
          `Connected, but no roles configured for this purchase. Contact support with session ${sessionRow.session_id}.`
        );
    }

    // Add the user to the guild
    await axios.put(
      `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordUser.id}`,
      { access_token: accessToken },
      {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    // Assign each role with per-role error handling
    const failed = [];
    for (const roleId of roles) {
      try {
        await axios.put(
          `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordUser.id}/roles/${roleId}`,
          {},
          {
            headers: {
              Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
            },
          }
        );
      } catch (e) {
        console.error(
          "Role assign failed:",
          roleId,
          e.response?.data || e.message
        );
        failed.push(roleId);
      }
    }

    if (failed.length) {
      return res.send(
        `Connected, but ${failed.length} role(s) failed to assign. Contact support with session ${sessionRow.session_id}.`
      );
    }

    // Success — show a welcome page that auto-redirects to Discord
    const discordUrl = `https://discord.com/channels/${process.env.DISCORD_GUILD_ID}`;
    res.send(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="utf-8">
          <title>You're in!</title>
          <meta name="viewport" content="width=device-width, initial-scale=1">
          <meta http-equiv="refresh" content="2;url=${discordUrl}">
          <style>
            * { box-sizing: border-box; }
            body {
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
              background: linear-gradient(135deg, #1e1f22 0%, #2b2d31 100%);
              color: #fff;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100vh;
              margin: 0;
              text-align: center;
              padding: 1rem;
            }
            .box {
              max-width: 480px;
              padding: 2.5rem 2rem;
              background: rgba(0,0,0,0.25);
              border-radius: 16px;
              border: 1px solid rgba(255,255,255,0.08);
            }
            .check {
              width: 64px;
              height: 64px;
              margin: 0 auto 1.25rem;
              border-radius: 50%;
              background: #5865f2;
              display: flex;
              align-items: center;
              justify-content: center;
              font-size: 32px;
            }
            h1 {
              font-size: 1.75rem;
              margin: 0 0 0.5rem 0;
              font-weight: 700;
            }
            p {
              opacity: 0.75;
              line-height: 1.5;
              margin: 0.5rem 0;
            }
            .link {
              display: inline-block;
              margin-top: 1rem;
              padding: 0.75rem 1.5rem;
              background: #5865f2;
              color: #fff;
              text-decoration: none;
              border-radius: 8px;
              font-weight: 600;
              transition: background 0.15s;
            }
            .link:hover { background: #4752c4; }
            .small { font-size: 0.85rem; opacity: 0.55; margin-top: 1.25rem; }
          </style>
        </head>
        <body>
          <div class="box">
            <div class="check">✓</div>
            <h1>You're in!</h1>
            <p>Your Discord roles have been assigned.</p>
            <p>Opening Discord in a moment…</p>
            <a class="link" href="${discordUrl}">Open Discord now</a>
            <p class="small">If nothing happens, click the button above.</p>
          </div>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("Callback error:", err.response?.data || err.message);
    res
      .status(500)
      .send(
        `Something went wrong. Contact support with session ${sessionRow.session_id}.`
      );
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});