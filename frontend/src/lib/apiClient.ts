// Centralized API Client for Kalpanaaa HRMS Python FastAPI & Neon PostgreSQL Backend

export const getBaseUrl = (): string => {
  if (typeof window !== 'undefined' && (window as any).env?.VITE_API_BASE_URL) {
    return (window as any).env.VITE_API_BASE_URL;
  }
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }
  if (typeof window !== 'undefined') {
    // Use same-origin proxy to eliminate CORS OPTIONS preflight round-trips
    return '/api/v1';
  }
  return 'http://127.0.0.1:8000/api/v1';
};

export const API_BASE_URL = getBaseUrl();

export function getAuthToken(): string | null {
  return localStorage.getItem('kalpanaaa_jwt_token');
}

export function setAuthToken(token: string): void {
  localStorage.setItem('kalpanaaa_jwt_token', token);
}

export function removeAuthToken(): void {
  localStorage.removeItem('kalpanaaa_jwt_token');
  try { clearApiCache(); } catch {}
}

// High-speed multi-tier cache and in-flight deduplication for instantaneous (0ms) data loading
const apiCache = new Map<string, { data: any; expiresAt: number }>();
const inFlightRequests = new Map<string, Promise<any>>();
const CACHE_TTL_MS = 180 * 1000; // 3 minutes TTL for ultra-fast instant page refresh

