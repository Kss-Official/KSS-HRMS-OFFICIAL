// Safe localStorage wrappers with in-memory fallback — corrupted values, privacy mode,
// tracking prevention, and quota errors must never crash the app.

function getStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof localStorage !== 'undefined') {
      return localStorage;
    }
  } catch {
    return null;
  }
  return null;
}

const memoryStore = new Map<string, string>();

export function safeGetJson<T>(key: string, fallback: T): T {
  const storage = getStorage();
  if (storage) {
    try {
      const raw = storage.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      const parsed = JSON.parse(raw);
      if (parsed === null || parsed === undefined) return fallback;
      return parsed as T;
    } catch {
      try { storage.removeItem(key); } catch {}
      return fallback;
    }
  }
  const memRaw = memoryStore.get(key);
  if (memRaw !== undefined && memRaw !== null) {
    try {
      const parsed = JSON.parse(memRaw);
      if (parsed !== null && parsed !== undefined) return parsed as T;
    } catch {}
  }
  return fallback;
}

export function safeSetJson(key: string, value: unknown): boolean {
  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }
  try {
    memoryStore.set(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function safeGetString(key: string): string | null {
  const storage = getStorage();
  if (storage) {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }
  return memoryStore.get(key) || null;
}

export function safeSetString(key: string, value: string): void {
  const storage = getStorage();
  if (storage) {
    try {
      storage.setItem(key, value);
      return;
    } catch {}
  }
  memoryStore.set(key, value);
}

export function safeRemoveItem(key: string): void {
  const storage = getStorage();
  if (storage) {
    try {
      storage.removeItem(key);
    } catch {}
  }
  memoryStore.delete(key);
}
