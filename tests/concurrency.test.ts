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

  it.each([new Error("Read failed."), undefined])(
    "stops scheduling after a rejection and drains started work while preserving %s",
    async (failure) => {
      const started: number[] = [];
      let releasePendingWork: (() => void) | undefined;
      const pendingWork = new Promise<void>((resolve) => {
        releasePendingWork = resolve;
      });
      let settled = false;
      let pendingWorkFinished = false;
      const result = mapWithConcurrency([0, 1, 2, 3], 2, async (value) => {
        started.push(value);
        if (value === 0) {
          throw failure;
        }
        await pendingWork;
        pendingWorkFinished = true;
        return value;
      }).then(
        () => {
          settled = true;
          return { rejected: false, reason: undefined };
        },
        (reason: unknown) => {
          settled = true;
          return { rejected: true, reason };
        }
      );

      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(started).toEqual([0, 1]);
        expect(settled).toBe(false);
      } finally {
        releasePendingWork?.();
      }

      expect(await result).toEqual({ rejected: true, reason: failure });
      expect(pendingWorkFinished).toBe(true);
      expect(started).toEqual([0, 1]);
    }
  );
});
