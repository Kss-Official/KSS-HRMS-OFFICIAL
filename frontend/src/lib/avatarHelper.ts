// Centralized Avatar Resolution Helper for Kalpanaaa HRMS
// Maps all 16 employees directly to their local high-resolution portraits

export const LOCAL_AVATARS: Record<string, string> = {
  'KSS2407001': '/avatars/gaurav.jpeg',
  'KSS2407002': '/avatars/akshit.png',
  'KSS2407003': '/avatars/koushik.png',
  'KSS2407004': '/avatars/asbin.jpg',
  'KSS2407005': '/avatars/thabeethal.jpg',
  'KSS2407006': '/avatars/kuruva.jpg',
  'KSS2407007': '/avatars/ritish.jpg',
  'KSS2407008': '/avatars/pratiksha.jpg',
  'KSS2407009': '/avatars/priyanka.jpg',
  'KSS2407010': '/avatars/prahlad.jpg',
  'KSS2407012': '/avatars/satya.jpg',
  'KSS2407013': '/avatars/akash.jpg',
  'KSS2407015': '/avatars/rahul.jpg',
  'KSS2407016': '/avatars/jingyasha.jpg',
  'KSS2407017': '/avatars/shruti.jpg',
  'KSS-EMP': '/avatars/hr.jpg',
  'KSS-HR01': '/avatars/hr.jpg',
  'CEO001': '/avatars/akshit.png',
  'CTO001': '/avatars/gaurav.jpeg'
};

export const getEmployeeAvatar = (emp?: any): string => {
  if (!emp) return '/avatars/gaurav.jpeg';

  // 1. High-priority: Authoritative Cloudinary CDN URL from any field
  for (const candidate of [emp.profilePhotoUrl, emp.profile_photo_url, emp.avatar, emp.photoURL]) {
    if (candidate && typeof candidate === 'string' && candidate.includes('res.cloudinary.com')) {
      return candidate.trim();
    }
  }

  // 2. High-priority: Custom user upload (base64 data URL, blob, or remote image)
  for (const candidate of [emp.profilePhotoUrl, emp.profile_photo_url, emp.avatar, emp.photoURL]) {
    if (candidate && typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0 && !trimmed.startsWith('/avatars/') && !trimmed.startsWith('https://ui-avatars.com')) {
        return trimmed;
      }
    }
  }

  // 3. Direct explicit profile photo (including local /avatars/)
  const explicitUrl = emp.profilePhotoUrl || emp.profile_photo_url || emp.avatar || emp.photoURL;
  if (explicitUrl && typeof explicitUrl === 'string') {
    const trimmed = explicitUrl.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  const code = (emp.employeeId || emp.employee_code || emp.id || '').toUpperCase().trim();
  const name = (emp.fullName || emp.full_name || emp.name || '').toLowerCase().trim();

  // 2. Direct code lookup from official high-resolution local portraits
  if (LOCAL_AVATARS[code]) return LOCAL_AVATARS[code];

  // 3. Strict name-based resolution from official local portraits
  if (name.includes('gaurav')) return '/avatars/gaurav.jpeg';
  if (name.includes('akshit')) return '/avatars/akshit.png';
  if (name.includes('koushik')) return '/avatars/koushik.png';
  if (name.includes('asbin')) return '/avatars/asbin.jpg';
  if (name.includes('thabeethal') || name.includes('asnath')) return '/avatars/thabeethal.jpg';
  if (name.includes('mahesh') || name.includes('kuruva')) return '/avatars/kuruva.jpg';
  if (name.includes('ritish') || name.includes('devadiga')) return '/avatars/ritish.jpg';
  if (name.includes('pratiksha') || name.includes('harode')) return '/avatars/pratiksha.jpg';
  if (name.includes('priyanka') || name.includes('kushwah')) return '/avatars/priyanka.jpg';
  if (name.includes('prahlad') || name.includes('sharma')) return '/avatars/prahlad.jpg';
  if (name.includes('satya') || name.includes('ranjan')) return '/avatars/satya.jpg';
  if (name.includes('akash')) return '/avatars/akash.jpg';
  if (name.includes('rahul') || name.includes('pathak')) return '/avatars/rahul.jpg';
  if (name.includes('jigyansha') || name.includes('jingyasha') || name.includes('rout')) return '/avatars/jingyasha.jpg';
  if (name.includes('shruti') || name.includes('sahoo')) return '/avatars/shruti.jpg';
  if (name.includes('hr department') || name.includes('hr lead') || code.includes('HR')) return '/avatars/hr.jpg';

  // 4. Fallback avatar initials
  const displayName = emp.fullName || emp.full_name || 'User';
  return `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=0f172a&color=fff`;
};
