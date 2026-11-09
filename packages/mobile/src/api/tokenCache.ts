/** A minted token and the instant it should be replaced, so the box never sees one that is about to expire. */
export interface CachedToken<T> {
  readonly value: T;
  readonly refreshAt: number;
}

export interface TokenCache<T> {
  /**
   * The cached value for `key` while it is fresh, else one mint. Concurrent callers share the mint, and `fresh` drops
   * the cached value first.
   */
  get(key: string, mint: () => Promise<CachedToken<T>>, options?: { readonly fresh?: boolean }): Promise<T>;
  /**
   * Drops a cached value and any mint in flight for it, so a mint that was already running when its token was refused
   * cannot store the token again. A token cache is keyed per task or box; invalidating one never touches another.
   */
  invalidate(key?: string): void;
}

/**
 * A per-key token cache with single-flight mints. The cache entry is only written after its mint resolves and only
 * while that mint is still the current one: invalidation, including the 401 path, cannot be undone by a late success.
 */
export const createTokenCache = <T>(): TokenCache<T> => {
  const cached = new Map<string, CachedToken<T>>();
  const mints = new Map<string, { readonly slot: object; readonly promise: Promise<T> }>();

  const invalidate = (key?: string): void => {
    if (key === undefined) {
      cached.clear();
      mints.clear();
      return;
    }
    cached.delete(key);
    mints.delete(key);
  };

  const get = (
    key: string,
    mint: () => Promise<CachedToken<T>>,
    options: { readonly fresh?: boolean } = {}
  ): Promise<T> => {
    if (options.fresh === true) invalidate(key);
    const hit = cached.get(key);
    if (hit !== undefined && Date.now() < hit.refreshAt) return Promise.resolve(hit.value);
    const pending = mints.get(key);
    if (pending !== undefined) return pending.promise;

    const slot = {};
    const promise = mint().then(
      (minted) => {
        if (mints.get(key)?.slot === slot) {
          cached.set(key, minted);
          mints.delete(key);
        }
        return minted.value;
      },
      (error: unknown) => {
        if (mints.get(key)?.slot === slot) mints.delete(key);
        throw error;
      },
    );
    mints.set(key, { slot, promise });
    return promise;
  };

  return { get, invalidate };
};
