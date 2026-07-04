import { describe, it, expect, beforeEach } from "vitest";
import { installMemStorage } from "./testMemStorage";
installMemStorage();

import { loadFavoriteResolutions, saveFavoriteResolutions } from "./persist";

describe("favorite resolutions persistence", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to an empty list", () => {
    expect(loadFavoriteResolutions()).toEqual([]);
  });

  it("round-trips a saved list", () => {
    saveFavoriteResolutions(["SECOND_30", "WEEK_2"]);
    expect(loadFavoriteResolutions()).toEqual(["SECOND_30", "WEEK_2"]);
  });
});
