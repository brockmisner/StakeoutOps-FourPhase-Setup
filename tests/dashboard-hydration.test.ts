import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterAll, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => {
  const previousDemo = process.env.NEXT_PUBLIC_DEMO_MODE;
  process.env.NEXT_PUBLIC_DEMO_MODE = "true";
  return { previousDemo };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock("@/lib/supabase/config", () => ({ hasSupabaseBrowserConfig: () => false }));
import { OperationsDashboard } from "@/components/operations-dashboard";

afterAll(() => {
  if (runtime.previousDemo === undefined) delete process.env.NEXT_PUBLIC_DEMO_MODE;
  else process.env.NEXT_PUBLIC_DEMO_MODE = runtime.previousDemo;
});

it("keeps initial dashboard markup identical across server and browser timezones", () => {
  const previous = process.env.TZ;
  try {
    const props = { initialNow: "2026-09-17T17:08:00Z", systemReady: false };
    process.env.TZ = "UTC";
    const server = renderToString(createElement(OperationsDashboard, props));
    process.env.TZ = "America/Los_Angeles";
    const client = renderToString(createElement(OperationsDashboard, props));
    expect(server).toBe(client);
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
