// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { installMemStorage } from "./lib/testMemStorage";

installMemStorage();

vi.mock("./App", () => ({ default: () => <div data-testid="desktop" /> }));
vi.mock("./mobile/MobileApp", () => ({
  default: ({ banner }: { banner?: React.ReactNode }) => (
    <div data-testid="mobile">{banner}</div>
  ),
}));
vi.mock("./lib/demoSnapshot", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchDemoSnapshot: vi.fn().mockResolvedValue(null),
}));

import DemoApp from "./DemoApp";

describe("DemoApp boot", () => {
  afterEach(cleanup);

  it("mounts the desktop app by default", async () => {
    render(<DemoApp />);
    await screen.findByTestId("desktop");
    expect(screen.queryByTestId("mobile")).toBeNull();
  });

  it("mounts the mobile shell on a phone, with the preview bar inside it", async () => {
    render(<DemoApp mobile preview />);
    const shell = await screen.findByTestId("mobile");
    expect(screen.queryByTestId("desktop")).toBeNull();
    expect(shell.querySelector(".demo-preview-bar")).not.toBeNull();
  });
});
