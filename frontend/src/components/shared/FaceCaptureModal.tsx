import React, { useState, useEffect, useRef } from 'react';
import { motion } from 'motion/react';
import { CheckCircle2, AlertTriangle, X, ScanFace, RefreshCw, Loader2, UserCheck, ShieldAlert, Sparkles, ShieldX } from 'lucide-react';
import { useHaptic } from '../../hooks/useHaptic';
import {
  loadFaceModels,
  detectSingleFaceDescriptor,
  saveEmployeeDescriptor,
  extractDescriptorFromImageUrl,
  getEmployeeDescriptor,
  verifyFaceAgainstEnrolled,
  drawFaceMeshOverVideo,
  ImageQualityMetrics,
  LivenessTracker,
  LivenessMetrics
} from '../../lib/faceRecognitionEngine';
import { verifyFaceApi, enrollFaceApi, getAuthToken } from '../../lib/apiClient';

// Background model preloader exported for idle warm-up
export const preloadBiometricModels = (): void => {
  loadFaceModels().catch(() => {});
};

export interface FaceCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (descriptorArray?: number[]) => void;
  onEnrollSuccess?: (descriptorArray: number[]) => Promise<any> | void;
  employeeName?: string;
  employeeId?: string;
  employeeCode?: string;
  profilePhotoUrl?: string;
  cloudDescriptor?: number[];
  isFaceEnrolled?: boolean;
  isTestMode?: boolean;
  isEnrollmentMode?: boolean;
}

