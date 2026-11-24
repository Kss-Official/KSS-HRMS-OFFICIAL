import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const OUT = process.env.KSS_TEST_OUT;
const engine = require(join(OUT, 'attendanceEngine.cjs'));

const {
  isShiftComplete,
  resolveAttendanceRecord,
  formatTimestampToISO,
  safeGetTimestampMillis,
  calculateTotalBreakMinutes,
  isFabricatedCheckoutOnly
} = engine;

test('Checkout & Break System Forensic Test Suite', async (t) => {
  await t.test('1. isShiftComplete Handles All Valid and Invalid Checkouts', () => {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // 1a. Missing checkout
    assert.equal(isShiftComplete(null), false, 'null record is not complete');
    assert.equal(isShiftComplete({ checkInAt: nowIso }), false, 'missing checkOutAt is not complete');
    assert.equal(isShiftComplete({ checkInAt: nowIso, checkOutAt: null }), false, 'null checkOutAt is not complete');
    assert.equal(isShiftComplete({ checkOutAt: nowIso }), false, 'missing checkInAt is not complete');

    // 1b. Real valid checkout
    assert.equal(isShiftComplete({ checkInAt: '2026-11-24T10:14:00.000Z', checkOutAt: nowIso }), true, 'valid checkout is complete');

    // 1c. Firestore serverTimestamp() sentinel before server round-trip
    const sentinel = { _methodName: 'serverTimestamp' };
    assert.equal(isShiftComplete({ checkInAt: '2026-11-24T10:14:00.000Z', checkOutAt: sentinel }), true, 'sentinel checkout must be recognized as complete immediately');

    // 1d. Fabricated future checkout
    const futureIso = new Date(now + 3600000).toISOString();
    assert.equal(isShiftComplete({ checkInAt: '2026-11-24T10:14:00.000Z', checkOutAt: futureIso }), false, 'future checkout is not complete');

    // 1e. Fabricated migration string
    assert.equal(isShiftComplete({ checkInAt: '2026-11-24T09:45:00.000+05:30', checkOutAt: '2026-11-24T19:30:00.000+05:30' }), false, 'fabricated migration string must not complete shift');
  });

  await t.test('2. formatTimestampToISO & safeGetTimestampMillis Handle Sentinels', () => {
    const sentinel = { _methodName: 'serverTimestamp' };
    const iso = formatTimestampToISO(sentinel);
    assert.ok(iso, 'sentinel must produce a valid ISO string');
    assert.ok(!isNaN(new Date(iso).getTime()), 'sentinel ISO must be a valid date');

    const ms = safeGetTimestampMillis(sentinel);
    assert.ok(typeof ms === 'number' && ms > 0, 'sentinel must produce a positive numeric epoch timestamp');
  });

  await t.test('3. resolveAttendanceRecord Adopts Checkout from Any Matching Duplicate', () => {
    const activeEmp = { id: 'emp-KSS2407013', employeeId: 'KSS2407013', fullName: 'Akash SB', uid: 'nMnI0qXOmMO9gw2nDnnPJuz2G1S2' };
    const today = '2026-11-24';

    // Scenario: canonical record in Firestore has checkInAt 10:14 am and open Meal Break,
    // while Neon DB / local duplicate has checkOutAt 18:29 pm
    const canonicalDoc = {
      id: 'nMnI0qXOmMO9gw2nDnnPJuz2G1S2_2026-11-24',
      employeeId: 'emp-KSS2407013',
      employeeCode: 'KSS2407013',
      date: today,
      checkInAt: '2026-11-24T10:14:00.000Z',
      checkOutAt: null,
      breaks: [
        { type: 'Meal Break', startAt: '2026-11-24T13:36:00.000Z', endAt: '2026-11-24T14:51:00.000Z', durationMinutes: 75 },
        { type: 'Meal Break', startAt: '2026-11-24T16:20:00.000Z', endAt: null, durationMinutes: 0 }
      ]
    };

    const nowIso = new Date().toISOString();
    const checkedOutDoc = {
      id: 'b9702d8a-ba02-4abb-a79c-ff9fe6c324b3',
      employeeId: 'emp-KSS2407013',
      employeeCode: 'KSS2407013',
      date: today,
      checkInAt: '2026-11-24T10:14:00.000Z',
      checkOutAt: nowIso,
      workingMinutes: 420
    };

    const resolved = resolveAttendanceRecord([canonicalDoc, checkedOutDoc], activeEmp, today);

    assert.ok(resolved, 'must resolve a record');
    assert.equal(resolved.checkOutAt, nowIso, 'must adopt the real checkout timestamp');
    assert.equal(isShiftComplete(resolved), true, 'resolved record must be shift complete');

    // All breaks must be closed upon checkout
    const openBreaks = (resolved.breaks || []).filter(b => !b.endAt && !b.endTime);
    assert.equal(openBreaks.length, 0, 'all breaks must be closed when checkout exists');
  });

  await t.test('4. All 7 Break Types Lifecycle & Calculations', () => {
    const breakTypes = [
      'Meal Break',
      'Tea Break',
      'Snack Break',
      'Team Huddle',
      'Team Meeting',
      'Attainment / Training',
      'Activity'
    ];

    const breaks = [];
    let shiftStart = new Date('2026-11-24T10:00:00.000Z').getTime();

    // Sequentially start and end all 7 breaks
    for (let i = 0; i < breakTypes.length; i++) {
      const type = breakTypes[i];
      const startMs = shiftStart + (i * 3600000); // 1 hr apart
      const endMs = startMs + (15 * 60000);      // 15 min break

      const startIso = new Date(startMs).toISOString();
      const endIso = new Date(endMs).toISOString();

      breaks.push({
        type,
        startAt: startIso,
        endAt: endIso,
        durationMinutes: 15
      });
    }

    assert.equal(breaks.length, 7, 'all 7 break types recorded');
    const totalMinutes = calculateTotalBreakMinutes(breaks);
    assert.equal(totalMinutes, 7 * 15, 'total break minutes must equal sum of individual breaks');
  });

  await t.test('5. Auto-Closing Open Break on Checkout', () => {
    const activeEmp = { id: 'emp-KSS2407013', employeeId: 'KSS2407013', fullName: 'Akash SB' };
    const today = '2026-11-24';

    const recordWithOpenBreak = {
      id: 'emp-KSS2407013_2026-11-24',
      employeeId: 'emp-KSS2407013',
      date: today,
      checkInAt: '2026-11-24T10:00:00.000Z',
      checkOutAt: '2026-11-24T18:00:00.000Z',
      breaks: [
        { type: 'Activity', startAt: '2026-11-24T17:30:00.000Z', endAt: null }
      ]
    };

    const resolved = resolveAttendanceRecord([recordWithOpenBreak], activeEmp, today);
    assert.ok(resolved);
    assert.equal(resolved.breaks[0].endAt, '2026-11-24T18:00:00.000Z', 'open break must be closed at checkout time');
    assert.equal(resolved.breaks[0].durationMinutes, 30, 'duration must be calculated as 30 minutes');
  });
});
