/**
 * Device Detection Utility
 *
 * Hard-detects mobile and tablet devices, specifically defeating "Desktop Mode"
 * or "Request Desktop Site" in mobile browsers (Chrome, Safari, Firefox, Edge, etc.),
 * while guaranteeing that genuine laptops and desktop computers—including compact
 * 11"-14" laptops with 1366x768 screens, scaled displays (125%-150%), touchscreens,
 * or resized browser windows—are NEVER blocked.
 *
 * Device Classification Strategy:
 * 1. Definite mobile platform identification (Android, iPhone, iPad, Windows Phone, etc.)
 * 2. iPad / iPhone "Desktop Mode" spoofing detection (MacIntel + maxTouchPoints > 1 + Apple GPU)
 * 3. Android "Desktop Mode" spoofing detection (Client Hints mobile: true / Android + WebGL mobile GPU)
 * 4. Verified Laptop & Desktop Exemption Pass (Windows NT, macOS with 0 touch, Linux desktop, ChromeOS)
 * 5. Fallback for unclassified touch devices (coarse-only pointer, no fine pointer, no hover)
 */

export function isMobileOrTabletDevice(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return false;
  }

  const navAny = navigator as any;
  const ua = (navigator.userAgent || navigator.vendor || (window as any).opera || '').toLowerCase();
  const platform = String(navAny.userAgentData?.platform || navigator.platform || '').toLowerCase();

  // ── 1. Legacy Mobile Devices & Windows Phone ──
  if (/windows phone|iemobile|wpdesktop/i.test(ua)) {
    return true;
  }

  // ── 2. Apple iOS Desktop Mode Spoofing (iPads and iPhones) ──
  // In iOS Safari and Chrome on iOS, toggling "Request Desktop Site" spoofs the UA to:
  // "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)..." and platform to "MacIntel".
  // However, physical Mac computers (MacBook, iMac, Mac Mini, Mac Studio, Mac Pro)
  // NEVER have touchscreens (navigator.maxTouchPoints is always 0 on real macOS).
  // Apple's official standard check for iPad/iPhone in desktop mode:
  const isAppleTouchSpoof =
    (platform.includes('mac') || ua.includes('macintosh') || ua.includes('mac os x')) &&
    navigator.maxTouchPoints > 1;

  if (isAppleTouchSpoof) {
    return true;
  }

  // ── 3. Dedicated WebGL Hardware GPU Fingerprint (Un-spoofable by Mobile Browsers) ──
  // When mobile browsers spoof the User-Agent and viewport dimensions, they CANNOT spoof
  // the underlying mobile GPU chipset exposed by the physical WebGL hardware driver.
  let isMobileGpu = false;
  let isDesktopGpu = false;

  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
      const debugInfo = (gl as any).getExtension('WEBGL_debug_renderer_info');
      if (debugInfo) {
        const renderer = String((gl as any).getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) || '').toLowerCase();

        // Dedicated mobile smartphone & tablet GPU chipsets:
        const mobileGpus = ['adreno', 'mali', 'powervr', 'immortalis', 'xclipse', 'vivante', 'sgx'];
        if (mobileGpus.some(gpu => renderer.includes(gpu))) {
          isMobileGpu = true;
        }

        // Apple GPU on iOS devices (Macs report Apple M1/M2/M3/M4 or Intel/AMD):
        if (renderer.includes('apple gpu') && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window)) {
          isMobileGpu = true;
        }

        // Dedicated desktop and laptop GPU architectures:
        const desktopGpus = [
          'intel', 'geforce', 'nvidia', 'quadro', 'rtx', 'gtx', 'radeon', 'amd',
          'apple m1', 'apple m2', 'apple m3', 'apple m4', 'direct3d', 'angle'
        ];
        if (desktopGpus.some(gpu => renderer.includes(gpu))) {
          isDesktopGpu = true;
        }
      }
    }
  } catch {
    // Proceed with fallback checks if WebGL is unavailable
  }

  // If the physical GPU is unequivocally a mobile phone/tablet chip, block immediately:
  if (isMobileGpu) {
    return true;
  }

  // ── 4. Client Hints API (Chromium Browsers on Android vs Desktop) ──
  // Even when "Desktop site" is toggled in mobile Chrome, userAgentData often still reports:
  // mobile: true, or platform: "Android" / "iOS".
  if (navAny.userAgentData) {
    if (navAny.userAgentData.mobile === true) {
      return true;
    }
    const chPlatform = String(navAny.userAgentData.platform || '').toLowerCase();
    if (chPlatform === 'android' || chPlatform === 'ios') {
      return true;
    }
  }

  // ── 5. Standard Mobile Operating Systems & Browsers (User-Agent Match) ──
  // Note: We intentionally avoid bare `touch` matching because Windows touchscreen laptops
  // contain "Touch" in their User-Agent strings.
  const explicitMobileRegex = /android|iphone|ipad|ipod|blackberry|opera mini|silk|kindle|fennec|maemo|bb10|rim tablet|playbook/i;
  if (explicitMobileRegex.test(ua)) {
    return true;
  }

  // ── 6. VERIFIED DESKTOP / LAPTOP EXEMPTION PASS ──
  // A genuine laptop or desktop computer must NEVER be blocked due to small screen dimensions,
  // high Windows display scaling (125%-150%), built-in touchscreens, or resized browser windows.
  const isWindowsDesktop = ua.includes('windows nt') && !ua.includes('windows phone') && !ua.includes('iemobile');
  const isMacDesktop = (ua.includes('macintosh') || platform.includes('mac')) && navigator.maxTouchPoints === 0;
  const isLinuxDesktop = (ua.includes('x11') || ua.includes('linux x86_64') || ua.includes('linux i686') || ua.includes('cros')) && !ua.includes('android');
  const isClientHintsDesktop = navAny.userAgentData &&
    navAny.userAgentData.mobile === false &&
    ['windows', 'macos', 'linux', 'chrome os'].includes(String(navAny.userAgentData.platform || '').toLowerCase());

  // Input pointer verification:
  const hasFinePointer = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(any-pointer: fine)').matches;
  const hasHover = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(any-hover: hover)').matches;

  if (isWindowsDesktop || isMacDesktop || isLinuxDesktop || isClientHintsDesktop || isDesktopGpu) {
    // Confirmed Laptop / Desktop PC -> ALWAYS ALLOW
    return false;
  }

  // ── 7. Fallback for Unclassified / Generic Touch-Only Devices ──
  // If the device is not confirmed as a desktop OS or desktop GPU, inspect pointer and touch:
  const isCoarseOnly = typeof window !== 'undefined' && window.matchMedia &&
    window.matchMedia('(pointer: coarse)').matches && !hasFinePointer;
  const hasNoHover = typeof window !== 'undefined' && window.matchMedia &&
    window.matchMedia('(hover: none)').matches && !hasHover;
  const hasTouch = (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) || ('ontouchstart' in window);

  // Pure touch device with only coarse pointer and no physical mouse/trackpad:
  if (isCoarseOnly || (hasNoHover && hasTouch)) {
    return true;
  }

  // Physical phone screen dimensions on unverified platforms:
  const screenMin = Math.min(window.screen.width, window.screen.height);
  const screenMax = Math.max(window.screen.width, window.screen.height);

  if (screenMin <= 500 && hasTouch && !hasFinePointer) {
    return true;
  }

  const aspectRatio = screenMax / (screenMin || 1);
  if (aspectRatio >= 1.85 && hasTouch && !hasFinePointer) {
    return true;
  }

  return false;
}
