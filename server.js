require("dotenv").config();

const express = require("express");
const Stripe = require("stripe");
const axios = require("axios");
const cors = require("cors");

const app = express();

app.get("/", (req, res) => {
  res.send("Discord Stripe Bot Running");
});

const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(cors());

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const ROLE_MAP = {
  "https://buy.stripe.com/00wdRadZd79v3RN0vf7ss01": [
    process.env.ROLE_MEMBER,
    process.env.ROLE_VERIFIED,
    process.env.ROLE_BEGINNER,
  ],

  "https://buy.stripe.com/aFaaEYcV9eBXfAv4Lv7ss02": [
    process.env.ROLE_MEMBER,
  ],

  "https://buy.stripe.com/aFacN68ETgK573Z3Hr7ss03": [
    process.env.ROLE_MEMBER,
  ],
};

const pendingUsers = new Map();

app.get("/", (req, res) => {
  res.send("Discord Stripe Bot Running");
});

app.get("/success", async (req, res) => {
  const sessionId = req.query.session_id;

  if (!sessionId) {
    return res.send("Missing session ID");
  }

  pendingUsers.set(sessionId, true);

  const discordAuthUrl =
    `https://discord.com/oauth2/authorize` +
    `?client_id=${process.env.DISCORD_CLIENT_ID}` +
    `&response_type=code` +
    `&redirect_uri=${encodeURIComponent(
      process.env.BASE_URL + "/discord/callback"
    )}` +
    `&scope=identify guilds.join` +
    `&state=${sessionId}`;

  res.redirect(discordAuthUrl);
});

app.get("/discord/callback", async (req, res) => {
  try {
    const code = req.query.code;
    const sessionId = req.query.state;

    if (!pendingUsers.has(sessionId)) {
      return res.send("Invalid session");
    }

    const tokenResponse = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID,
        client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: process.env.BASE_URL + "/discord/callback",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const accessToken = tokenResponse.data.access_token;

    const userResponse = await axios.get(
      "https://discord.com/api/users/@me",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      }
    );

    const discordUser = userResponse.data;

    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const paymentLink = session.payment_link;

    let assignedRoles = [];

    if (paymentLink) {
      const paymentLinkData = await stripe.paymentLinks.retrieve(paymentLink);

      const paymentLinkUrl = paymentLinkData.url;

      assignedRoles = ROLE_MAP[paymentLinkUrl] || [];
    }

    await axios.put(
      `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordUser.id}`,
      {
        access_token: accessToken,
      },
      {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    for (const roleId of assignedRoles) {
      await axios.put(
        `https://discord.com/api/guilds/${process.env.DISCORD_GUILD_ID}/members/${discordUser.id}/roles/${roleId}`,
        {},
        {
          headers: {
            Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
          },
        }
      );
    }

    res.send("Discord connected successfully. Roles assigned.");
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("Something went wrong.");
  }
});

app.post("/stripe/webhook", async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.log(err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    console.log("Payment completed");
  }

  if (
    event.type === "charge.refunded" ||
    event.type === "charge.dispute.created"
  ) {
    console.log("Refund or dispute detected");
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Running on port ${PORT}`);
});