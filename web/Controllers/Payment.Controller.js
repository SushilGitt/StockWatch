import shopify from "../shopify.js";

export const getPayment = async (req, res) => {
    try {
        const client = new shopify.api.clients.Graphql({
            session: res.locals.shopify.session
        });
        const data = await client.query({
            data: `{
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
                        `
        });
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
// test: true => Shopify never charges real money (always test charges, even on
// live stores). Defaults to test mode for safety; set the env var
// BILLING_TEST=false in production to bill merchants for real.
// (Dev/test stores are always billed as test regardless of this flag.)
const BILLING_TEST = process.env.BILLING_TEST !== "false";

export const createSubscription = async (req, res) => {
    try {
        const session = res.locals.shopify.session;
        const client = new shopify.api.clients.Graphql({ session });

        // After the merchant approves the charge, Shopify sends them back here,
        // which re-opens the embedded app in their admin.
        const returnUrl = `https://${session.shop}/admin/apps/${process.env.SHOPIFY_API_KEY}`;

        const response = await client.query({
            data: {
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