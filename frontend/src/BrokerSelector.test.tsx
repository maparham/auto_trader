// @vitest-environment jsdom
//
// The Admin chip on the broker selector: hosted builds show it only when
// /api/brokers reported isAdmin for this account; dev builds (no Clerk key)
// never show it — isAdmin is always true there and the chip would be noise.
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

const authMock = vi.hoisted(() => ({ CLERK_ENABLED: true }));
vi.mock("./lib/authToken", () => authMock);

import BrokerSelector from "./BrokerSelector";
import { noteIsAdmin, type BrokerAccount } from "./lib/trading";

const accounts: BrokerAccount[] = [
  { key: "capital:paper", broker: "capital", env: "paper", isRealMoney: false },
];

describe("BrokerSelector admin chip", () => {
  beforeEach(() => {
    authMock.CLERK_ENABLED = true;
    noteIsAdmin(false);
  });
  afterEach(cleanup);

  it("shows the chip when hosted and the account is admin", () => {
    noteIsAdmin(true);
    render(
      <BrokerSelector accounts={accounts} activeBroker="capital" onChange={() => {}} />,
    );
    expect(screen.getByText("Admin")).toBeTruthy();
  });

  it("hides the chip for a non-admin account", () => {
    render(
      <BrokerSelector accounts={accounts} activeBroker="capital" onChange={() => {}} />,
    );
    expect(screen.queryByText("Admin")).toBeNull();
  });

  it("hides the chip in dev builds even though dev is always admin", () => {
    authMock.CLERK_ENABLED = false;
    noteIsAdmin(true);
    render(
      <BrokerSelector accounts={accounts} activeBroker="capital" onChange={() => {}} />,
    );
    expect(screen.queryByText("Admin")).toBeNull();
  });
});
