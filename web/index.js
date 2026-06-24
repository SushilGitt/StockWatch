// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import express from "express";
import serveStatic from "serve-static";

import { Session } from "@shopify/shopify-api";
import shopify from "./shopify.js";
import dbConn from "./utils/DB.config.js";
import PrivacyWebhookHandlers from "./privacy.js";
import { storeRouter } from "./Routes/Store.Routes.js";
import { thresholdRouter } from "./Routes/Threshold.Route.js";
import paymentRouter from "./Routes/Payment.route.js";

// Keep the process alive if the Shopify auth middleware (or anything else)
// throws asynchronously — e.g. a 403 from Shopify during access-token
// validation. Previously such errors crashed Node and 502'd the whole app.
const logFullError = (label, err) => {
  console.error(label, err?.message || err);
  // The Shopify HttpResponseError truncates to [Object] in default logging.
  // Print the full response so we can see Shopify's actual reason + request id.
  if (err?.response) {
    try {
      console.error(
        `${label} response:`,
        JSON.stringify(
          {
            code: err.response.code,
            statusText: err.response.statusText,
            body: err.response.body,
            requestId: err.response.headers?.["x-request-id"],
            apiVersion: err.response.headers?.["x-shopify-api-version"],
          },
          null,
          2
        )
      );
    } catch (e) {
      console.error(`${label} response (raw):`, err.response);
    }
  }
};
process.on("unhandledRejection", (reason) => {
  logFullError("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (err) => {
  logFullError("Uncaught exception:", err);
});

const PORT = parseInt(
  process.env.BACKEND_PORT || process.env.PORT || "3000",
  10
);

const STATIC_PATH =
  process.env.NODE_ENV === "production"
    ? `${process.cwd()}/frontend/dist`
    : `${process.cwd()}/frontend/`;

const app = express();

// Set up Shopify authentication and webhook handling
app.get(shopify.config.auth.path, shopify.auth.begin());
app.get(
  shopify.config.auth.callbackPath,
  shopify.auth.callback(),
  shopify.redirectToShopifyOrAppRoot()
);
app.post(
  shopify.config.webhooks.path,
  shopify.processWebhooks({ webhookHandlers: PrivacyWebhookHandlers })
);
dbConn();
// If you are adding routes outside of the /api path, remember to
// also add a proxy rule for them in web/frontend/vite.config.js

// TEMP diagnostic (remove after debugging the 403). Not behind auth so it can
// be hit directly. Uses the stored offline token to make a raw Admin GraphQL
// call and returns Shopify's exact response + the token's granted scopes.
app.get("/diag-gql", async (req, res) => {
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ error: "pass ?shop=" });
    const sessions = await shopify.config.sessionStorage.findSessionsByShop(shop);
    if (!sessions || !sessions.length)
      return res.status(404).json({ error: "no session for shop", shop });
    const session = sessions[0];
    const apiVersion = shopify.api.config.apiVersion;
    const url = `https://${shop}/admin/api/${apiVersion}/graphql.json`;
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query: "{ shop { name myshopifyDomain } }" }),
    });
    const text = await r.text();
    return res.status(200).json({
      requestedUrl: url,
      configuredApiVersion: apiVersion,
      sessionScope: session.scope,
      sessionIsOnline: session.isOnline,
      tokenPrefix: (session.accessToken || "").slice(0, 10),
      shopifyStatus: r.status,
      shopifyStatusText: r.statusText,
      shopifyHeaders: {
        "x-request-id": r.headers.get("x-request-id"),
        "x-shopify-api-version": r.headers.get("x-shopify-api-version"),
        "www-authenticate": r.headers.get("www-authenticate"),
        server: r.headers.get("server"),
        "content-type": r.headers.get("content-type"),
      },
      shopifyBody: text.slice(0, 2000),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
});

