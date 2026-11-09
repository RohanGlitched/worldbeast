// Bundled into an IIFE (window.WB) that scripts/live-check.mjs injects into the deployed site,
// so the check runs the real World client on the real origin without touching the app's pages.
import { createClient } from "@base44/sdk";
import { World } from "@/net/world";
import { coreOpen, makeTitan } from "@/core/titan";
import { encodePath } from "@/net/pathcodec";

(window as unknown as { WB: unknown }).WB = { createClient, World, coreOpen, makeTitan, encodePath };
