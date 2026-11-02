/**
 * Tells the Convex backend how to validate Clerk-issued JWTs.
 *
 * Setup:
 *   1. Clerk dashboard -> JWT Templates -> New -> "convex"
 *   2. Copy the Issuer URL
 *   3. npx convex env set CLERK_JWT_ISSUER_DOMAIN <issuer url>
 */
const authConfig = {
  providers: [
    {
      domain: process.env.CLERK_JWT_ISSUER_DOMAIN,
      applicationID: "convex",
    },
  ],
};

export default authConfig;
