import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getEmployeeWorkDate } from '../../lib/attendanceEngine';
import { BellRing, CheckCircle2, X } from 'lucide-react';

const BREAK_EMOJIS: Record<string, string> = {
  'Tea Break': '🍵',
  'Snack Break': '🍿',
  'Meal Break': '🍱',
  'Lunch Break': '🍽️',
  'Team Huddle': '👥',
  'Team Meeting': '📅',
  'Attainment / Training': '🎓',
  'Training': '🎓',
  'Activity': '⚡'
};

const TARGET_BREAK_KEYWORDS = [
  'tea',
  'snack',
  'meal',
  'lunch',
  'huddle',
  'meeting',
  'training',
  'attainment',
  'activity'
];

export const isMonitoredBreakType = (type?: string): boolean => {
  if (!type) return false;
  const lower = type.toLowerCase();
  return TARGET_BREAK_KEYWORDS.some(kw => lower.includes(kw));
};

/**
 * Synthesizes a crisp, pleasant system chime using the Web Audio API.
 * Ascending chord: E5 (659Hz) -> G#5 (830Hz) -> B5 (987Hz) -> E6 (1318Hz).
 */
export const playBreakReminderSound = (): void => {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();

    const playTone = (freq: number, start: number, duration: number, vol = 0.28) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, ctx.currentTime + start);

      gain.gain.setValueAtTime(0, ctx.currentTime + start);
      gain.gain.linearRampToValueAtTime(vol, ctx.currentTime + start + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + duration);
    };

    playTone(659.25, 0.00, 0.35);  // E5
    playTone(830.61, 0.12, 0.35);  // G#5
    playTone(987.77, 0.24, 0.45);  // B5
    playTone(1318.51, 0.38, 0.70); // E6
  } catch (err) {
    console.warn('[BreakReminder] AudioContext alert blocked or unsupported:', err);
  }
};

/**
 * Sends a native desktop / OS notification that appears in the Windows Action Center
 * or desktop notification tray, even when the HRMS webpage is minimized or in the background.
 */
export const sendSystemDesktopNotification = async (
  title: string,
  body: string,
  onClickAction?: () => void
): Promise<boolean> => {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;

  if (Notification.permission !== 'granted') {
    return false;
  }

  const notificationOptions: any = {
    body,
    icon: '/pwa-192x192.png',
    badge: '/favicon.png',
    tag: `kss-break-reminder-${Date.now()}`,
    renotify: true,
    requireInteraction: true, // Native Windows desktop toast stays visible until clicked or dismissed
    silent: false,
    data: {
      type: 'break_reminder',
      timestamp: Date.now()
    },
    actions: [
      { action: 'end_break', title: 'End Break Now' },
      { action: 'open', title: 'Open HRMS' }
    ]
  };

  // Primary: Use ServiceWorkerRegistration.showNotification()
  // This is the ONLY reliable API that triggers native Windows Action Center / OS system notifications
  // when the browser tab is minimized, unfocused, or running in the background.
  let shownViaSW = false;
  if ('serviceWorker' in navigator) {
    try {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise<null>((r) => setTimeout(() => r(null), 1200))
      ]);
      if (reg && 'showNotification' in reg) {
        await reg.showNotification(title, notificationOptions);
        shownViaSW = true;
      }
    } catch (err) {
      console.warn('[BreakReminder] ServiceWorker showNotification notice:', err);
    }
  }

  // Fallback: If ServiceWorker was not ready, use standard window Notification API
  if (!shownViaSW) {
    try {
      const notification = new Notification(title, notificationOptions);
      notification.onclick = () => {
        window.focus();
        notification.close();
        if (onClickAction) onClickAction();
      };
      shownViaSW = true;
    } catch (err) {
      console.warn('[BreakReminder] Fallback Notification constructor failed:', err);
    }
  }

  return shownViaSW;
};

