// @ts-check
import { join } from "path";
import { readFileSync } from "fs";
import express from "express";
import serveStatic from "serve-static";

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

app.use("/api/*", shopify.validateAuthenticatedSession());

app.use(express.json());
app.use("/api/", storeRouter)
app.use("/api/", thresholdRouter)
app.use("/api/", paymentRouter)

app.use(shopify.cspHeaders());
app.use(serveStatic(STATIC_PATH, { index: false }));

app.use("/*", shopify.ensureInstalledOnShop(), async (_req, res, _next) => {
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
