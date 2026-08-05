import { describe, expect, it } from "vitest";
import { mapWithConcurrency } from "../src/utils/concurrency.js";

describe("bounded concurrency", () => {
  it("limits active work and preserves input order", async () => {
    let active = 0;
    let maximumActive = 0;
    const values = Array.from({ length: 12 }, (_, index) => index);

    const results = await mapWithConcurrency(values, 3, async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, value % 2));
      active -= 1;
      return value * 2;
    });

    expect(maximumActive).toBeLessThanOrEqual(3);
    expect(results).toEqual(values.map((value) => value * 2));
  });

  it("rejects invalid concurrency", async () => {
    await expect(mapWithConcurrency([1], 0, async (value) => value)).rejects.toThrow("positive integer");
  });
});
