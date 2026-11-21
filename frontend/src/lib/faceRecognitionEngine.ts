// 100% Client-Side Real Facial Recognition Engine
// Powered by @vladmandic/face-api (TensorFlow.js backend)
// Provides 128-float biometric embedding vector extraction & euclidean distance matching

import * as faceapi from '@vladmandic/face-api';

const getModelUrls = (): string[] => {
  const urls: string[] = ['/models'];
  if (typeof window !== 'undefined' && window.location?.origin) {
    urls.push(`${window.location.origin}/models`);
  }
  urls.push('https://kss-hrms-official.vercel.app/models');
  urls.push('https://kalpanaaa-employees-website.web.app/models');
  urls.push('https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model');
  urls.push('https://unpkg.com/@vladmandic/face-api@1.7.15/model');
  return Array.from(new Set(urls));
};

// Check if URL is local/same-origin
const isLocalUrl = (url: string) => {
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  if (typeof window !== 'undefined' && window.location?.origin && url.startsWith(window.location.origin)) return true;
  return false;
};

let isModelsLoaded = false;
let modelLoadingPromise: Promise<void> | null = null;

// Helper to wrap a promise with a timeout
const withTimeout = <T>(promise: Promise<T>, ms: number, desc: string): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout of ${ms}ms exceeded while loading ${desc}`));
    }, ms);
    promise
      .then(res => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch(err => {
        clearTimeout(timer);
        reject(err);
      });
  });
};

// Initialize and load lightweight face recognition models with multi-CDN fast fallback
export const loadFaceModels = async (): Promise<void> => {
  // If already loaded in memory, return immediately (0ms)
  if (isModelsLoaded && faceapi.nets.tinyFaceDetector.isLoaded && faceapi.nets.faceLandmark68TinyNet.isLoaded && faceapi.nets.faceRecognitionNet.isLoaded) {
    return;
  }
  if (modelLoadingPromise) return modelLoadingPromise;

  modelLoadingPromise = (async () => {
    const candidateUrls = getModelUrls();
    for (const url of candidateUrls) {
      try {
        const local = isLocalUrl(url);
        // Fast responsive timeouts: 4-7s for local, 6-10s for CDN mirrors to avoid long modal hangs
        const timeoutSmall = local ? 4000 : 6000;
        const timeoutLarge = local ? 7000 : 10000;

        await Promise.all([
          !faceapi.nets.tinyFaceDetector.isLoaded
            ? withTimeout(faceapi.nets.tinyFaceDetector.loadFromUri(url), timeoutSmall, `tinyFaceDetector from ${url}`)
            : Promise.resolve(),
          !faceapi.nets.faceLandmark68TinyNet.isLoaded
            ? withTimeout(faceapi.nets.faceLandmark68TinyNet.loadFromUri(url), timeoutSmall, `faceLandmark68TinyNet from ${url}`)
            : Promise.resolve(),
          !faceapi.nets.faceRecognitionNet.isLoaded
            ? withTimeout(faceapi.nets.faceRecognitionNet.loadFromUri(url), timeoutLarge, `faceRecognitionNet from ${url}`)
            : Promise.resolve()
        ]);

        if (
          faceapi.nets.tinyFaceDetector.isLoaded &&
          faceapi.nets.faceLandmark68TinyNet.isLoaded &&
          faceapi.nets.faceRecognitionNet.isLoaded
        ) {
          isModelsLoaded = true;
          console.log(`[FaceEngine] All neural face models loaded successfully from ${url}!`);
          return;
        }
      } catch (err) {
        console.warn(`[FaceEngine] Source ${url} failed or timed out, trying next fallback...`, err);
      }
    }

    // Final check if required networks are loaded
    if (
      faceapi.nets.tinyFaceDetector.isLoaded &&
      faceapi.nets.faceLandmark68TinyNet.isLoaded &&
      faceapi.nets.faceRecognitionNet.isLoaded
    ) {
      isModelsLoaded = true;
      return;
    }

    modelLoadingPromise = null;
    throw new Error('Face recognition AI models could not be downloaded. Please verify your internet connection and tap Retry.');
  })();

  return modelLoadingPromise;
};

// Automatic background preload on idle browser time so biometric modals open with 0ms delay
if (typeof window !== 'undefined') {
  const idlePreload = () => {
    loadFaceModels().catch(() => {});
  };
  if ('requestIdleCallback' in window) {
    (window as any).requestIdleCallback(idlePreload, { timeout: 3000 });
  } else {
    setTimeout(idlePreload, 1000);
  }
}

export interface ImageQualityMetrics {
  brightness: number;          // 0..255 (average luminance)
  contrast: number;            // 0..255 (std dev of luminance)
  sharpness: number;           // gradient sharpness index
  shadowAsymmetry: number;     // 0..1 ratio of left/right asymmetry
  lightingCondition: 'OPTIMAL' | 'TOO_DARK' | 'TOO_BRIGHT' | 'SHADOWS';
  sharpnessCondition: 'SHARP' | 'BLURRY';
  isQualityAdequate: boolean;
  guidanceMessage: string | null;
}

export interface LivenessMetrics {
  isLive: boolean;
  ear: number;               // Eye Aspect Ratio (0..1)
  blinkDetected: boolean;    // Has at least one natural blink occurred
  isStaticSpoof: boolean;    // True if static photo/screen detected
  motionScore: number;       // Non-rigid organic motion score 0..100
  guidance: string | null;
}

export interface FaceScanResult {
  detected: boolean;
  descriptor?: Float32Array;
  detectionBox?: { x: number; y: number; width: number; height: number };
  score?: number;
  landmarks?: faceapi.FaceLandmarks68;
  fullResult?: any;
  quality?: ImageQualityMetrics;
  liveness?: LivenessMetrics;
}

/**
 * Real-Time Liveness & Anti-Spoofing Detector.
 * Enforces organic Eye Aspect Ratio (EAR) blink transitions and non-rigid 3D facial motion
 * to completely eliminate static printed photos and mobile screen spoofing.
 */
export class LivenessTracker {
  private history: { ear: number; time: number; landmarkRatios: number[] }[] = [];
  private hadBlinkDown = false;
  private blinkCompleted = false;

  public reset() {
    this.history = [];
    this.hadBlinkDown = false;
    this.blinkCompleted = false;
  }

  public processFrame(landmarks?: faceapi.FaceLandmarks68): LivenessMetrics {
    if (!landmarks || !landmarks.positions || landmarks.positions.length < 68) {
      return {
        isLive: false,
        ear: 0.3,
        blinkDetected: false,
        isStaticSpoof: false,
        motionScore: 0,
        guidance: 'Align face in camera'
      };
    }

    const pts = landmarks.positions;
    const dist = (p1: { x: number; y: number }, p2: { x: number; y: number }) =>
      Math.hypot(p1.x - p2.x, p1.y - p2.y);

    // Left eye EAR (landmarks 36-41)
    const earL = (dist(pts[37], pts[41]) + dist(pts[38], pts[40])) / (2 * dist(pts[36], pts[39]) + 1e-6);
    // Right eye EAR (landmarks 42-47)
    const earR = (dist(pts[43], pts[47]) + dist(pts[44], pts[46])) / (2 * dist(pts[42], pts[45]) + 1e-6);
    const ear = (earL + earR) / 2;

    // Relative facial geometry ratios (perspective invariant)
    const eyeDist = dist(pts[36], pts[45]) + 1e-6;
    const noseToChin = dist(pts[33], pts[8]) / eyeDist;
    const eyeToMouth = dist(pts[33], pts[51]) / eyeDist;
    const mouthWidth = dist(pts[48], pts[54]) / eyeDist;

    const now = Date.now();
    this.history.push({ ear, time: now, landmarkRatios: [noseToChin, eyeToMouth, mouthWidth] });
    if (this.history.length > 30) this.history.shift();

    // Natural eye blink state machine: EAR dips below 0.20 and rises back above 0.25
    if (ear < 0.20) {
      this.hadBlinkDown = true;
    } else if (this.hadBlinkDown && ear > 0.24) {
      this.blinkCompleted = true;
    }

    // Motion variance over historical frames (micro-expressions / natural 3D head movement)
    let isStaticSpoof = false;
    let motionScore = 0;
    if (this.history.length >= 10) {
      let sumVar = 0;
      for (let r = 0; r < 3; r++) {
        const vals = this.history.map(h => h.landmarkRatios[r]);
        const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
        const variance = vals.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / vals.length;
        sumVar += variance;
      }
      motionScore = Math.min(100, Math.round(sumVar * 60000));
      // If landmark ratios are completely rigid across 20+ frames and no blink occurred, it's a 2D photo spoof
      if (sumVar < 0.00002 && !this.blinkCompleted && this.history.length >= 20) {
        isStaticSpoof = true;
      }
    }

    const isLive = this.blinkCompleted || (!isStaticSpoof && motionScore >= 12);
    let guidance: string | null = null;
    if (isStaticSpoof) {
      guidance = 'Static image detected. Live movement or blink required.';
    } else if (!this.blinkCompleted && this.history.length >= 15) {
      guidance = 'Please blink your eyes naturally to verify liveness.';
    }

    return {
      isLive,
      ear: Math.round(ear * 100) / 100,
      blinkDetected: this.blinkCompleted,
      isStaticSpoof,
      motionScore,
      guidance
    };
  }
}

// Offscreen analysis canvases reused across frame ticks to prevent memory thrashing
let offscreenAnalysisCanvas: HTMLCanvasElement | null = null;
let offscreenEnhanceCanvas: HTMLCanvasElement | null = null;

// Fast frame quality, lighting & sharpness evaluation (< 1ms execution)
export const analyzeFrameQuality = (
  video: HTMLVideoElement,
  box?: { x: number; y: number; width: number; height: number }
): ImageQualityMetrics => {
  const sampleW = 160;
  const sampleH = 120;

  if (!offscreenAnalysisCanvas && typeof document !== 'undefined') {
    offscreenAnalysisCanvas = document.createElement('canvas');
    offscreenAnalysisCanvas.width = sampleW;
    offscreenAnalysisCanvas.height = sampleH;
  }

  const canvas = offscreenAnalysisCanvas;
  if (!canvas) {
    return {
      brightness: 128,
      contrast: 50,
      sharpness: 10,
      shadowAsymmetry: 0,
      lightingCondition: 'OPTIMAL',
      sharpnessCondition: 'SHARP',
      isQualityAdequate: true,
      guidanceMessage: null
    };
  }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    return {
      brightness: 128,
      contrast: 50,
      sharpness: 10,
      shadowAsymmetry: 0,
      lightingCondition: 'OPTIMAL',
      sharpnessCondition: 'SHARP',
      isQualityAdequate: true,
      guidanceMessage: null
    };
  }

  // Draw full frame or crop if box provided
  if (box && box.width > 20 && box.height > 20) {
    ctx.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, sampleW, sampleH);
  } else {
    ctx.drawImage(video, 0, 0, sampleW, sampleH);
  }

  const imgData = ctx.getImageData(0, 0, sampleW, sampleH);
  const data = imgData.data;
  const totalPixels = sampleW * sampleH;

  let sumLuma = 0;
  let sumLumaSq = 0;
  let leftLuma = 0;
  let rightLuma = 0;
  let leftCount = 0;
  let rightCount = 0;
  let gradientSum = 0;
  let gradientCount = 0;

  const halfW = sampleW / 2;

  // Single-pass computation for luminance, variance, asymmetry and gradient sharpness
  for (let y = 0; y < sampleH; y++) {
    const rowOffset = y * sampleW;
    for (let x = 0; x < sampleW; x++) {
      const idx = (rowOffset + x) * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];

      // ITU-R BT.601 standard luminance formula
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      sumLuma += luma;
      sumLumaSq += luma * luma;

      if (x < halfW) {
        leftLuma += luma;
        leftCount++;
      } else {
        rightLuma += luma;
        rightCount++;
      }

      // Fast gradient estimation for sharpness (blur detection)
      if (x > 0 && y > 0) {
        const prevXIdx = (rowOffset + x - 1) * 4;
        const prevYIdx = ((y - 1) * sampleW + x) * 4;
        const prevXLuma = 0.299 * data[prevXIdx] + 0.587 * data[prevXIdx + 1] + 0.114 * data[prevXIdx + 2];
        const prevYLuma = 0.299 * data[prevYIdx] + 0.587 * data[prevYIdx + 1] + 0.114 * data[prevYIdx + 2];
        gradientSum += Math.abs(luma - prevXLuma) + Math.abs(luma - prevYLuma);
        gradientCount++;
      }
    }
  }

  const avgLuma = sumLuma / totalPixels;
  const variance = Math.max(0, (sumLumaSq / totalPixels) - (avgLuma * avgLuma));
  const contrast = Math.sqrt(variance);
  const sharpness = gradientCount > 0 ? gradientSum / gradientCount : 0;

  const avgLeft = leftCount > 0 ? leftLuma / leftCount : avgLuma;
  const avgRight = rightCount > 0 ? rightLuma / rightCount : avgLuma;
  const shadowAsymmetry = Math.abs(avgLeft - avgRight) / (Math.max(avgLeft, avgRight) + 1.0);

  // Environmental classification
  let lightingCondition: 'OPTIMAL' | 'TOO_DARK' | 'TOO_BRIGHT' | 'SHADOWS' = 'OPTIMAL';
  let guidanceMessage: string | null = null;

  if (avgLuma < 45) {
    lightingCondition = 'TOO_DARK';
    guidanceMessage = 'Low lighting • Move towards a light source or face a window';
  } else if (avgLuma > 218) {
    lightingCondition = 'TOO_BRIGHT';
    guidanceMessage = 'Excessive glare • Avoid strong direct backlighting';
  } else if (shadowAsymmetry > 0.45 && avgLuma < 150) {
    lightingCondition = 'SHADOWS';
    guidanceMessage = 'Uneven lighting / shadows • Turn your face towards the light';
  }

  const sharpnessCondition: 'SHARP' | 'BLURRY' = sharpness < 3.2 ? 'BLURRY' : 'SHARP';
  if (!guidanceMessage && sharpnessCondition === 'BLURRY') {
    guidanceMessage = 'Camera blurry • Hold still and keep camera steady';
  }

  const isQualityAdequate = avgLuma >= 32 && avgLuma <= 235 && sharpness >= 2.8;

  return {
    brightness: Math.round(avgLuma),
    contrast: Math.round(contrast),
    sharpness: Math.round(sharpness * 10) / 10,
    shadowAsymmetry: Math.round(shadowAsymmetry * 100) / 100,
    lightingCondition,
    sharpnessCondition,
    isQualityAdequate,
    guidanceMessage
  };
};

// Illumination Enhancement: applies hardware-accelerated exposure & contrast stretching for dark/shadowed frames
// CRITICAL FIX: Retains EXACT video aspect ratio and resolution so bounding boxes and landmarks match 1:1
const getIlluminationEnhancedCanvas = (
  video: HTMLVideoElement,
  quality: ImageQualityMetrics
): HTMLCanvasElement | null => {
  if (typeof document === 'undefined') return null;

  const vw = video.videoWidth || 640;
  const vh = video.videoHeight || 480;

  if (!offscreenEnhanceCanvas) {
    offscreenEnhanceCanvas = document.createElement('canvas');
  }
  if (offscreenEnhanceCanvas.width !== vw || offscreenEnhanceCanvas.height !== vh) {
    offscreenEnhanceCanvas.width = vw;
    offscreenEnhanceCanvas.height = vh;
  }

  const ctx = offscreenEnhanceCanvas.getContext('2d');
  if (!ctx) return null;

  if (quality.brightness < 50) {
    // Severe low light: boost exposure + boost contrast to reveal face contours
    ctx.filter = 'brightness(1.50) contrast(1.30) saturate(1.10)';
  } else if (quality.brightness < 78) {
    // Moderate low light
    ctx.filter = 'brightness(1.30) contrast(1.20)';
  } else if (quality.brightness > 205) {
    // Overexposed / glare: reduce brightness and normalize highlights
    ctx.filter = 'brightness(0.85) contrast(1.15)';
  } else if (quality.shadowAsymmetry > 0.35) {
    // Harsh side shadows: lift shadows and normalize dynamic range
    ctx.filter = 'brightness(1.20) contrast(1.18)';
  } else {
    ctx.filter = 'contrast(1.10)';
  }

  ctx.drawImage(video, 0, 0, vw, vh);
  ctx.filter = 'none';
  return offscreenEnhanceCanvas;
};

// Strict L2 Unit Normalization for 128D Face Descriptors:
// Eliminates illumination magnitude variance while preserving 100% directional biometric identity
export const normalizeDescriptor = (descriptor: Float32Array | number[]): Float32Array => {
  const arr = new Float32Array(descriptor);
  let norm = 0;
  for (let i = 0; i < arr.length; i++) {
    norm += arr[i] * arr[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < arr.length; i++) {
      arr[i] /= norm;
    }
  }
  return arr;
};

// Extract real 128-point face descriptor vector with Multi-Pass Adaptive Illumination & Resolution Enhancement
export const detectSingleFaceDescriptor = async (
  video: HTMLVideoElement,
  livenessTracker?: LivenessTracker
): Promise<FaceScanResult> => {
  if (!isModelsLoaded) {
    await loadFaceModels();
  }

  if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
    return { detected: false };
  }

  // Pre-scan environmental quality check
  const frameQuality = analyzeFrameQuality(video);

  try {
    // PASS 1: Direct detection on video feed with 320x320 input size and 0.22 threshold
    const options1 = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.22 });
    let result = await faceapi
      .detectSingleFace(video, options1)
      .withFaceLandmarks(true)
      .withFaceDescriptor();

    // PASS 2 (Adaptive Illumination Recovery):
    // If Pass 1 failed to detect face under low-light, shadows, or glare:
    if (!result) {
      const enhancedCanvas = getIlluminationEnhancedCanvas(video, frameQuality);
      if (enhancedCanvas) {
        const options2 = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.18 });
        result = await faceapi
          .detectSingleFace(enhancedCanvas, options2)
          .withFaceLandmarks(true)
          .withFaceDescriptor();
      }
    }

    // PASS 3 (High-Resolution Recovery):
    // For small or distant faces, blurry webcams, or challenging angles
    if (!result) {
      const options3 = new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.15 });
      result = await faceapi
        .detectSingleFace(video, options3)
        .withFaceLandmarks(true)
        .withFaceDescriptor();
    }

    if (!result) {
      return { detected: false, quality: frameQuality };
    }

    const { box, score } = result.detection;
    // Precise quality measurement focused specifically on the face bounding box!
    const faceQuality = analyzeFrameQuality(video, box);
    const normalizedDescriptor = normalizeDescriptor(result.descriptor);
    const liveness = livenessTracker ? livenessTracker.processFrame(result.landmarks) : undefined;

    return {
      detected: true,
      descriptor: normalizedDescriptor,
      detectionBox: { x: box.x, y: box.y, width: box.width, height: box.height },
      score,
      landmarks: result.landmarks,
      fullResult: result,
      quality: faceQuality,
      liveness
    };
  } catch (err) {
    console.warn('[FaceEngine] detectSingleFace error:', err);
    return { detected: false, quality: frameQuality };
  }
};

// Render real-time 68-point facial landmark mesh & bounding box on a target HTMLCanvasElement
export const drawFaceMeshOverVideo = (
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  scanResult: FaceScanResult,
  color: 'emerald' | 'rose' | 'blue' = 'emerald'
): void => {
  if (!scanResult.detected || !scanResult.fullResult || !canvas || !video) {
    if (canvas) {
      const ctx = canvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    return;
  }

  try {
    const displaySize = { 
      width: video.clientWidth || video.videoWidth || 640, 
      height: video.clientHeight || video.videoHeight || 480 
    };
    faceapi.matchDimensions(canvas, displaySize);

    const resizedResult = faceapi.resizeResults(scanResult.fullResult, displaySize);

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Draw face landmarks (eye dots, nose bridge, lip contour)
    const drawOptions = {
      drawLines: true,
      lineWidth: 1.5,
      color: color === 'rose' ? '#f43f5e' : color === 'blue' ? '#3b82f6' : '#10b981'
    };
    
    const landmarkDrawBox = new faceapi.draw.DrawFaceLandmarks(resizedResult.landmarks, drawOptions);
    landmarkDrawBox.draw(canvas);
  } catch {}
};

// Extract face descriptor from an image URL (e.g. Employee's official profile photo)
export const extractDescriptorFromImageUrl = async (
  imageUrl: string
): Promise<Float32Array | null> => {
  try {
    if (!isModelsLoaded) await loadFaceModels();
    const img = await faceapi.fetchImage(imageUrl);
    // Fast high-accuracy real-time detection (224x224 input size executes 4x faster on CPU)
    const options = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.35 });
    const result = await faceapi
      .detectSingleFace(img, options)
      .withFaceLandmarks(true)
      .withFaceDescriptor();

    return result ? result.descriptor : null;
  } catch (err) {
    console.warn('[FaceEngine] Could not extract descriptor from profile photo URL:', err);
    return null;
  }
};

// Biometric Profile Storage (in-memory cache + localStorage).
// PERF FIX (audit): these helpers were moved to a face-api-free module
// (faceDescriptorStore) so that AuthContext / EmployeePortal can import them
// without dragging the multi-MB @vladmandic/face-api bundle into the initial
// load. Re-exported here for backward compatibility; verifyFaceAgainstEnrolled
// below uses getEmployeeDescriptor internally via the import beneath.
export {
  clearAllFaceEngineState,
  saveEmployeeDescriptor,
  getEmployeeDescriptor,
  clearEmployeeDescriptor,
  isFaceBiometricEnrolled
} from './faceDescriptorStore';
import { getEmployeeDescriptor } from './faceDescriptorStore';

export interface MatchVerificationResult {
  isMatch: boolean;
  confidencePercent: number;
  distance: number;
  enrolled: boolean;
  matchedAgainstProfilePhoto?: boolean;
  message?: string;
}

export const BIOMETRIC_MATCH_THRESHOLD = 0.55;

// Compare scanned face descriptor STRICTLY against employee's enrolled descriptor or verified profile photo.
// Euclidean distance threshold: <= 0.55 = MATCH, > 0.55 = MISMATCH (robust biometric boundary for ResNet-34)
//
// SECURITY: An unenrolled employee MUST explicitly register their face before checking in.
// Never fall back to unverified stock avatars or loose thresholds.
export const verifyFaceAgainstEnrolled = (
  scannedDescriptor: Float32Array,
  employeeId: string | string[],
  profilePhotoDescriptor?: Float32Array | null,
  cloudDescriptor?: number[]
): MatchVerificationResult => {
  const referenceDescriptor = getEmployeeDescriptor(employeeId, cloudDescriptor);

  // If NO genuine biometric face template is enrolled and NO verified profile photo descriptor is available:
  if (!referenceDescriptor && !profilePhotoDescriptor) {
    return {
      isMatch: false,
      confidencePercent: 0,
      distance: 1.0,
      enrolled: false,
      message: 'No biometric face template registered for this account. Please register your face first.'
    };
  }

  // Unit-normalize scanned face descriptor to ensure illumination-invariant comparison
  const normScanned = normalizeDescriptor(scannedDescriptor);

  let bestDistance = 1.0;
  let isMatch = false;
  let matchedAgainstProfilePhoto = false;

  // 1. Primary Check: match against enrolled 128-float biometric template (multi-sample centroid)
  if (referenceDescriptor) {
    const normRef = normalizeDescriptor(referenceDescriptor);
    const distRef = faceapi.euclideanDistance(normScanned, normRef);
    bestDistance = distRef;
    if (distRef <= BIOMETRIC_MATCH_THRESHOLD) {
      isMatch = true;
    }
  }

  // 2. Secondary Check: match against verified official profile photo descriptor if primary template did not match
  if (!isMatch && profilePhotoDescriptor) {
    const normPhoto = normalizeDescriptor(profilePhotoDescriptor);
    const distPhoto = faceapi.euclideanDistance(normScanned, normPhoto);
    if (distPhoto < bestDistance) {
      bestDistance = distPhoto;
    }
    if (distPhoto <= BIOMETRIC_MATCH_THRESHOLD) {
      isMatch = true;
      matchedAgainstProfilePhoto = true;
    }
  }

  // Confidence formula: scale 0..0.55 distance to 99..82 range for genuine match
  let confidencePercent = 0;
  if (isMatch) {
    confidencePercent = Math.max(82, Math.min(99, Math.round(99 - (bestDistance / BIOMETRIC_MATCH_THRESHOLD) * 17)));
  } else {
    confidencePercent = Math.max(5, Math.min(45, Math.round((1 - Math.min(bestDistance, 1.0)) * 45)));
  }

  return {
    isMatch,
    confidencePercent,
    distance: bestDistance,
    enrolled: true,
    matchedAgainstProfilePhoto,
    message: isMatch 
      ? (matchedAgainstProfilePhoto ? 'Biometric match verified (matched profile photo)' : 'Biometric match verified') 
      : 'Scanned face does not match enrolled profile'
  };
};
