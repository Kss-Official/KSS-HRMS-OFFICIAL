import React, { useEffect, useRef, useState, useCallback } from 'react';
import { useAuth } from '../../context/AuthContext';
import { getEmployeeWorkDate } from '../../lib/attendanceEngine';
import { toast } from 'sonner';
import { Coffee, UtensilsCrossed, Users, Calendar, GraduationCap, Zap, Clock, StopCircle, X, BellRing } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

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
 * Sends a native desktop / OS notification that shows in Windows Action Center / System tray.
 */
export const sendSystemDesktopNotification = (
  title: string,
  body: string,
  onClickAction?: () => void
): void => {
  if (typeof window === 'undefined' || !('Notification' in window)) return;

  const trigger = () => {
    try {
      const options: any = {
        body,
        icon: '/pwa-192x192.png',
        badge: '/pwa-192x192.png',
        tag: 'hrms-break-15m-reminder',
        renotify: true,
        requireInteraction: true // Sticky on OS desktop until clicked or dismissed
      };
      const notification = new Notification(title, options);

      notification.onclick = () => {
        window.focus();
        notification.close();
        if (onClickAction) onClickAction();
      };
    } catch {
      // Fallback to ServiceWorker showNotification if standalone PWA
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(title, {
            body,
            icon: '/pwa-192x192.png',
            tag: 'hrms-break-15m-reminder',
            requireInteraction: true
          });
        }).catch(() => {});
      }
    }
  };

  if (Notification.permission === 'granted') {
    trigger();
  } else if (Notification.permission === 'default') {
    Notification.requestPermission().then((perm) => {
      if (perm === 'granted') trigger();
    });
  }
};

export const BreakReminderManager: React.FC = () => {
  const { activeEmployee, attendance, endBreak } = useAuth();
  const [activeBreakState, setActiveBreakState] = useState<{ type: string; startAt: string } | null>(null);
  const [activeBreakMinutes, setActiveBreakMinutes] = useState<number>(0);
  const [showFloatingBanner, setShowFloatingBanner] = useState<boolean>(false);
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

  // Request browser notification permissions on mount if default
  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      if (Notification.permission === 'default') {
        Notification.requestPermission().catch(() => {});
      }
    }
  }, []);

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
        candidateIds.includes((r as any).uid) &&
        r.date === todayStr
    );

    const breaks = todayRecord?.breaks ?? [];
    const openBreak = breaks.find((b) => !b.endAt && !(b as any).endTime);

    if (openBreak && isMonitoredBreakType(openBreak.type)) {
      const startAt = openBreak.startAt || (openBreak as any).startTime || new Date().toISOString();
      setActiveBreakState({ type: openBreak.type, startAt });
    } else {
      setActiveBreakState(null);
      lastAlertedIntervalRef.current = 0;
      setShowFloatingBanner(false);
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

    // Auto-stop flashing after 20 seconds or when user focuses window
    const stopFlashing = () => {
      if (flashTitleIntervalRef.current) {
        clearInterval(flashTitleIntervalRef.current);
        flashTitleIntervalRef.current = null;
        document.title = baseTitle;
      }
      window.removeEventListener('focus', stopFlashing);
    };
    window.addEventListener('focus', stopFlashing, { once: true });
    setTimeout(stopFlashing, 20000);
  }, []);

  const handleEndActiveBreak = async () => {
    if (!activeEmployee || isEndingBreak) return;
    setIsEndingBreak(true);
    try {
      await endBreak(activeEmployee.id);
      setShowFloatingBanner(false);
      toast.success('Break ended successfully. Welcome back to work! 👋');
    } catch (e: any) {
      toast.error(e?.message || 'Failed to end break');
    } finally {
      setIsEndingBreak(false);
    }
  };

  // High-Precision 15-Minute Cadence Engine
  useEffect(() => {
    if (!activeBreakState) return;

    const checkCadence = () => {
      const startMs = new Date(activeBreakState.startAt).getTime();
      const now = Date.now();
      const elapsedMs = Math.max(0, now - startMs);
      const elapsedMins = Math.floor(elapsedMs / 60000);
      setActiveBreakMinutes(elapsedMins);

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

        // 2. Send Native OS Desktop Notification (Action Center)
        sendSystemDesktopNotification(reminderTitle, reminderBody, () => {
          handleEndActiveBreak();
        });

        // 3. Flash Document Tab Title
        flashDocumentTitle(`⏰ [${totalMinutes}m Alert] ${activeBreakState.type}`);

        // 4. Trigger High-Visibility In-App Toast
        toast.warning(reminderTitle, {
          description: reminderBody,
          duration: 15000,
          action: {
            label: `End ${activeBreakState.type}`,
            onClick: () => handleEndActiveBreak()
          }
        });

        // 5. Show Floating System Reminder Banner
        setShowFloatingBanner(true);
      }
    };

    checkCadence();
    const intervalTimer = setInterval(checkCadence, 1000); // 1-second precision tick
    return () => clearInterval(intervalTimer);
  }, [activeBreakState, flashDocumentTitle]);

  if (!activeBreakState || !showFloatingBanner) {
    return null;
  }

  const emoji = BREAK_EMOJIS[activeBreakState.type] || '⏰';
  const minutesDisplay = activeBreakMinutes > 0 ? activeBreakMinutes : 15;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: 50, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 30, scale: 0.95 }}
        transition={{ type: 'spring', damping: 25, stiffness: 350 }}
        className="fixed bottom-6 right-6 z-[9999] max-w-md w-full bg-slate-900/95 backdrop-blur-xl border-2 border-amber-500/70 rounded-3xl p-5 shadow-2xl shadow-amber-950/60 text-white"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-2xl bg-amber-500/20 text-amber-400 border border-amber-500/40 flex items-center justify-center shrink-0 text-2xl shadow-inner animate-bounce">
              {emoji}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-black uppercase tracking-widest text-amber-400 bg-amber-500/15 px-2 py-0.5 rounded-full border border-amber-500/30 flex items-center gap-1">
                  <BellRing className="w-3 h-3 text-amber-400 animate-pulse" /> 15-MIN BREAK REMINDER
                </span>
              </div>
              <h4 className="text-sm font-black text-white mt-0.5">
                {activeBreakState.type} ({minutesDisplay} mins elapsed)
              </h4>
            </div>
          </div>

          <button
            onClick={() => setShowFloatingBanner(false)}
            className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors cursor-pointer"
            title="Dismiss reminder"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-300 mt-3 leading-relaxed">
          You have been on <strong className="text-white">{activeBreakState.type}</strong> for{' '}
          <strong className="text-amber-300 font-mono">{minutesDisplay} minutes</strong>. Please wrap up and resume your shift, or end the break below.
        </p>

        <div className="flex items-center justify-end gap-2.5 mt-4 pt-3 border-t border-slate-800">
          <button
            onClick={() => setShowFloatingBanner(false)}
            className="px-3 py-1.5 text-xs font-bold text-slate-400 hover:text-white rounded-xl hover:bg-slate-800 transition-colors cursor-pointer"
          >
            Snooze (Remind in 15m)
          </button>
          <button
            onClick={handleEndActiveBreak}
            disabled={isEndingBreak}
            className="px-4 py-2 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-400 hover:to-orange-400 text-slate-950 font-black text-xs rounded-xl shadow-lg flex items-center gap-1.5 cursor-pointer transition-all active:scale-95 disabled:opacity-50"
          >
            <StopCircle className="w-4 h-4" />
            <span>{isEndingBreak ? 'Ending...' : `End ${activeBreakState.type} Now`}</span>
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
