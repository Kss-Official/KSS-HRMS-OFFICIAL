// Centralized API Client for Kalpanaaa HRMS Python FastAPI & Neon PostgreSQL Backend

export const getBaseUrl = (): string => {
  if (typeof window !== 'undefined' && (window as any).env?.VITE_API_BASE_URL) {
    return (window as any).env.VITE_API_BASE_URL;
  }
  return import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000/api/v1';
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
}

// In-memory fast cache with 15-second TTL for idempotent GET requests
const apiCache = new Map<string, { data: any; expiresAt: number }>();
const CACHE_TTL_MS = 15 * 1000;

export function clearApiCache(endpointPrefix?: string): void {
  if (!endpointPrefix) {
    apiCache.clear();
  } else {
    for (const key of apiCache.keys()) {
      if (key.includes(endpointPrefix)) {
        apiCache.delete(key);
      }
    }
  }
}

export async function apiRequest<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const token = getAuthToken();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  const url = `${API_BASE_URL}${cleanEndpoint}`;

  // If GET request and cached within TTL, return cached value immediately
  if (method === 'GET') {
    const cached = apiCache.get(url);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.data as T;
    }
  } else {
    // Mutation: invalidate cache to prevent stale data
    clearApiCache();
  }

  try {
    const response = await fetch(url, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      removeAuthToken();
      // Safe fallback redirect if unauthenticated
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
      throw new Error(errorMessage);
    }

    if (response.status === 204) return {} as T;

    const data = await response.json();
    if (method === 'GET') {
      apiCache.set(url, { data, expiresAt: Date.now() + CACHE_TTL_MS });
    }
    return data;
  } catch (error) {
    console.warn(`API Request Error [${endpoint}]:`, error);
    throw error;
  }
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

export async function getAttendanceRecordsApi(limit = 2000): Promise<any[]> {
  return apiRequest(`/attendance/records?limit=${limit}`);
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
  threshold = 0.62,
  employeeId?: string,
  employeeCode?: string
): Promise<any> {
  const body: Record<string, any> = { face_descriptor: faceDescriptor, threshold };
  if (employeeId && employeeId.includes('-') && employeeId.length === 36) {
    body.employee_id = employeeId;
  } else if (employeeCode) {
    body.employee_code = employeeCode;
  } else if (employeeId) {
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
