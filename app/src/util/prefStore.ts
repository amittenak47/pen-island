export function numberPref({ key, min, max, fallback }: {
  key: string; min: number; max: number; fallback: number;
}): { load: () => number; save: (value: number) => void } {
  const clamp = (value: number) => Number.isFinite(value)
    ? Math.min(max, Math.max(min, value)) : fallback;
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        return clamp(Number(raw));
      } catch {
        return fallback;
      }
    },
    save(value) {
      try {
        localStorage.setItem(key, String(clamp(value)));
      } catch {
        /* storage unavailable */
      }
    },
  };
}

export function boolPref({ key, fallback }: {
  key: string; fallback: boolean;
}): { load: () => boolean; save: (value: boolean) => void } {
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback;
        return fallback ? raw !== "0" : raw === "1";
      } catch {
        return fallback;
      }
    },
    save(value) {
      try {
        localStorage.setItem(key, value ? "1" : "0");
      } catch {
        /* storage unavailable */
      }
    },
  };
}

export function enumPref<T extends string>({ key, values, fallback }: {
  key: string; values: readonly T[]; fallback: T;
}): { load: () => T; save: (value: T) => void } {
  return {
    load() {
      try {
        const raw = localStorage.getItem(key);
        return values.includes(raw as T) ? raw as T : fallback;
      } catch {
        return fallback;
      }
    },
    save(value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* storage unavailable */
      }
    },
  };
}
