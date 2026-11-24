// Device Detection Unit Tests
// Verifies that mobile and tablet devices remain blocked, while small-screen
// laptops (1366x768, scaled displays, touchscreens, resized windows) are allowed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = process.env.KSS_TEST_OUT;
if (!OUT) {
  console.error('Run this suite through tests/run.mjs');
  process.exit(1);
}

const deviceDetection = await import(pathToFileURL(join(OUT, 'deviceDetection.cjs')));
const { isMobileOrTabletDevice } = deviceDetection;

function mockBrowserEnv({
  ua = '',
  platform = '',
  maxTouchPoints = 0,
  screenWidth = 1920,
  screenHeight = 1080,
  innerWidth = 1920,
  innerHeight = 1080,
  userAgentData = null,
  glRenderer = '',
  hasCoarse = false,
  hasFine = true,
  hasHover = true,
  hasNoHover = false
} = {}) {
  global.window = {
    screen: { width: screenWidth, height: screenHeight },
    innerWidth,
    innerHeight,
    matchMedia: (query) => {
      if (query.includes('pointer: coarse')) return { matches: hasCoarse };
      if (query.includes('pointer: fine') || query.includes('any-pointer: fine')) return { matches: hasFine };
      if (query.includes('hover: none')) return { matches: hasNoHover };
      if (query.includes('hover: hover') || query.includes('any-hover: hover')) return { matches: hasHover };
      if (query.includes('orientation: portrait')) return { matches: innerHeight > innerWidth };
      return { matches: false };
    },
    document: {
      createElement: (tag) => {
        if (tag === 'canvas') {
          return {
            getContext: (type) => {
              if (type.includes('webgl')) {
                return {
                  getExtension: (ext) => ext === 'WEBGL_debug_renderer_info' ? {} : null,
                  getParameter: () => glRenderer
                };
              }
              return null;
            }
          };
        }
        return {};
      }
    }
  };

  global.document = global.window.document;
  global.navigator = {
    userAgent: ua,
    vendor: '',
    platform,
    maxTouchPoints,
    userAgentData
  };
}

test('Small-screen laptop (1366x768 Windows) is ALLOWED (not blocked)', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: 'Win32',
    screenWidth: 1366,
    screenHeight: 768,
    innerWidth: 1366,
    innerHeight: 768,
    maxTouchPoints: 0,
    hasFine: true,
    hasHover: true
  });

  assert.equal(isMobileOrTabletDevice(), false);
});

test('Small-screen touchscreen laptop (1366x768 Windows with touch) is ALLOWED', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: 'Win32',
    screenWidth: 1366,
    screenHeight: 768,
    innerWidth: 1366,
    innerHeight: 768,
    maxTouchPoints: 10, // Touchscreen enabled
    hasCoarse: true,
    hasFine: true,      // Still has trackpad/mouse
    hasHover: true
  });

  assert.equal(isMobileOrTabletDevice(), false);
});

test('Windows Touch laptop with "Touch" token in User-Agent is ALLOWED', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; Touch) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform: 'Win32',
    screenWidth: 1366,
    screenHeight: 768,
    maxTouchPoints: 10,
    hasCoarse: true,
    hasFine: true,
    hasHover: true
  });

  assert.equal(isMobileOrTabletDevice(), false);
});

test('Compact laptop with 150% display scaling (effective 720px height) and touch is ALLOWED', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: 'Win32',
    screenWidth: 1280,
    screenHeight: 720,
    innerWidth: 1280,
    innerHeight: 720,
    maxTouchPoints: 10,
    hasFine: true,
    hasHover: true
  });

  assert.equal(isMobileOrTabletDevice(), false);
});

test('Laptop with window resized into vertical/portrait split is ALLOWED', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: 'Win32',
    screenWidth: 1920,
    screenHeight: 1080,
    innerWidth: 600,   // Narrow half-screen split
    innerHeight: 950,
    maxTouchPoints: 10,
    hasFine: true,
    hasHover: true
  });

  assert.equal(isMobileOrTabletDevice(), false);
});

test('MacBook Air (1280x800 macOS) is ALLOWED', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: 'MacIntel',
    screenWidth: 1280,
    screenHeight: 800,
    maxTouchPoints: 0,
    hasFine: true,
    hasHover: true
  });

  assert.equal(isMobileOrTabletDevice(), false);
});

test('Chromebook / Linux Laptop (1024x768) is ALLOWED', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    screenWidth: 1024,
    screenHeight: 768,
    maxTouchPoints: 0,
    hasFine: true,
    hasHover: true
  });

  assert.equal(isMobileOrTabletDevice(), false);
});

test('Android smartphone in standard mode is BLOCKED', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
    platform: 'Linux armv8l',
    screenWidth: 412,
    screenHeight: 915,
    maxTouchPoints: 5,
    hasCoarse: true,
    hasFine: false,
    hasHover: false,
    hasNoHover: true
  });

  assert.equal(isMobileOrTabletDevice(), true);
});

test('Android smartphone in "Desktop Site" mode is BLOCKED (defeated via Client Hints / GPU)', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    platform: 'Linux x86_64',
    userAgentData: { mobile: true, platform: 'Android' },
    glRenderer: 'ANGLE (Qualcomm, Adreno (TM) 740, OpenGL ES 3.2)',
    screenWidth: 412,
    screenHeight: 915,
    maxTouchPoints: 5,
    hasCoarse: true,
    hasFine: false,
    hasHover: false,
    hasNoHover: true
  });

  assert.equal(isMobileOrTabletDevice(), true);
});

test('iPad in "Request Desktop Website" mode is BLOCKED (MacIntel spoof defeated via touch points & GPU)', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    platform: 'MacIntel',
    maxTouchPoints: 5, // iPad spoofing MacIntel always reports touch points > 1
    glRenderer: 'Apple GPU',
    screenWidth: 820,
    screenHeight: 1180,
    hasCoarse: true,
    hasFine: false,
    hasHover: false,
    hasNoHover: true
  });

  assert.equal(isMobileOrTabletDevice(), true);
});

test('iPhone in standard mode is BLOCKED', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    platform: 'iPhone',
    screenWidth: 393,
    screenHeight: 852,
    maxTouchPoints: 5,
    hasCoarse: true,
    hasFine: false,
    hasHover: false,
    hasNoHover: true
  });

  assert.equal(isMobileOrTabletDevice(), true);
});

test('Android Tablet (e.g. Galaxy Tab) is BLOCKED', () => {
  mockBrowserEnv({
    ua: 'Mozilla/5.0 (Linux; Android 13; SM-X800) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    platform: 'Linux aarch64',
    glRenderer: 'Adreno (TM) 730',
    screenWidth: 800,
    screenHeight: 1280,
    maxTouchPoints: 10,
    hasCoarse: true,
    hasFine: false,
    hasHover: false,
    hasNoHover: true
  });

  assert.equal(isMobileOrTabletDevice(), true);
});
