// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { IntegrationDialog } from "@/components/operations-dashboard";

afterEach(cleanup);

const phones = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    clientId: null,
    name: "Field phone 01",
    status: 1,
    enabled: true,
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    clientId: "00000000-0000-4000-8000-000000000201",
    name: "Field phone 02",
    status: 2,
    enabled: true,
  },
];

const clients = [
  { id: "00000000-0000-4000-8000-000000000201", name: "Example Client" },
];

function renderDialog(overrides: Record<string, unknown> = {}) {
  const onAssignPhone = vi.fn();
  render(createElement(IntegrationDialog, {
    demoMode: false,
    integration: { connected: true },
    loading: false,
    error: "",
    apiKey: "",
    showKey: false,
    syncSummary: null,
    phones,
    clients,
    phoneAssignmentSavingIds: new Set<string>(),
    onApiKeyChange: () => undefined,
    onToggleKey: () => undefined,
    onConnect: () => undefined,
    onSync: () => undefined,
    onAssignPhone,
    onDisconnect: () => undefined,
    onClose: () => undefined,
    ...overrides,
  }));
  return { onAssignPhone };
}

describe("DuoPlus phone assignment UI", () => {
  it("shows synced phones and assigns one to an active client", () => {
    const { onAssignPhone } = renderDialog();

    expect(screen.getByText("Device ownership")).toBeTruthy();
    expect(screen.getByText("2 synced")).toBeTruthy();
    expect(screen.getByLabelText("Client assignment for Field phone 02")).toHaveProperty(
      "value",
      clients[0].id,
    );

    fireEvent.change(screen.getByLabelText("Client assignment for Field phone 01"), {
      target: { value: clients[0].id },
    });
    expect(onAssignPhone).toHaveBeenCalledWith(phones[0].id, clients[0].id);
  });

  it("supports unassignment and disables only the phone being saved", () => {
    const { onAssignPhone } = renderDialog({
      phoneAssignmentSavingIds: new Set([phones[1].id]),
    });

    expect((screen.getByLabelText("Client assignment for Field phone 01") as HTMLSelectElement).disabled).toBe(false);
    expect((screen.getByLabelText("Client assignment for Field phone 02") as HTMLSelectElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("Client assignment for Field phone 01"), {
      target: { value: "" },
    });
    expect(onAssignPhone).toHaveBeenCalledWith(phones[0].id, null);
  });

  it("uses the tenant-scoped route and waits for confirmed server state", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/components/operations-dashboard.tsx"),
      "utf8",
    );

    expect(source).toContain("`/api/inventory/phones/${phoneId}`");
    expect(source).toContain("body: JSON.stringify({ clientId })");
    expect(source).toContain("phone.id === phoneId ? { ...phone, ...data.phone } : phone");
    expect(source).toContain("if (blockDemoMutation()) return;");
  });
});
