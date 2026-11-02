import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

/**
 * Next.js 16 renamed Middleware to Proxy; the file convention is `proxy.ts`.
 *
 * This is an optimistic gate only: it redirects signed-out visitors away from
 * app routes. It is not the authorization boundary — every Convex function
 * re-checks the caller's identity and role on the server.
 */
const isProtectedRoute = createRouteMatcher([
  "/browse(.*)",
  "/tools(.*)",
  "/my-listings(.*)",
  "/my-requests(.*)",
  "/incoming(.*)",
  "/admin(.*)",
]);

export default clerkMiddleware(async (auth, request) => {
  if (isProtectedRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next internals and static files, run on everything else.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