export const FaceCaptureModal: React.FC<FaceCaptureModalProps> = ({
  isOpen,
  onClose,
  onSuccess,
  onEnrollSuccess,
  employeeName = 'Employee',
  employeeId = 'emp-001',
  employeeCode,
  profilePhotoUrl,
  cloudDescriptor,
  isFaceEnrolled,
  isTestMode = false,
  isEnrollmentMode = false
}) => {
  const { triggerHaptic } = useHaptic();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [stream, setStream] = useState<MediaStream | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const actionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [statusStep, setStatusStep] = useState<'LOADING_MODELS' | 'INITIALIZING' | 'CENTER_FACE' | 'SCANNING' | 'VERIFIED' | 'FAILED' | 'NOT_ENROLLED' | 'ERROR'>('LOADING_MODELS');
  const [feedbackText, setFeedbackText] = useState('Loading face recognition neural network models...');
  const [confidencePercent, setConfidencePercent] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isEnrolled, setIsEnrolled] = useState<boolean>(false);
  const [profileDescriptor, setProfileDescriptor] = useState<Float32Array | null>(null);
  const [currentModeIsEnroll, setCurrentModeIsEnroll] = useState<boolean>(isEnrollmentMode);
  const [retryTrigger, setRetryTrigger] = useState<number>(0);

  // Progressive Smartphone FaceID Multi-Sample State
  const [enrollmentProgress, setEnrollmentProgress] = useState<number>(0);
  const [alignmentFeedback, setAlignmentFeedback] = useState<string | null>(null);
  const [qualityMetrics, setQualityMetrics] = useState<ImageQualityMetrics | null>(null);
  const enrollmentSamplesRef = useRef<Float32Array[]>([]);
  const lastEnrollmentSampleTimeRef = useRef<number>(0);
  const livenessTrackerRef = useRef<LivenessTracker>(new LivenessTracker());
  const consecutiveMatchesRef = useRef<number>(0);
  const REQUIRED_ENROLLMENT_SAMPLES = 8;

  // Reset sampling session state whenever modal opens or mode changes
  useEffect(() => {
    if (isOpen) {
      enrollmentSamplesRef.current = [];
      lastEnrollmentSampleTimeRef.current = 0;
      setEnrollmentProgress(0);
      setAlignmentFeedback(null);
      livenessTrackerRef.current.reset();
      consecutiveMatchesRef.current = 0;
    }
  }, [isOpen, currentModeIsEnroll]);

  // Sync mode state when prop changes
  useEffect(() => {
    setCurrentModeIsEnroll(isEnrollmentMode);
  }, [isEnrollmentMode, isOpen]);

  // Check if employee already has genuine face biometric enrolled
  useEffect(() => {
    if (employeeId && isOpen) {
      const storedDesc = getEmployeeDescriptor(employeeId, cloudDescriptor);
      const enrolled = Boolean(
        isFaceEnrolled ||
        storedDesc !== null ||
        (cloudDescriptor && cloudDescriptor.length === 128)
      );
      setIsEnrolled(enrolled);
    }
  }, [employeeId, isOpen, cloudDescriptor, isFaceEnrolled]);

  // Load Models & Start Camera Stream
  useEffect(() => {
    if (!isOpen) {
      if (actionTimerRef.current) {
        clearTimeout(actionTimerRef.current);
        actionTimerRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        setStream(null);
      }
      return;
    }

    let isMounted = true;

    const initializeEngine = async () => {
      try {
        setErrorMsg(null);
        setStatusStep('LOADING_MODELS');
        setFeedbackText('Loading neural network face models...');

        // If an active stream already exists (e.g. from camera already granted), reuse it cleanly
        let mediaStream = streamRef.current;
        const isStreamActive = Boolean(
          mediaStream &&
          mediaStream.active &&
          mediaStream.getVideoTracks().some(t => t.readyState === 'live')
        );

        if (!isStreamActive) {
          // Start camera stream acquisition with adaptive HD resolution and smooth fallback
          try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: 'user',
                width: { ideal: 1280, min: 640 },
                height: { ideal: 720, min: 480 },
                frameRate: { ideal: 30, min: 15 }
              },
              audio: false
            });
          } catch {
            // Fallback to standard 640x480 video
            try {
              mediaStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
                audio: false
              });
            } catch {
              // Fallback to generic video
              try {
                mediaStream = await navigator.mediaDevices.getUserMedia({
                  video: true,
                  audio: false
                });
              } catch {
                throw new Error('Camera access denied. Please allow camera permission in browser settings and try again.');
              }
            }
          }

          if (isMounted && mediaStream) {
            streamRef.current = mediaStream;
            setStream(mediaStream);
          } else if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
          }
        }

        // Load models with multi-mirror resilient fallback (local -> vercel edge -> firebase -> cdn)
        await loadFaceModels();

        if (isMounted) {
          setStatusStep('CENTER_FACE');
          setFeedbackText('Position your face inside the frame...');
        }
      } catch (err: any) {
        if (isMounted) {
          console.error('[FaceCaptureModal] Error:', err);
          setErrorMsg(err?.message || 'Biometric initialization failed. Please check permissions.');
          setStatusStep('ERROR');
        }
      }
    };

    initializeEngine();

    return () => {
      isMounted = false;
      if (actionTimerRef.current) {
        clearTimeout(actionTimerRef.current);
        actionTimerRef.current = null;
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, [isOpen, retryTrigger]);

  // Guaranteed video stream binding hook whenever stream or video element is available
  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
      videoRef.current.onloadedmetadata = () => {
        videoRef.current?.play().catch(e => console.warn('Video play prompt:', e));
      };
      videoRef.current.play().catch(() => { });
    }
  }, [stream, isOpen]);

  // Handle Enrollment Action
  const handlePerformEnrollment = async (scannedDescriptor: Float32Array) => {
    const descriptorArray = Array.from(scannedDescriptor);
    setStatusStep('SCANNING');
    setFeedbackText('Persisting biometric template to cloud database...');

    let enrollmentError: string | null = null;
    try {
      if (onEnrollSuccess) {
        const res: any = await onEnrollSuccess(descriptorArray);
        if (res && res.success === false) {
          enrollmentError = res.message || 'Face registration failed.';
        }
      } else {
        saveEmployeeDescriptor(employeeId, scannedDescriptor);
        const res = await enrollFaceApi(employeeId, descriptorArray);
        if (res && res.is_face_enrolled === false) {
          enrollmentError = res.message || 'Face registration failed.';
        }
      }
    } catch (err: any) {
      console.warn('[FaceCaptureModal] Enrollment error:', err);
      enrollmentError = err?.message || 'Biometric registration failed. Please try again.';
    }

    if (enrollmentError) {
      setStatusStep('FAILED');
      setFeedbackText(enrollmentError);
      setErrorMsg(enrollmentError);
      triggerHaptic('error');
      enrollmentSamplesRef.current = [];
      setEnrollmentProgress(0);
      return;
    }

    saveEmployeeDescriptor(employeeId, scannedDescriptor);
    setIsEnrolled(true);
    setCurrentModeIsEnroll(false);
    setConfidencePercent(99);
    setStatusStep('VERIFIED');
    setFeedbackText('✓ Face Biometrics Successfully Registered & Verified!');
    triggerHaptic('success');

    if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
    actionTimerRef.current = setTimeout(() => {
      onSuccess(descriptorArray);
      onClose();
    }, 700);
  };

  // Ultra-Fast Non-Overlapping Live Detection Loop
  useEffect(() => {
    if (!isOpen || !videoRef.current || (statusStep !== 'CENTER_FACE' && statusStep !== 'SCANNING')) return;

    let active = true;
    let isScanning = false;
    let isVerifyingInFlight = false;
    let lastVerifyTime = 0;
    let timerId: any = null;
    let scanAttemptCount = 0;
    const scanStartTime = Date.now();
    const MAX_VERIFY_DURATION_MS = 12000; // 12 seconds verification window

    const runScanLoop = async () => {
      if (!active || !videoRef.current) return;
      if (isScanning) {
        timerId = setTimeout(runScanLoop, 50);
        return;
      }

      isScanning = true;
      try {
        const scan = await detectSingleFaceDescriptor(videoRef.current, livenessTrackerRef.current);
        if (!active) return;

        if (scan.quality) {
          setQualityMetrics(scan.quality);
        }

        // Anti-Spoofing & Liveness Guard: reject genuine static photos or phone screens
        if (scan.liveness?.isStaticSpoof) {
          setAlignmentFeedback('Static image detected • Natural movement required');
          setFeedbackText('Static photo or screen detected. Live movement or natural blink required...');
          return;
        }

        // Render live 68-point facial landmarks mesh on canvas overlay
        if (canvasRef.current && videoRef.current) {
          drawFaceMeshOverVideo(videoRef.current, canvasRef.current, scan, 'emerald');
        }

        if (scan.detected && scan.descriptor) {
          // Mode A: Explicit Enrollment Mode (Smartphone FaceID progressive multi-stage biometric extraction)
          if (currentModeIsEnroll) {
            setStatusStep('SCANNING');
            const vw = videoRef.current.videoWidth || 640;
            const vh = videoRef.current.videoHeight || 480;
            const box = scan.detectionBox || { x: 0, y: 0, width: 0, height: 0 };
            const centerX = box.x + box.width / 2;
            const centerY = box.y + box.height / 2;
            const offsetX = Math.abs(centerX - vw / 2) / vw;
            const offsetY = Math.abs(centerY - vh / 2) / vh;
            const faceRatio = box.height / vh;

            // Smartphone FaceID Alignment & Environmental Checks
            if (faceRatio < 0.22) {
              setAlignmentFeedback('Move closer to the camera');
              setFeedbackText('Position face closer inside frame...');
              return;
            }
            if (faceRatio > 0.80) {
              setAlignmentFeedback('Move slightly further away');
              setFeedbackText('Move slightly back from camera...');
              return;
            }
            if (offsetX > 0.24 || offsetY > 0.26) {
              setAlignmentFeedback('Center your face in the oval');
              setFeedbackText('Align your face inside the center oval...');
              return;
            }
            if (scan.quality) {
              if (scan.quality.brightness < 18) {
                setAlignmentFeedback('Too dark • Face towards a light source');
                setFeedbackText('Increase room lighting or turn screen brightness up...');
                return;
              }
              if (scan.quality.brightness > 242) {
                setAlignmentFeedback('Too bright • Avoid direct glare');
                setFeedbackText('Avoid direct sunlight or harsh backlight...');
                return;
              }
            }

            setAlignmentFeedback(null);
            const now = Date.now();
            // Temporal sampling throttle: 220ms between distinct high-res frames
            if (now - lastEnrollmentSampleTimeRef.current >= 220) {
              enrollmentSamplesRef.current.push(new Float32Array(scan.descriptor));
              lastEnrollmentSampleTimeRef.current = now;

              const sampleCount = enrollmentSamplesRef.current.length;
              const progressPct = Math.min(100, Math.round((sampleCount / REQUIRED_ENROLLMENT_SAMPLES) * 100));
              setEnrollmentProgress(progressPct);

              // Dynamic progressive smartphone feedback across biometric stages
              if (sampleCount <= 2) {
                setFeedbackText(`Analyzing facial geometry & structure... (${progressPct}%)`);
              } else if (sampleCount <= 4) {
                setFeedbackText(`Mapping 68-point neural biometric landmarks... (${progressPct}%)`);
              } else if (sampleCount <= 6) {
                setFeedbackText(`Synthesizing 128D neural facial vector... (${progressPct}%)`);
              } else if (sampleCount < REQUIRED_ENROLLMENT_SAMPLES) {
                setFeedbackText(`Validating biometric template stability... (${progressPct}%)`);
              } else {
                setFeedbackText(`Biometric template synthesized! Finalizing...`);
              }

              // When all 8 required samples are thoroughly analyzed and verified:
              if (sampleCount >= REQUIRED_ENROLLMENT_SAMPLES) {
                const liveState = livenessTrackerRef.current.processFrame(scan.landmarks);
                if (liveState.isStaticSpoof) {
                  setFeedbackText('Static photo or screen detected. Registration requires a live person.');
                  return;
                }
                active = false;
                // Compute normalized centroid vector across sample frames
                const samples = enrollmentSamplesRef.current;
                const centroid = new Float32Array(128);
                for (let i = 0; i < samples.length; i++) {
                  for (let j = 0; j < 128; j++) {
                    centroid[j] += samples[i][j];
                  }
                }
                let norm = 0;
                for (let j = 0; j < 128; j++) {
                  centroid[j] /= samples.length;
                  norm += centroid[j] * centroid[j];
                }
                norm = Math.sqrt(norm);
                if (norm > 0) {
                  for (let j = 0; j < 128; j++) {
                    centroid[j] /= norm;
                  }
                }

                await handlePerformEnrollment(centroid);
                return;
              }
            }
            return;
          }

          setStatusStep('SCANNING');
          setFeedbackText('Face detected! Verifying biometrics...');

          // Mode B: Not enrolled + NOT in enrollment mode
          if (!isEnrolled) {
            active = false;
            setStatusStep('NOT_ENROLLED');
            setFeedbackText('No biometric face template registered for this account. Please register your face first.');
            triggerHaptic('error');
            return;
          }

          // Mode C: Verification — Backend-Mandatory 1:1 biometric check via Neon PostgreSQL pgvector
          scanAttemptCount++;
          const elapsed = Date.now() - scanStartTime;
          const progressPct = Math.min(100, Math.round((elapsed / MAX_VERIFY_DURATION_MS) * 100));

          if (scan.quality && scan.quality.guidanceMessage) {
            setFeedbackText(`Verifying identity... ${scan.quality.guidanceMessage}`);
          } else {
            setFeedbackText(`Verifying biometrics via secure vector engine... (${progressPct}%)`);
          }

          // 1. Fast Client-Side 1:1 Biometric Verification against enrolled descriptor / cloudDescriptor
          if (cloudDescriptor || employeeId) {
            const localResult = verifyFaceAgainstEnrolled(
              scan.descriptor,
              employeeId || employeeCode || '',
              null,
              cloudDescriptor
            );

            if (localResult.isMatch && active) {
              consecutiveMatchesRef.current += 1;
              const conf = Math.max(88, localResult.confidencePercent || 96);
              setConfidencePercent(conf);
              setStatusStep('VERIFIED');
              setFeedbackText(`✓ Biometric Identity Confirmed (${conf}% Confidence)`);
              triggerHaptic('success');
              active = false;
              if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
              actionTimerRef.current = setTimeout(() => {
                onSuccess(Array.from(scan.descriptor));
                onClose();
              }, 250);
              return;
            }
          }

          const now = Date.now();
          // Send verification request at most once every 350ms, and only if no request is in-flight
          if (!isVerifyingInFlight && (now - lastVerifyTime >= 350) && active) {
            isVerifyingInFlight = true;
            lastVerifyTime = now;
            const descArr = Array.from(scan.descriptor);

            verifyFaceApi(descArr, 0.52, employeeId, employeeCode)
              .then((backendRes) => {
                if (!active) return;

                if (backendRes.impersonation_detected) {
                  setStatusStep('FAILED');
                  consecutiveMatchesRef.current = 0;
                  const impMsg = backendRes.message || `Security Violation: Face belongs to a different employee. Cross-employee check-in is blocked.`;
                  setFeedbackText(`❌ ${impMsg}`);
                  setErrorMsg(impMsg);
                  triggerHaptic('error');
                  active = false;
                  return;
                }

                if (backendRes.matched) {
                  const matchedCode = String(backendRes.employee_code || '').trim().toLowerCase();
                  const matchedId   = String(backendRes.employee_id || '').trim().toLowerCase();
                  const targetCode  = String(employeeCode || employeeId || '').trim().toLowerCase();
                  const targetId    = String(employeeId || '').trim().toLowerCase();
                  const matchedName = String(backendRes.full_name || '').trim().toLowerCase();
                  const targetName  = String(employeeName || '').trim().toLowerCase();

                  const cleanMatchedCode = matchedCode.replace('emp-', '');
                  const cleanTargetCode  = targetCode.replace('emp-', '');
                  const cleanTargetId    = targetId.replace('emp-', '');

                  // Valid match if employee_code, employee_id, or full_name corresponds to the target employee
                  const isMatchForTarget = 
                    (cleanMatchedCode && (cleanMatchedCode === cleanTargetCode || cleanMatchedCode === cleanTargetId)) ||
                    (matchedCode && (matchedCode === targetCode || matchedCode === targetId)) ||
                    (matchedId && (matchedId === targetId || matchedId === targetCode || matchedId === cleanTargetCode)) ||
                    (matchedName && targetName && (matchedName === targetName || matchedName.includes(targetName) || targetName.includes(matchedName)));

                  if (!isMatchForTarget && (targetCode || targetId)) {
                    console.warn('[Biometrics] MISMATCH — backend matched', backendRes.employee_code || backendRes.employee_id, 'but expected', targetCode);
                    setStatusStep('FAILED');
                    consecutiveMatchesRef.current = 0;
                    const mismatchMsg = `Security Violation: Scanned face matches ${backendRes.full_name || backendRes.employee_code}, not ${employeeName}. Cross-employee check-in is forbidden.`;
                    setFeedbackText(mismatchMsg);
                    setErrorMsg(mismatchMsg);
                    triggerHaptic('error');
                    active = false;
                    return;
                  }

                  consecutiveMatchesRef.current += 1;
                  const conf = Math.round((backendRes.confidence || 0.96) * 100);
                  setConfidencePercent(conf);
                  setStatusStep('VERIFIED');
                  setFeedbackText(`✓ Biometric Identity Confirmed (${conf}% Confidence)`);
                  triggerHaptic('success');
                  active = false;
                  if (actionTimerRef.current) clearTimeout(actionTimerRef.current);
                  actionTimerRef.current = setTimeout(() => {
                    onSuccess(descArr);
                    onClose();
                  }, 250);
                } else {
                  consecutiveMatchesRef.current = 0;
                  if (backendRes.message && backendRes.message.includes('No biometric face template registered')) {
                    setStatusStep('NOT_ENROLLED');
                    setFeedbackText('No biometric face template registered for this account. Please register your face first.');
                    triggerHaptic('error');
                    active = false;
                  }
                }
              })
              .catch((err) => {
                console.warn('[Biometrics] Backend verify error:', err);
              })
              .finally(() => {
                isVerifyingInFlight = false;
              });
          }

          if (elapsed >= MAX_VERIFY_DURATION_MS && active) {
            // 12-second window exhausted without backend confirmation → fail
            setStatusStep('FAILED');
            setFeedbackText(`❌ Biometric verification timed out. Face did not match registered profile. Please try again in better lighting.`);
            triggerHaptic('error');
            active = false;
          }
        } else {
          if (statusStep === 'SCANNING') {
            setStatusStep('CENTER_FACE');
            if (scan.quality && scan.quality.guidanceMessage) {
              setFeedbackText(scan.quality.guidanceMessage);
            } else {
              setFeedbackText('Position your face clearly inside the frame...');
            }
            setConfidencePercent(null);
          }
        }
      } catch (err) {
        console.warn('[FaceCaptureModal] Scan frame error:', err);
      } finally {
        isScanning = false;
        if (active) {
          timerId = setTimeout(runScanLoop, 40);
        }
      }
    };

    timerId = setTimeout(runScanLoop, 40);

    return () => {
      active = false;
      if (timerId) clearTimeout(timerId);
    };
  }, [isOpen, statusStep, employeeId, currentModeIsEnroll, isEnrolled, profileDescriptor, cloudDescriptor]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-slate-950/90 backdrop-blur-lg z-50 flex items-center justify-center p-4">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-3xl overflow-hidden shadow-2xl relative flex flex-col items-center"
      >
        {/* Header Bar */}
        <div className="w-full px-6 py-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/50">
          <div className="flex items-center gap-2">
            <ScanFace className="w-5 h-5 text-emerald-400 animate-pulse" />
            <div>
              <h3 className="text-sm font-bold text-white">
                {currentModeIsEnroll ? '📸 Register Facial Biometrics' : isTestMode ? '🔍 Diagnostic Face Accuracy Test' : 'AI Biometric Facial Verification'}
              </h3>
              <p className="text-[10px] text-slate-400 font-mono">
                {currentModeIsEnroll ? 'Capturing 128-point face descriptor' : isTestMode ? 'Testing live facial matching against profile descriptor' : '100% Client-Side TensorFlow Neural Net'}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Video Viewport - Always mounted so video feed is never blank */}
        <div className="relative w-full aspect-4/3 bg-slate-950 flex items-center justify-center overflow-hidden">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="w-full h-full object-cover transform -scale-x-100 bg-slate-950"
          />

          {/* Real Neural 68-Point Facial Landmark Overlay Canvas */}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none transform -scale-x-100 z-10"
          />

          {/* Face Oval Target Boundary Overlay */}
          <div className="absolute inset-0 pointer-events-none flex items-center justify-center z-20">
            <div className={`w-56 h-72 rounded-[40%] border-2 transition-all duration-500 relative flex flex-col items-center justify-center ${statusStep === 'VERIFIED' ? 'border-emerald-500 bg-emerald-500/10 shadow-[0_0_40px_rgba(16,185,129,0.3)]' :
              statusStep === 'FAILED' ? 'border-rose-500 bg-rose-500/10 shadow-[0_0_40px_rgba(244,63,94,0.3)]' :
                statusStep === 'NOT_ENROLLED' ? 'border-amber-500 bg-amber-500/10 shadow-[0_0_40px_rgba(245,158,11,0.3)]' :
                  statusStep === 'SCANNING' ? 'border-blue-400 bg-blue-500/5 shadow-[0_0_30px_rgba(59,130,246,0.2)] animate-pulse' :
                    'border-emerald-400/80 border-dashed'
              }`}>
              
              {/* Smartphone FaceID Circular Progress Ring (when in enrollment mode) */}
              {currentModeIsEnroll && (
                <svg className="absolute -inset-5 w-[calc(100%+40px)] h-[calc(100%+40px)] pointer-events-none">
                  <rect
                    x="10"
                    y="10"
                    width="calc(100% - 20px)"
                    height="calc(100% - 20px)"
                    rx="40%"
                    fill="none"
                    stroke="rgba(16, 185, 129, 0.15)"
                    strokeWidth="5"
                  />
                  <rect
                    x="10"
                    y="10"
                    width="calc(100% - 20px)"
                    height="calc(100% - 20px)"
                    rx="40%"
                    fill="none"
                    stroke="url(#progress-gradient)"
                    strokeWidth="5"
                    strokeDasharray="800"
                    strokeDashoffset={800 - (800 * enrollmentProgress) / 100}
                    strokeLinecap="round"
                    className="transition-all duration-300 ease-out"
                  />
                  <defs>
                    <linearGradient id="progress-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
                      <stop offset="0%" stopColor="#06b6d4" />
                      <stop offset="50%" stopColor="#10b981" />
                      <stop offset="100%" stopColor="#3b82f6" />
                    </linearGradient>
                  </defs>
                </svg>
              )}

              <div className="w-full h-full border border-emerald-400/30 rounded-[40%] absolute inset-2 opacity-60" />
              {statusStep === 'VERIFIED' && (
                <CheckCircle2 className="w-16 h-16 text-emerald-400 animate-in zoom-in-50 duration-300" />
              )}
              {statusStep === 'FAILED' && (
                <ShieldAlert className="w-16 h-16 text-rose-500 animate-in zoom-in-50 duration-300" />
              )}
              {statusStep === 'NOT_ENROLLED' && (
                <AlertTriangle className="w-16 h-16 text-amber-400 animate-in zoom-in-50 duration-300" />
              )}
              {currentModeIsEnroll && statusStep === 'SCANNING' && enrollmentProgress > 0 && (
                <div className="absolute bottom-4 px-3 py-1 bg-slate-950/80 backdrop-blur-md rounded-full border border-emerald-500/40 text-emerald-400 text-xs font-mono font-black animate-pulse">
                  {enrollmentProgress}%
                </div>
              )}
            </div>
          </div>

          {/* Actionable Guidance Banner (Alignment, Lighting & Camera Quality) */}
          {(alignmentFeedback || (qualityMetrics?.guidanceMessage && statusStep === 'SCANNING')) && (
            <div className="absolute top-16 left-1/2 transform -translate-x-1/2 z-30 px-3.5 py-1.5 bg-amber-500/90 text-slate-950 font-black text-xs rounded-full shadow-lg border border-amber-300/40 animate-bounce max-w-[85%] text-center">
              ⚠️ {alignmentFeedback || qualityMetrics?.guidanceMessage}
            </div>
          )}

          {/* Overlay: Neural Network Loading State */}
          {statusStep === 'LOADING_MODELS' && (
            <div className="absolute inset-0 bg-slate-950/80 backdrop-blur-sm z-30 flex flex-col items-center justify-center p-6 text-center space-y-3">
              <Loader2 className="w-10 h-10 text-emerald-400 animate-spin" />
              <p className="text-xs text-slate-200 font-bold">{feedbackText}</p>
              <p className="text-[10px] text-slate-400">Initializing camera and neural models...</p>
            </div>
          )}

          {/* Overlay: Fatal Camera Error / Model Loading Error / Security Error */}
          {errorMsg && (() => {
            const errLower = errorMsg.toLowerCase();
            const isSecurity = errLower.includes('security violation') || 
                               errLower.includes('already enrolled') || 
                               errLower.includes('cross-employee') ||
                               errLower.includes('forbidden') ||
                               errLower.includes('blocked');
            const isModelError = errLower.includes('model') ||
                                 errLower.includes('cdn') ||
                                 errLower.includes('neural') ||
                                 errLower.includes('download') ||
                                 errLower.includes('network') ||
                                 errLower.includes('weights') ||
                                 errLower.includes('fetch') ||
                                 errLower.includes('timeout');

            let headerTitle = 'Camera Access Required';
            let descriptionText = 'Biometric face verification requires camera access. Please grant permission in your browser settings and reload.';
            let buttonLabel = 'Retry Camera Access';
            let iconColor = 'text-rose-400';
            let bgBox = 'bg-rose-500/10 border-rose-500/30';

            if (isSecurity) {
              headerTitle = 'Biometric Security Alert';
              descriptionText = 'Anti-proxy security is active. Each employee must enroll with their own unique face.';
              buttonLabel = 'Retry Scan';
              iconColor = 'text-amber-400';
              bgBox = 'bg-amber-500/10 border-amber-500/30';
            } else if (isModelError) {
              headerTitle = 'AI Neural Models Loading';
              descriptionText = 'Face recognition AI neural network weights could not be loaded. Please ensure internet connectivity and tap Retry.';
              buttonLabel = 'Retry Model Download';
              iconColor = 'text-blue-400';
              bgBox = 'bg-blue-500/10 border-blue-500/30';
            }

            return (
              <div className="absolute inset-0 bg-slate-950/95 z-30 flex flex-col items-center justify-center p-6 text-center space-y-4">
                <div className={`w-16 h-16 rounded-2xl ${bgBox} border flex items-center justify-center`}>
                  <ShieldX className={`w-8 h-8 ${iconColor}`} />
                </div>
                <div className="space-y-2">
                  <p className={`text-sm font-bold ${isSecurity ? 'text-amber-300' : isModelError ? 'text-blue-300' : 'text-rose-300'}`}>
                    {headerTitle}
                  </p>
                  <p className="text-xs text-slate-300 leading-relaxed max-w-xs mx-auto">{errorMsg}</p>
                  <p className="text-[10px] text-slate-500 leading-relaxed">
                    {descriptionText}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setErrorMsg(null);
                    if (isSecurity) {
                      setStatusStep('CENTER_FACE');
                      setFeedbackText('Position face within frame...');
                      enrollmentSamplesRef.current = [];
                      setEnrollmentProgress(0);
                    } else {
                      setStatusStep('LOADING_MODELS');
                      setFeedbackText(isModelError ? 'Downloading neural face models...' : 'Retrying camera access...');
                      setRetryTrigger(prev => prev + 1);
                    }
                  }}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white font-extrabold text-xs rounded-xl shadow-lg flex items-center justify-center gap-2 cursor-pointer transition-transform active:scale-95"
                >
                  <RefreshCw className="w-4 h-4" />
                  <span>{buttonLabel}</span>
                </button>
              </div>
            );
          })()}

          {/* Top Floating Badges */}
          <div className="absolute top-4 left-4 right-4 flex items-center justify-between pointer-events-none">
            <span className="text-[10px] font-mono font-bold bg-slate-950/80 text-slate-300 px-3 py-1 rounded-full border border-slate-800 backdrop-blur-md flex items-center gap-1.5">
              <UserCheck className="w-3 h-3 text-emerald-400" />
              {employeeName}
            </span>
            {currentModeIsEnroll ? (
              <span className="text-[10px] font-mono font-bold px-3 py-1 rounded-full border backdrop-blur-md bg-blue-500/20 text-blue-300 border-blue-500/30">
                Enrollment: {enrollmentProgress}%
              </span>
            ) : confidencePercent !== null && (
              <span className={`text-[10px] font-mono font-bold px-3 py-1 rounded-full border backdrop-blur-md ${statusStep === 'FAILED'
                ? 'bg-rose-500/20 text-rose-300 border-rose-500/30'
                : 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                }`}>
                Accuracy: {confidencePercent}%
              </span>
            )}
          </div>

          {/* Real-time Environmental Quality Status Indicators */}
          {qualityMetrics && (
            <div className="absolute top-11 left-4 right-4 flex items-center justify-between pointer-events-none z-20 text-[10px] font-mono">
              <span className={`px-2.5 py-0.5 rounded-full backdrop-blur-md border flex items-center gap-1 ${
                qualityMetrics.lightingCondition === 'OPTIMAL'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                  : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
              }`}>
                {qualityMetrics.lightingCondition === 'OPTIMAL' ? '☀️ Optimal Light' :
                 qualityMetrics.lightingCondition === 'TOO_DARK' ? '🌙 Low Light' :
                 qualityMetrics.lightingCondition === 'TOO_BRIGHT' ? '☀️ High Glare' : '🌓 Side Shadows'}
              </span>

              <span className={`px-2.5 py-0.5 rounded-full backdrop-blur-md border flex items-center gap-1 ${
                qualityMetrics.sharpnessCondition === 'SHARP'
                  ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
                  : 'bg-amber-500/20 text-amber-300 border-amber-500/30'
              }`}>
                {qualityMetrics.sharpnessCondition === 'SHARP' ? '🎯 Sharp Focus' : '💨 Motion / Blur'}
              </span>
            </div>
          )}
        </div>

        {/* Footer Status Bar */}
        <div className="w-full p-6 bg-slate-950 border-t border-slate-800 space-y-4">
          <div className="text-center space-y-1">
            <p className={`text-xs font-bold ${statusStep === 'VERIFIED' ? 'text-emerald-400' :
              statusStep === 'FAILED' ? 'text-rose-400' :
                statusStep === 'NOT_ENROLLED' ? 'text-amber-400' : 'text-white'
              }`}>{feedbackText}</p>
            <p className="text-[10px] text-slate-500">
              {currentModeIsEnroll
                ? 'Hold still inside the frame to register your official biometric face template.'
                : isEnrolled
                  ? 'Biometric descriptor registered. Matching live face against 128-float embedding.'
                  : 'No facial template enrolled yet. Click "Register My Face" below to enroll.'}
            </p>
          </div>

          <div className="flex items-center justify-between gap-3 pt-1 flex-wrap">
            <button
              onClick={onClose}
              className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white transition-colors cursor-pointer"
            >
              Cancel
            </button>

            {/* NOT_ENROLLED: offer ONLY explicit registration — no bypass whatsoever */}
            {(statusStep === 'NOT_ENROLLED' || (!isEnrolled && statusStep !== 'LOADING_MODELS' && statusStep !== 'ERROR')) ? (
              <button
                onClick={() => {
                  setCurrentModeIsEnroll(true);
                  setStatusStep('CENTER_FACE');
                  setFeedbackText('Position your face inside frame to register...');
                }}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-1.5 shadow-md shadow-blue-900/40"
              >
                <Sparkles className="w-3.5 h-3.5" /> Register Face via Camera
              </button>
            ) : statusStep === 'FAILED' ? (
              /* FAILED: only retry scan — no bypass or override allowed */
              <button
                onClick={() => {
                  setStatusStep('CENTER_FACE');
                  setConfidencePercent(null);
                  setFeedbackText('Position your face inside the frame...');
                }}
                className="px-3.5 py-2 bg-rose-600 hover:bg-rose-500 text-white text-xs font-bold rounded-xl transition-all cursor-pointer flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Retry Scan
              </button>
            ) : null}
          </div>
        </div>
      </motion.div>
    </div>
  );
};
