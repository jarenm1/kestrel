const UNITS: Readonly<Record<string, number>> = { "": 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 }

/**
 * Bytes in a systemd-style size: plain bytes or a K, M, G or T suffix (base 1024), e.g. "4G". Null for anything
 * else, such as "infinity" or a percentage.
 */
export const parseSize = (value: string): number | null => {
  const match = /^(\d+(?:\.\d+)?)([KMGT]?)$/i.exec(value.trim())
  if (!match) return null
  return Math.round(Number(match[1]) * UNITS[match[2]!.toUpperCase()]!)
}

/** Cores in a systemd CPUQuota such as "200%"; null for anything else. */
export const parseCpuQuota = (value: string): number | null => {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(value.trim())
  return match ? Number(match[1]) / 100 : null
}
