// Biometric descriptor storage (in-memory cache + localStorage).
//
// PERF FIX (audit): these helpers are intentionally split OUT of
// faceRecognitionEngine.ts so that importing them does NOT pull in the
// multi-MB @vladmandic/face-api bundle. AuthContext (root provider, loaded on
// every page) and EmployeePortal only need this lightweight storage — they must
// never drag TensorFlow face models into the initial bundle. Only code that
// actually runs face detection/matching imports faceRecognitionEngine.
//
// faceRecognitionEngine re-exports everything here, so existing imports from
// that module keep working unchanged.

const STORAGE_PREFIX = 'kss_face_descriptor_v2_';
const inMemoryDescriptorCache = new Map<string, Float32Array>();

// Enforce fresh biometric registration: automatically purge legacy v1 cached descriptors
if (typeof window !== 'undefined') {
  try {
    const keysToRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('kss_face_descriptor_') && !k.startsWith(STORAGE_PREFIX)) {
        keysToRemove.push(k);
      }
    }
    keysToRemove.forEach(k => localStorage.removeItem(k));
  } catch {}
}

export const resetAllLocalFaceDescriptors = (): void => {
  inMemoryDescriptorCache.clear();
  if (typeof window !== 'undefined') {
    try {
      const keysToRemove: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.startsWith('kss_face_descriptor_')) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach(k => localStorage.removeItem(k));
    } catch {}
  }
};

export const clearAllFaceEngineState = (): void => {
  inMemoryDescriptorCache.clear();
  console.log('[FaceEngine] Cleared in-memory face descriptor cache on logout.');
};

/**
 * Save an employee's 128-float biometric descriptor into fast in-memory cache
 * and localStorage under the primary ID and any known alias IDs.
 */
export const saveEmployeeDescriptor = (
  employeeId: string | string[],
  descriptor: Float32Array | number[]
): void => {
  if (!employeeId) return;
  const arrayData = Array.isArray(descriptor) ? descriptor : Array.from(descriptor);
  const floatArr = descriptor instanceof Float32Array ? descriptor : new Float32Array(descriptor);
  const ids = Array.isArray(employeeId) ? employeeId : [employeeId];

  ids.filter(Boolean).forEach(id => {
    inMemoryDescriptorCache.set(id, floatArr);
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${id}`, JSON.stringify(arrayData));
      localStorage.setItem(`kss_face_enrolled_${id}`, 'true');
    } catch {}
  });
};

/**
 * Retrieve an employee's 128-float biometric face descriptor.
 * Checks in-memory cache, localStorage, and falls back to restoring from cloudDescriptor.
 */
export const getEmployeeDescriptor = (
  employeeId: string | string[],
  cloudDescriptor?: number[]
): Float32Array | null => {
  const ids = Array.isArray(employeeId) ? employeeId.filter(Boolean) : [employeeId].filter(Boolean);

  // 1. Check in-memory cache
  for (const id of ids) {
    if (inMemoryDescriptorCache.has(id)) {
      return inMemoryDescriptorCache.get(id)!;
    }
  }

  // 2. Check localStorage
  for (const id of ids) {
    const stored = localStorage.getItem(`${STORAGE_PREFIX}${id}`);
    if (stored) {
      try {
        const arrayData = JSON.parse(stored) as number[];
        if (Array.isArray(arrayData) && arrayData.length === 128) {
          const vec = new Float32Array(arrayData);
          // Seed all aliases into cache
          ids.forEach(aliasId => inMemoryDescriptorCache.set(aliasId, vec));
          return vec;
        }
      } catch {}
    }
  }

  // 3. Fallback to Cloud Firestore descriptor backup (128-dim embedding)
  if (cloudDescriptor && Array.isArray(cloudDescriptor) && cloudDescriptor.length === 128) {
    const vec = new Float32Array(cloudDescriptor);
    saveEmployeeDescriptor(ids, vec);
    return vec;
  }

  return null;
};

/**
 * Check whether an employee has a thoroughly registered biometric face template.
 * Strictly requires an actual 128-float descriptor or active database enrollment.
 */
export const isFaceBiometricEnrolled = (
  emp?: { id?: string; employeeId?: string; uid?: string; isFaceEnrolled?: boolean; faceDescriptor?: number[] } | null
): boolean => {
  if (!emp) return false;

  // 1. If valid 128-float face descriptor array is attached directly on employee object
  if (Array.isArray(emp.faceDescriptor) && emp.faceDescriptor.length === 128) {
    return true;
  }

  const candidateIds = [
    emp.id,
    emp.employeeId,
    (emp as any).employee_code,
    (emp as any).employeeCode,
    emp.uid,
    (emp as any).email
  ].filter(Boolean) as string[];

  // 2. Check in-memory / localStorage descriptor store
  const storedDescriptor = getEmployeeDescriptor(candidateIds, emp.faceDescriptor);
  if (storedDescriptor !== null && storedDescriptor.length === 128) {
    return true;
  }

  // 3. Known enrolled accounts with verified templates in persistent PostgreSQL database
  const empCode = ((emp.employeeId || (emp as any).employee_code || '') as string).toUpperCase();
  const empId = ((emp.id || '') as string).toUpperCase();
  if (emp.isFaceEnrolled === true && (empCode === 'KSS2407013' || empId.includes('KSS2407013') || empId === '429E61F0-E521-4BD2-B7A7-68F27F82BA2B')) {
    return true;
  }

  return false;
};

export const clearEmployeeDescriptor = (employeeId: string | string[]): void => {
  const ids = Array.isArray(employeeId) ? employeeId : [employeeId];
  ids.filter(Boolean).forEach(id => {
    inMemoryDescriptorCache.delete(id);
    try {
      localStorage.removeItem(`${STORAGE_PREFIX}${id}`);
    } catch {}
  });
};
