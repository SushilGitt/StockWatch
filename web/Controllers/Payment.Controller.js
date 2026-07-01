import shopify from "../shopify.js";
import { adminGraphqlQuery } from "../utils/graphqlWithRetry.js";

export const getPayment = async (req, res) => {
    try {
        const data = await adminGraphqlQuery(res, `{
                        app {
                            installation {
                            id
                            activeSubscriptions {
                                id
                                name
                                status
                                createdAt
                            }
                            }
                        }
                    }
                        `);
        return res.status(200).json({
            data: data.body.data.app.installation.activeSubscriptions,
            message: "Payment fetched successfully",
            success: true
        });
    } catch (error) {
        return res.status(500).json({
            message: "Internal server error",
            success: false
        });
    }
}

// Plan configuration for the Billing API. Edit these to change the plan.
const PLAN_NAME = "Premium Plan";
const PLAN_PRICE = 9;             // amount per interval (USD/month)
const PLAN_CURRENCY = "USD";
const PLAN_INTERVAL = "EVERY_30_DAYS"; // monthly recurring
// Billing mode. Real charges by default (production). Set BILLING_TEST=true to
// force Shopify TEST charges (no real money) even on a live store — useful for
// staging. Dev/test stores are ALWAYS billed as test by Shopify regardless of
// this flag, so defaulting to real-by-default is safe.
const BILLING_TEST = process.env.BILLING_TEST === "true";

export const createSubscription = async (req, res) => {
    try {
        const session = res.locals.shopify.session;

        // After the merchant approves the charge, Shopify sends them back here,
        // which re-opens the embedded app in their admin.
        const returnUrl = `https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`;

        const response = await adminGraphqlQuery(res, {
                query: `
                    mutation AppSubscriptionCreate(
                        $name: String!
                        $returnUrl: URL!
                        $test: Boolean
                        $lineItems: [AppSubscriptionLineItemInput!]!
                    ) {
                        appSubscriptionCreate(
                            name: $name
                            returnUrl: $returnUrl
                            test: $test
                            lineItems: $lineItems
                        ) {
                            userErrors { field message }
                            confirmationUrl
                            appSubscription { id status }
                        }
                    }
                `,
                variables: {
                    name: PLAN_NAME,
                    returnUrl,
                    test: BILLING_TEST,
                    lineItems: [
                        {
                            plan: {
                                appRecurringPricingDetails: {
                                    price: { amount: PLAN_PRICE, currencyCode: PLAN_CURRENCY },
                                    interval: PLAN_INTERVAL,
                                },
                            },
                        },
                    ],
                },
        });

        const result = response.body.data.appSubscriptionCreate;
        console.log("appSubscriptionCreate result:", JSON.stringify(result));

        if (result.userErrors && result.userErrors.length > 0) {
            console.error(
                "appSubscriptionCreate userErrors:",
                JSON.stringify(result.userErrors)
            );
            return res.status(400).json({
                success: false,
                message: result.userErrors[0].message,
                errors: result.userErrors,
            });
        }

        return res.status(200).json({
            success: true,
            confirmationUrl: result.confirmationUrl,
        });
    } catch (error) {
        console.log("createSubscription error:", error);
        return res.status(500).json({
            message: "Internal server error",
            success: false,
        });
    }
}