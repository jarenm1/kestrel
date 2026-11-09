import { expect, test } from "bun:test";
import { createTokenCache } from "./tokenCache";

const minted = (value: string, ahead = 60_000) => ({ value, refreshAt: Date.now() + ahead });

test("a late mint cannot re-cache a token that was refused while it was in flight", async () => {
  const cache = createTokenCache<string>();
  const first = Promise.withResolvers<{ value: string; refreshAt: number }>();
  const started = cache.get("box", () => first.promise);

  // The box rejects the cached token, so the caller invalidates while the mint is still running.
  cache.invalidate("box");
  first.resolve(minted("stale"));
  expect(await started).toBe("stale");

  let mints = 0;
  expect(await cache.get("box", async () => {
    mints += 1;
    return minted("fresh");
  })).toBe("fresh");
  expect(mints).toBe(1);
  // The new token is cached, so a third call does not mint.
  expect(await cache.get("box", async () => {
    mints += 1;
    return minted("unused");
  })).toBe("fresh");
  expect(mints).toBe(1);
});

test("concurrent callers share one mint per key", async () => {
  const cache = createTokenCache<string>();
  const pending = Promise.withResolvers<{ value: string; refreshAt: number }>();
  let mints = 0;
  const mint = () => {
    mints += 1;
    return pending.promise;
  };
  const a = cache.get("task", mint);
  const b = cache.get("task", mint);
  pending.resolve(minted("one"));
  expect(await Promise.all([a, b])).toEqual(["one", "one"]);
  expect(mints).toBe(1);
});

test("a fresh request drops only that key, and keys do not share a slot", async () => {
  const cache = createTokenCache<string>();
  let mints = 0;
  const mint = async (value: string) => {
    mints += 1;
    return minted(value);
  };
  expect(await cache.get("task-a", () => mint("a1"))).toBe("a1");
  expect(await cache.get("task-b", () => mint("b1"))).toBe("b1");
  // Two viewers coexist: minting for task-b did not evict task-a.
  expect(await cache.get("task-a", () => mint("a2"))).toBe("a1");

  expect(await cache.get("task-a", () => mint("a3"), { fresh: true })).toBe("a3");
  expect(await cache.get("task-b", () => mint("b2"))).toBe("b1");
  expect(mints).toBe(3);
});

test("an expired token is minted again and a failed mint is not kept", async () => {
  const cache = createTokenCache<string>();
  expect(await cache.get("box", async () => minted("expired", -1))).toBe("expired");
  expect(await cache.get("box", async () => minted("current"))).toBe("current");

  const broken = createTokenCache<string>();
  let attempts = 0;
  const mint = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("control refused the mint");
    return minted("second");
  };
  await expect(broken.get("box", mint)).rejects.toThrow("control refused the mint");
  expect(await broken.get("box", mint)).toBe("second");
});