export const BreakReminderManager: React.FC = () => {
  const { activeEmployee, attendance, endBreak } = useAuth();
  const [activeBreakState, setActiveBreakState] = useState<{ type: string; startAt: string } | null>(null);
  const [permissionStatus, setPermissionStatus] = useState<NotificationPermission>(() => {
    return typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'denied';
  });
  const [showPermissionBanner, setShowPermissionBanner] = useState<boolean>(false);
  const [isEndingBreak, setIsEndingBreak] = useState<boolean>(false);

  const lastAlertedIntervalRef = useRef<number>(0);
  const originalTitleRef = useRef<string>('');
  const flashTitleIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Store original document title
  useEffect(() => {
    if (typeof document !== 'undefined' && !originalTitleRef.current) {
      originalTitleRef.current = document.title || 'Kalpana Software Solutions';
    }
  }, []);

  // Update permission status and show permission banner if not granted
  useEffect(() => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const current = Notification.permission;
    setPermissionStatus(current);
    if (activeBreakState && current !== 'granted') {
      setShowPermissionBanner(true);
    } else {
      setShowPermissionBanner(false);
    }
  }, [activeBreakState]);

  // Request browser notification permissions with user gesture
  const requestDesktopNotificationPermission = async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    try {
      const result = await Notification.requestPermission();
      setPermissionStatus(result);
      if (result === 'granted') {
        setShowPermissionBanner(false);
        // Show test native notification
        sendSystemDesktopNotification(
          '🔔 Native Desktop Notifications Active',
          'You will now receive break reminders directly in Windows / System Action Center even when HRMS is minimized.'
        );
      }
    } catch (err) {
      console.warn('[BreakReminder] Permission request error:', err);
    }
  };

  // Resolve current active break from today's attendance record
  useEffect(() => {
    if (!activeEmployee) {
      setActiveBreakState(null);
      return;
    }

    const todayStr = getEmployeeWorkDate(new Date());
    const candidateIds = [activeEmployee.id, activeEmployee.employeeId, activeEmployee.uid].filter(Boolean);
    const todayRecord = attendance.find(
      (r) =>
        candidateIds.includes(r.employeeId) ||
        candidateIds.includes((r as any).employeeUid) ||
        (candidateIds.includes((r as any).uid) && r.date === todayStr) ||
        (r.employeeCode && candidateIds.includes(r.employeeCode) && r.date === todayStr)
    );

    const breaks = todayRecord?.breaks ?? [];
    const openBreak = breaks.find((b) => !b.endAt && !(b as any).endTime);

    if (openBreak && isMonitoredBreakType(openBreak.type)) {
      const startAt = openBreak.startAt || (openBreak as any).startTime || new Date().toISOString();
      setActiveBreakState({ type: openBreak.type, startAt });
    } else {
      setActiveBreakState(null);
      lastAlertedIntervalRef.current = 0;
      // Restore tab title
      if (flashTitleIntervalRef.current) {
        clearInterval(flashTitleIntervalRef.current);
        flashTitleIntervalRef.current = null;
        if (typeof document !== 'undefined') {
          document.title = originalTitleRef.current;
        }
      }
    }
  }, [activeEmployee, attendance]);

  // Handle flash title
  const flashDocumentTitle = useCallback((alertTitle: string) => {
    if (typeof document === 'undefined') return;
    if (flashTitleIntervalRef.current) clearInterval(flashTitleIntervalRef.current);

    let isAlert = true;
    const baseTitle = originalTitleRef.current || 'Kalpana Software Solutions';
    flashTitleIntervalRef.current = setInterval(() => {
      document.title = isAlert ? alertTitle : baseTitle;
      isAlert = !isAlert;
    }, 1000);

    const stopFlashing = () => {
      if (flashTitleIntervalRef.current) {
        clearInterval(flashTitleIntervalRef.current);
        flashTitleIntervalRef.current = null;
        document.title = baseTitle;
      }
      window.removeEventListener('focus', stopFlashing);
    };
    window.addEventListener('focus', stopFlashing, { once: true });
    setTimeout(stopFlashing, 25000);
  }, []);

  const handleEndActiveBreak = useCallback(async () => {
    if (!activeEmployee || isEndingBreak) return;
    setIsEndingBreak(true);
    try {
      await endBreak(activeEmployee.id);
    } catch (e: any) {
      console.warn('[BreakReminder] Failed to end break:', e);
    } finally {
      setIsEndingBreak(false);
    }
  }, [activeEmployee, endBreak, isEndingBreak]);

  // Listen for Service Worker messages (e.g. user clicked "End Break Now" on the native Windows desktop notification)
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const handleSwMessage = (event: MessageEvent) => {
      if (event.data?.type === 'END_ACTIVE_BREAK') {
        handleEndActiveBreak();
      }
    };
    navigator.serviceWorker.addEventListener('message', handleSwMessage);
    return () => {
      navigator.serviceWorker.removeEventListener('message', handleSwMessage);
    };
  }, [handleEndActiveBreak]);

  // High-Precision Cadence Engine using an inline Web Worker ticker
  // (Web Workers run in background and are NOT throttled by Chrome/Edge when the tab is minimized)
  useEffect(() => {
    if (!activeBreakState) return;

    const checkCadence = () => {
      const startMs = new Date(activeBreakState.startAt).getTime();
      const now = Date.now();
      const elapsedMs = Math.max(0, now - startMs);
      const elapsedMins = Math.floor(elapsedMs / 60000);

      // 15-minute interval index: 1 = 15m, 2 = 30m, 3 = 45m, 4 = 60m...
      const interval = Math.floor(elapsedMins / 15);

      if (interval >= 1 && interval !== lastAlertedIntervalRef.current) {
        lastAlertedIntervalRef.current = interval;
        const totalMinutes = interval * 15;
        const emoji = BREAK_EMOJIS[activeBreakState.type] || '⏰';

        const reminderTitle = `⏰ ${totalMinutes}-Minute Reminder: ${emoji} ${activeBreakState.type}`;
        const reminderBody = `You have been on ${activeBreakState.type} for ${totalMinutes} minutes. Please wrap up and resume your shift or end the break.`;

        // 1. Play System Chime Sound
        playBreakReminderSound();

        // 2. Send Native OS Desktop Notification (Appears in Windows Action Center / Desktop tray)
        sendSystemDesktopNotification(reminderTitle, reminderBody, () => {
          handleEndActiveBreak();
        });

        // 3. Flash Document Tab Title so browser tab is visible even if minimized
        flashDocumentTitle(`⏰ [${totalMinutes}m Alert] ${activeBreakState.type}`);
      }
    };

    checkCadence();

    // Start unthrottled Web Worker ticker
    let worker: Worker | null = null;
    let fallbackTimer: any = null;

    try {
      const blob = new Blob([
        `setInterval(function() { postMessage('tick'); }, 1000);`
      ], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(blob);
      worker = new Worker(workerUrl);
      worker.onmessage = () => {
        checkCadence();
      };
      URL.revokeObjectURL(workerUrl);
    } catch {
      fallbackTimer = setInterval(checkCadence, 1000);
    }

    // Wakeup on tab focus / visibilitychange
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        checkCadence();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (worker) worker.terminate();
      if (fallbackTimer) clearInterval(fallbackTimer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [activeBreakState, flashDocumentTitle, handleEndActiveBreak]);

  // If active break is running and desktop notifications are not yet allowed by the browser,
  // show a single non-intrusive banner prompting to enable native system desktop notifications.
  if (activeBreakState && showPermissionBanner && permissionStatus !== 'granted') {
    return (
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[10000] max-w-lg w-[92%] bg-slate-900/95 backdrop-blur-xl border border-amber-500/50 rounded-2xl p-3.5 shadow-2xl flex items-center justify-between gap-3 animate-in fade-in slide-in-from-top-4 duration-300">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="p-2 bg-amber-500/10 border border-amber-500/30 rounded-xl shrink-0">
            <BellRing className="w-4 h-4 text-amber-400 animate-pulse" />
          </div>
          <div className="text-xs">
            <p className="font-bold text-white">Enable Native Desktop Notifications</p>
            <p className="text-[11px] text-slate-400">Receive system alerts on your desktop when HRMS is minimized.</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            onClick={requestDesktopNotificationPermission}
            className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-white font-bold text-xs rounded-xl shadow-md transition-all cursor-pointer flex items-center gap-1"
          >
            <CheckCircle2 className="w-3.5 h-3.5" /> Enable
          </button>
          <button
            onClick={() => setShowPermissionBanner(false)}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return null;
};