// TEMP diagnostic for the low-stock email alert pipeline (remove after fixing).
// ?shop=<shop>.myshopify.com  — reports the stored session, the Admin webhook
// subscriptions Shopify has registered, and the threshold doc for the shop.
// Add &testEmail=1 to actually send a test alert to the threshold's email.
app.get("/diag-alert", async (req, res) => {
  const out = {};
  try {
    const shop = req.query.shop;
    if (!shop) return res.status(400).json({ error: "pass ?shop=" });

    const offlineId = shopify.api.session.getOfflineId(shop);
    const session = await shopify.config.sessionStorage.loadSession(offlineId);
    out.session = session
      ? {
          scope: session.scope,
          isOnline: session.isOnline,
          expires: session.expires || null,
          expired: session.expires
            ? new Date(session.expires).getTime() < Date.now()
            : null,
          tokenPrefix: (session.accessToken || "").slice(0, 10),
        }
      : null;

    if (session?.accessToken) {
      const apiVersion = shopify.api.config.apiVersion;
      const r = await fetch(
        `https://${shop}/admin/api/${apiVersion}/graphql.json`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({
            query: `{
              webhookSubscriptions(first: 25) {
                edges { node {
                  topic
                  endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } }
                } }
              }
            }`,
          }),
        }
      );
      out.webhooksStatus = r.status;
      out.webhooks = await r.json();
    }

    const ThresholdModel = (await import("./Models/Threshold.Model.js")).default;
    out.thresholdForShop = await ThresholdModel.findOne({ domain: shop });
    out.allThresholds = await ThresholdModel.find({}).lean();

    if (req.query.testEmail) {
      const sendThresholdAlert = (await import("./Middlewares/Email.js")).default;
      const to = out.thresholdForShop?.email || req.query.to;
      if (to) {
        await sendThresholdAlert(to, "DIAG TEST PRODUCT", 0, shop.split(".")[0], "0");
        out.testEmailSentTo = to;
      } else {
        out.testEmailSentTo = "no email on file (pass &to=you@example.com)";
      }
    }

    return res.status(200).json(out);
  } catch (e) {
    out.error = e.message;
    out.stack = e.stack;
    return res.status(500).json(out);
  }
});

// Exchange an App Bridge session token for an EXPIRING offline access token.
//
// We POST the token-exchange grant ourselves instead of using
// shopify.api.auth.tokenExchange(), because @shopify/shopify-api@11.14.1 does
// NOT send `expiring=1`. Without that flag Shopify returns a legacy
// non-expiring offline token, which the Admin API now rejects with
// 403 "Non-expiring access tokens are no longer accepted". With `expiring=1`
// we get an expiring offline token (≈60 min) plus a refresh token.
// Docs: https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens/offline-access-tokens
const exchangeExpiringOfflineToken = async (shop, sessionToken) => {
  const resp = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: shopify.api.config.apiKey,
      client_secret: shopify.api.config.apiSecretKey,
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: sessionToken,
      subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
      requested_token_type:
        "urn:shopify:params:oauth:token-type:offline-access-token",
      expiring: 1,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(
      `token exchange failed (${resp.status}): ${text.slice(0, 500)}`
    );
  }

  const data = await resp.json();
  return new Session({
    id: shopify.api.session.getOfflineId(shop),
    shop,
    state: "",
    isOnline: false,
    accessToken: data.access_token,
    scope: data.scope,
    ...(data.expires_in && {
      expires: new Date(Date.now() + data.expires_in * 1000),
    }),
  });
};

// Authenticate every /api/* request via TOKEN EXCHANGE (expiring offline
// tokens). Shopify no longer accepts the non-expiring tokens that the legacy
// OAuth code-grant flow produced, and shopify-app-express 5.0.20 only does
// code-grant — so we run token exchange ourselves (see helper above).
const authViaTokenExchange = async (req, res, next) => {
  try {
    const match = (req.headers.authorization || "").match(/^Bearer (.+)$/);
    if (!match) {
      res.status(401);
      res.set("X-Shopify-Retry-Invalid-Session-Request", "1");
      return res.end();
    }
    const sessionToken = match[1];
    const payload = await shopify.api.session.decodeSessionToken(sessionToken);
    const shop = payload.dest.replace(/^https?:\/\//, "");

    const offlineId = shopify.api.session.getOfflineId(shop);
    let session = await shopify.config.sessionStorage.loadSession(offlineId);

    // Reuse only a valid, *expiring* token that hasn't expired. Otherwise
    // (missing / expired / a legacy non-expiring token with no `expires`),
    // exchange a fresh one.
    const reusable =
      session?.accessToken &&
      session.expires &&
      new Date(session.expires).getTime() > Date.now() + 10000;

    if (!reusable) {
      session = await exchangeExpiringOfflineToken(shop, sessionToken);
      await shopify.config.sessionStorage.storeSession(session);
    }

    res.locals.shopify = { session };
    next();
  } catch (e) {
    console.error("Auth (token exchange) failed:", e?.message || e);
    res.status(401);
    res.set("X-Shopify-Retry-Invalid-Session-Request", "1");
    return res.end();
  }
};

app.use("/api/*", authViaTokenExchange);

app.use(express.json());
app.use("/api/", storeRouter)
app.use("/api/", thresholdRouter)
app.use("/api/", paymentRouter)

app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

// Serve the embedded app shell directly. With token exchange the client (App
// Bridge) authenticates via session tokens, so there's no server-side OAuth
// install gate here — the merchant consent is handled by Shopify's managed
// install before the app ever loads.
app.use("/*", async (_req, res, _next) => {
  return res
    .status(200)
    .set("Content-Type", "text/html")
    .send(
      readFileSync(join(STATIC_PATH, "index.html"))
        .toString()
        .replace("%VITE_SHOPIFY_API_KEY%", process.env.SHOPIFY_API_KEY || "")
    );
});




app.listen(PORT);
