// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import AppAuthCallbackPage from "./AppAuthCallbackPage";

afterEach(cleanup);

it("strips the ticket from the URL and never renders it", () => {
  window.history.replaceState(null, "", "/app-auth/callback?ticket=sit_secret&state=s1");
  const { container, getByText } = render(<AppAuthCallbackPage />);
  getByText(/Open the Chartkar app/);
  expect(window.location.search).toBe("");
  expect(container.textContent).not.toContain("sit_secret");
});
