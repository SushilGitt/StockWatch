import { BrowserRouter, Link } from "react-router-dom";
import { useEffect, useState } from "react";
import { Page, Card, Spinner, Text, Button, Banner, Stack } from "@shopify/polaris";
import { NavMenu } from "@shopify/app-bridge-react";
import Routes from "./Routes";

import { QueryProvider, PolarisProvider } from "./components";

// Billing gate. The app requires an ACTIVE recurring subscription ($9/month),
// created via the Shopify Billing API in /api/createSubscription. On load we
// check the merchant's current subscription; if none is active we create a
// charge and redirect them (top-level, out of the embedded iframe) to Shopify's
// approval page. After they approve, Shopify returns them to the app and the
// check passes. Set BYPASS_BILLING to true to skip the gate while developing.
const BYPASS_BILLING = false;

function BillingGate({ status, onRetry }) {
  return (
    <Page narrowWidth>
      <Card sectioned>
        <Stack vertical spacing="loose" alignment="center">
          {status === "error" ? (
            <>
              <Banner status="critical" title="Couldn't start checkout">
                We couldn't start your subscription. Please try again.
              </Banner>
              <Button primary onClick={onRetry}>
                Retry
              </Button>
            </>
          ) : (
            <>
              <Spinner accessibilityLabel="Redirecting to checkout" size="large" />
              <Text as="p" variant="bodyMd">
                Redirecting you to checkout to activate your $9/month plan…
              </Text>
            </>
          )}
        </Stack>
      </Card>
    </Page>
  );
}

export default function App() {
  // Any .tsx or .jsx files in /pages will become a route
  // See documentation for <Routes /> for more info
  const pages = import.meta.glob("./pages/**/!(*.test.[jt]sx)*.([jt]sx)", {
    eager: true,
  });

  // checking -> redirecting -> (top-level redirect) | active | error
  const [status, setStatus] = useState(BYPASS_BILLING ? "active" : "checking");

  async function runBillingGate() {
    setStatus("checking");
    try {
      const res = await fetch("/api/getPayment");
      const data = await res.json();
      const active =
        Array.isArray(data?.data) &&
        data.data.some((s) => s?.status === "ACTIVE");

      if (active) {
        setStatus("active");
        return;
      }

      // No active subscription -> create a charge and send the merchant to
      // Shopify's approval page at the top level (breaks out of the iframe).
      setStatus("redirecting");
      const subRes = await fetch("/api/createSubscription", { method: "POST" });
      const subData = await subRes.json();

      if (subData?.success && subData?.confirmationUrl) {
        window.open(subData.confirmationUrl, "_top");
      } else {
        console.error("Failed to create subscription:", subData);
        setStatus("error");
      }
    } catch (error) {
      console.error("Billing gate error:", error);
      setStatus("error");
    }
  }

  useEffect(() => {
    if (!BYPASS_BILLING) runBillingGate();
  }, []);

  return (
    <PolarisProvider>
      <BrowserRouter>
        <QueryProvider>
          {status === "active" ? (
            <>
              <NavMenu>
                <Link to="/" rel="home" />
                <Link to="/Settings">SETTINGS</Link>
              </NavMenu>

              <Routes pages={pages} />
            </>
          ) : (
            <BillingGate status={status} onRetry={runBillingGate} />
          )}
        </QueryProvider>
      </BrowserRouter>
    </PolarisProvider>
  );
}