const getSessionCachedData = (key: string): any | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = sessionStorage.getItem(`kss_api_cache_${key}`) || localStorage.getItem(`kss_api_cache_${key}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.expiresAt === 'number' && parsed.expiresAt > Date.now()) {
        if (Array.isArray(parsed.data) && parsed.data.length === 0) return null;
        return parsed.data;
      }
    }
  } catch {}
  return null;
};

const setSessionCachedData = (key: string, data: any, ttlMs: number) => {
  if (typeof window === 'undefined') return;
  try {
    const payload = JSON.stringify({
      data,
      expiresAt: Date.now() + ttlMs
    });
    sessionStorage.setItem(`kss_api_cache_${key}`, payload);
    localStorage.setItem(`kss_api_cache_${key}`, payload);
  } catch {}
};

export function clearApiCache(endpointPrefix?: string): void {
  if (!endpointPrefix) {
    apiCache.clear();
    inFlightRequests.clear();
    if (typeof window !== 'undefined') {
      try {
        const removeSessionKeys: string[] = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith('kss_api_cache_')) removeSessionKeys.push(k);
        }
        removeSessionKeys.forEach(k => sessionStorage.removeItem(k));

        const removeLocalKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('kss_api_cache_')) removeLocalKeys.push(k);
        }
        removeLocalKeys.forEach(k => localStorage.removeItem(k));
      } catch {}
    }
  } else {
    for (const key of apiCache.keys()) {
      if (key.includes(endpointPrefix)) {
        apiCache.delete(key);
      }
    }
    for (const key of inFlightRequests.keys()) {
      if (key.includes(endpointPrefix)) {
        inFlightRequests.delete(key);
      }
    }
    if (typeof window !== 'undefined') {
      try {
        const removeSessionKeys: string[] = [];
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          if (k && k.startsWith('kss_api_cache_') && k.includes(endpointPrefix)) {
            removeSessionKeys.push(k);
          }
        }
        removeSessionKeys.forEach(k => sessionStorage.removeItem(k));

        const removeLocalKeys: string[] = [];
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          if (k && k.startsWith('kss_api_cache_') && k.includes(endpointPrefix)) {
            removeLocalKeys.push(k);
          }
        }
        removeLocalKeys.forEach(k => localStorage.removeItem(k));
      } catch {}
    }
  }
}

// Cached API responses (employees, attendance, leaves...) are keyed by URL only. If a different user logs in
// on the same browser they must never be served the previous user's cached data, so the cache is tagged with
// the owner (JWT subject) and wiped whenever the owner changes.
const CACHE_OWNER_KEY = 'kss_cache_owner';
function tokenSubject(token: string | null): string {
  if (!token) return 'anon';
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return String(payload.sub || 'anon');
  } catch {
    return 'anon';
  }
}
function ensureCacheBelongsToCurrentUser(token: string | null): void {
  if (typeof window === 'undefined') return;
  const owner = tokenSubject(token);
  let previous: string | null = null;
  try { previous = localStorage.getItem(CACHE_OWNER_KEY); } catch {}
  if (previous !== owner) {
    clearApiCache();
    try { localStorage.setItem(CACHE_OWNER_KEY, owner); } catch {}
  }
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const token = getAuthToken();
  const forceFresh = (options.headers as any)?.['X-Bypass-Cache'] === 'true';
  ensureCacheBelongsToCurrentUser(token);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${API_BASE_URL}${cleanEndpoint}`;

  // 1. Surgical cache invalidation on mutations (never wipe unaffected caches)
  if (method !== 'GET') {
    if (cleanEndpoint.startsWith('/attendance')) {
      clearApiCache('/attendance');
    } else if (cleanEndpoint.startsWith('/leaves')) {
      clearApiCache('/leaves');
    } else if (cleanEndpoint.startsWith('/employees')) {
      clearApiCache('/employees');
    } else if (cleanEndpoint.startsWith('/settings')) {
      clearApiCache('/settings');
    } else {
      clearApiCache();
    }
  } else if (!forceFresh) {
    // 2. Return in-memory cached response if still fresh (< 180s)
    const cached = apiCache.get(url);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data as T;
    }
    // 3. Return tab session / local cache on page refresh (0ms instantaneous boot)
    const sessionCached = getSessionCachedData(url);
    if (sessionCached) {
      apiCache.set(url, { data: sessionCached, expiresAt: Date.now() + CACHE_TTL_MS });
      // Background stale-while-revalidate update
      setTimeout(() => {
        if (!inFlightRequests.has(url)) {
          apiRequest<T>(endpoint, {
            ...options,
            headers: { ...(options.headers || {}), 'X-Bypass-Cache': 'true' }
          }).catch(() => {});
        }
      }, 100);
      return sessionCached as T;
    }
    // 4. In-flight request deduplication: return the active pending promise
    if (inFlightRequests.has(url)) {
      return inFlightRequests.get(url) as Promise<T>;
    }
  }

  const fetchPromise = (async () => {
    try {
      const response = await fetch(url, {
        ...options,
        headers,
      });

      // Only treat 401 as "session expired" when we actually sent a token. An anonymous request that
      // is rejected (e.g. on a public page) must not redirect the visitor or wipe state.
      if (response.status === 401 && token) {
        removeAuthToken();
        clearApiCache();
        if (typeof window !== 'undefined' && window.location.pathname !== '/') {
          window.location.href = '/';
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        let errorMessage = `HTTP Error ${response.status}: ${response.statusText}`;
        try {
          const errJson = JSON.parse(errorText);
          if (errJson.detail) {
            errorMessage = typeof errJson.detail === 'string' ? errJson.detail : JSON.stringify(errJson.detail);
          } else if (errJson.message) {
            errorMessage = errJson.message;
          }
        } catch (e) {
          if (errorText) errorMessage = errorText;
        }
        const err: any = new Error(errorMessage);
        err.status = response.status;
        err.statusCode = response.status;
        throw err;
      }

      if (response.status === 204) return {} as T;

      const data = await response.json();
      if (method === 'GET') {
        apiCache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
        setSessionCachedData(url, data, CACHE_TTL_MS);
      }
      return data as T;
    } finally {
      if (method === 'GET') {
        inFlightRequests.delete(url);
      }
    }
  })();

  if (method === 'GET') {
    inFlightRequests.set(url, fetchPromise);
  }

  return fetchPromise;
}

// ── Specific FastAPI Backend Helpers ─────────────────────────────────────

export interface ApiLoginResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  employee_id: string;
  employee_code: string;
  email: string;
  full_name: string;
  role: string;
  executive_tier?: string;
}

