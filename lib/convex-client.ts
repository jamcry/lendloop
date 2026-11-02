"use client";

import { ConvexReactClient } from "convex/react";

/**
 * One client for the whole browser session.
 *
 * Constructed at module scope rather than inside a component: the client uses
 * `Math.random()` internally for request ids, and Next 16 refuses unstable values
 * created during a component render at prerender time.
 */
const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL;

export const convexClient = convexUrl ? new ConvexReactClient(convexUrl) : null;