export async function loginApi(email: string, pass: string): Promise<ApiLoginResponse> {
  const cleanEndpoint = '/auth/login';
  const url = `${API_BASE_URL}${cleanEndpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: email.trim(), password: pass.trim() })
  });

  if (!res.ok) {
    const errorText = await res.text();
    let msg = 'Invalid credentials';
    try {
      const j = JSON.parse(errorText);
      msg = j.detail || j.message || msg;
    } catch {}
    throw new Error(msg);
  }

  const data: ApiLoginResponse = await res.json();
  setAuthToken(data.access_token);
  return data;
}

export async function getCurrentProfileApi(): Promise<any> {
  return apiRequest('/auth/me');
}

export async function getEmployeesApi(limit = 200): Promise<any[]> {
  return apiRequest(`/employees/?limit=${limit}`);
}

export async function getAttendanceRecordsApi(limit = 2000, forceFresh = false): Promise<any[]> {
  return apiRequest(`/attendance/records?limit=${limit}`, forceFresh ? { headers: { 'X-Bypass-Cache': 'true' } } : {});
}

export async function checkInApi(params: {
  employee_code?: string;
  latitude?: number;
  longitude?: number;
  is_wfh?: boolean;
  face_descriptor?: number[];
}): Promise<any> {
  return apiRequest('/attendance/check-in', {
    method: 'POST',
    body: JSON.stringify(params)
  });
}

export async function checkOutApi(params: {
  latitude?: number;
  longitude?: number;
  notes?: string;
}): Promise<any> {
  return apiRequest('/attendance/check-out', {
    method: 'POST',
    body: JSON.stringify(params)
  });
}

export async function breakActionApi(breakType: string): Promise<any> {
  try {
    return await apiRequest('/attendance/breaks/start', {
      method: 'POST',
      body: JSON.stringify({ break_type: breakType })
    });
  } catch {
    return await apiRequest('/attendance/break', {
      method: 'POST',
      body: JSON.stringify({ break_type: breakType })
    });
  }
}

export async function endBreakApi(): Promise<any> {
  return apiRequest('/attendance/breaks/end', {
    method: 'POST'
  });
}

export async function createEmployeeApi(payload: any): Promise<any> {
  return apiRequest('/employees/', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function updateEmployeeApi(id: string, payload: any): Promise<any> {
  return apiRequest(`/employees/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload)
  });
}

export async function deleteEmployeeApi(id: string): Promise<any> {
  return apiRequest(`/employees/${id}`, {
    method: 'DELETE'
  });
}

export async function uploadPhotoApi(employeeId: string, photoData: string): Promise<any> {
  return apiRequest(`/employees/${employeeId}/photo`, {
    method: 'POST',
    body: JSON.stringify({ photo_data: photoData })
  });
}

export async function enrollFaceApi(employeeId: string, faceDescriptor: number[]): Promise<any> {
  return apiRequest(`/employees/${employeeId}/enroll-face`, {
    method: 'POST',
    body: JSON.stringify({ face_descriptor: faceDescriptor })
  });
}

export async function getLeavesApi(limit = 500): Promise<any[]> {
  return apiRequest(`/leaves/?limit=${limit}`);
}

export async function applyLeaveApi(payload: {
  type: string;
  start_date: string;
  end_date: string;
  reason: string;
  request_code?: string;
}): Promise<any> {
  return apiRequest('/leaves/', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function reviewLeaveApi(
  leaveId: string, 
  action: 'APPROVED' | 'REJECTED', 
  notes?: string
): Promise<any> {
  return apiRequest(`/leaves/${leaveId}/review`, {
    method: 'PATCH',
    body: JSON.stringify({ action, notes })
  });
}

export async function cancelLeaveApi(leaveId: string): Promise<any> {
  return apiRequest(`/leaves/${leaveId}/cancel`, {
    method: 'PATCH'
  });
}

export async function getSettingsApi(): Promise<any> {
  return apiRequest('/settings/');
}

export async function updateSettingsApi(payload: any): Promise<any> {
  return apiRequest('/settings/', {
    method: 'PUT',
    body: JSON.stringify(payload)
  });
}

export async function getAuditLogsApi(limit = 500): Promise<any[]> {
  return apiRequest(`/audit/?limit=${limit}`);
}

export async function createAuditLogApi(payload: {
  action: string;
  target?: string;
  details?: string;
  entity_type?: string;
  entity_id?: string;
}): Promise<any> {
  return apiRequest('/audit/', {
    method: 'POST',
    body: JSON.stringify(payload)
  });
}

export async function verifyFaceApi(
  faceDescriptor: number[], 
  threshold = 0.48,
  employeeId?: string,
  employeeCode?: string
): Promise<any> {
  const body: Record<string, any> = { face_descriptor: faceDescriptor, threshold };
  if (employeeId && employeeId.includes('-') && employeeId.length === 36) {
    body.employee_id = employeeId;
  }
  if (employeeCode) {
    body.employee_code = employeeCode;
  } else if (employeeId && !(employeeId.includes('-') && employeeId.length === 36)) {
    body.employee_code = employeeId;
  }

  try {
    return await apiRequest('/attendance/verify-face', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  } catch {
    return await apiRequest('/employees/verify-face', {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }
}

export async function resetAllFacesApi(): Promise<any> {
  return apiRequest('/employees/reset-all-faces', {
    method: 'POST'
  });
}

export async function resetEmployeeFaceApi(employeeId: string): Promise<any> {
  return apiRequest(`/employees/${employeeId}/reset-face`, {
    method: 'POST'
  });
}
