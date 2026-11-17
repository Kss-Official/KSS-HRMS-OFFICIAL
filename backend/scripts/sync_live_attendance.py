import asyncio
import json
import urllib.request
import uuid
from datetime import datetime, timezone, date
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from app.core.database import AsyncSessionLocal
from sqlalchemy import text
from app.models.enums import AttendanceStatus, AttendanceMethod, BreakType

PROJECT_ID = 'kalpanaaa-employees-website'
API_KEY = 'AIzaSyB5sN1axynuVlmzK0k6lLrvL3PbsR7x0QA'
ADMIN_EMAIL = 'd.koushik@kalpanaaasoftwaresolutions.in'
ADMIN_PASS = 'Koushik@777'
FIRESTORE_BASE = f'https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents'

def http_request(url, method='GET', body=None, token=None):
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = f'Bearer {token}'
    data = json.dumps(body).encode('utf-8') if body else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode('utf-8'))

def parse_iso(val):
    if not val:
        return None
    val = val.strip()
    if val.endswith('Z'):
        val = val[:-1] + '+00:00'
    return datetime.fromisoformat(val)

def map_break_type(raw_type):
    t = str(raw_type or '').upper()
    if 'SNACK' in t:
        return BreakType.SNACK_BREAK
    if 'TEA' in t or 'COFFEE' in t:
        return BreakType.TEA_BREAK
    if 'MEAL' in t or 'LUNCH' in t:
        return BreakType.LUNCH_BREAK
    if 'HUDDLE' in t:
        return BreakType.TEAM_HUDDLE
    if 'MEETING' in t:
        return BreakType.TEAM_MEETING
    if 'TRAIN' in t:
        return BreakType.TRAINING
    if 'ACTIVITY' in t:
        return BreakType.ACTIVITY
    return BreakType.TEA_BREAK

def map_attendance_status(raw_status):
    s = str(raw_status or '').upper().replace(' ', '_')
    if 'LATE' in s:
        return AttendanceStatus.LATE
    if 'LEAVE' in s:
        return AttendanceStatus.ON_LEAVE
    if 'HALF' in s:
        return AttendanceStatus.HALF_DAY
    if 'WFH' in s or 'HOME' in s:
        return AttendanceStatus.WORK_FROM_HOME
    if 'ABSENT' in s:
        return AttendanceStatus.ABSENT
    if 'HOLIDAY' in s:
        return AttendanceStatus.HOLIDAY
    return AttendanceStatus.PRESENT

async def sync():
    print("Fetching live token from Firebase Auth...")
    token = http_request(
        f'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={API_KEY}',
        method='POST',
        body={'email': ADMIN_EMAIL, 'password': ADMIN_PASS, 'returnSecureToken': True}
    )['idToken']

    # Page through attendance
    all_docs = []
    page_token = None
    while True:
        url = f'{FIRESTORE_BASE}/attendance?pageSize=300'
        if page_token:
            url += f'&pageToken={page_token}'
        res = http_request(url, token=token)
        docs = res.get('documents', [])
        all_docs.extend(docs)
        page_token = res.get('nextPageToken')
        if not page_token:
            break

    print(f"Total Firestore attendance docs: {len(all_docs)}")

    async with AsyncSessionLocal() as session:
        # Load employees
        emps = (await session.execute(text("SELECT id, employee_code, full_name FROM employees"))).fetchall()
        emp_map = {}
        for eid, code, name in emps:
            emp_map[code.upper()] = eid
            emp_map[name.strip().lower()] = eid

        # Target dates to sync
        target_dates = {'2026-11-16', '2026-11-17'}

        updated_count = 0
        inserted_count = 0

        for doc in all_docs:
            fields = doc.get('fields', {})
            date_str = fields.get('date', {}).get('stringValue', '')
            if date_str not in target_dates:
                continue

            ename = fields.get('employeeName', {}).get('stringValue', '').strip()
            eid_code = fields.get('employeeId', {}).get('stringValue', '').strip()
            euid = fields.get('employeeUid', {}).get('stringValue', '').strip()

            target_emp_id = None
            if eid_code.upper() in emp_map:
                target_emp_id = emp_map[eid_code.upper()]
            elif ename.lower() in emp_map:
                target_emp_id = emp_map[ename.lower()]
            else:
                for k, v in emp_map.items():
                    if k in ename.lower() or ename.lower() in k:
                        target_emp_id = v
                        break

            if not target_emp_id:
                print(f"Skipping unknown employee: {ename} ({eid_code})")
                continue

            raw_status = fields.get('status', {}).get('stringValue', 'Present')
            status_enum = map_attendance_status(raw_status)

            cin_raw = fields.get('checkInAt', {}).get('timestampValue') or fields.get('checkInAt', {}).get('stringValue')
            cout_raw = fields.get('checkOutAt', {}).get('timestampValue') or fields.get('checkOutAt', {}).get('stringValue')
            cin_dt = parse_iso(cin_raw)
            cout_dt = parse_iso(cout_raw)

            wm = int(fields.get('workingMinutes', {}).get('integerValue') or fields.get('workingMinutes', {}).get('doubleValue') or 0)
            is_wfh = bool(fields.get('isWfh', {}).get('booleanValue', False) or status_enum == AttendanceStatus.WORK_FROM_HOME)

            breaks_raw = fields.get('breaks', {}).get('arrayValue', {}).get('values', [])

            # Check if record exists in Postgres
            rec = (await session.execute(text("""
                SELECT id FROM attendance_records
                WHERE employee_id = :emp_id AND date = :date
            """), {'emp_id': target_emp_id, 'date': date.fromisoformat(date_str)})).fetchone()

            if rec:
                rec_id = rec[0]
                await session.execute(text("""
                    UPDATE attendance_records
                    SET check_in_at = :cin,
                        check_out_at = :cout,
                        status = :status,
                        working_minutes = :wm,
                        is_wfh = :is_wfh
                    WHERE id = :id
                """), {
                    'cin': cin_dt,
                    'cout': cout_dt,
                    'status': status_enum.name,
                    'wm': wm,
                    'is_wfh': is_wfh,
                    'id': rec_id
                })
                updated_count += 1
            else:
                rec_id = uuid.uuid4()
                await session.execute(text("""
                    INSERT INTO attendance_records (
                        id, employee_id, date, status, check_in_at, check_out_at,
                        working_minutes, is_wfh, location_verified, attendance_method,
                        created_at, updated_at
                    ) VALUES (
                        :id, :emp_id, :date, :status, :cin, :cout,
                        :wm, :is_wfh, true, 'PORTAL_1CLICK',
                        NOW(), NOW()
                    )
                """), {
                    'id': rec_id,
                    'emp_id': target_emp_id,
                    'date': date.fromisoformat(date_str),
                    'status': status_enum.name,
                    'cin': cin_dt,
                    'cout': cout_dt,
                    'wm': wm,
                    'is_wfh': is_wfh
                })
                inserted_count += 1

            # Sync breaks for this record
            if breaks_raw:
                # Clear existing breaks for this record
                await session.execute(text("DELETE FROM attendance_breaks WHERE attendance_id = :rec_id"), {'rec_id': rec_id})
                for b in breaks_raw:
                    bf = b.get('mapValue', {}).get('fields', {})
                    btype = map_break_type(bf.get('type', {}).get('stringValue', 'Tea Break'))
                    bstart = parse_iso(bf.get('startAt', {}).get('stringValue') or bf.get('startTime', {}).get('stringValue'))
                    bend = parse_iso(bf.get('endAt', {}).get('stringValue') or bf.get('endTime', {}).get('stringValue'))
                    bdur = int(bf.get('durationMinutes', {}).get('integerValue') or bf.get('durationMinutes', {}).get('doubleValue') or 0)
                    if bdur <= 0 and bstart and bend:
                        bdur = max(1, int((bend - bstart).total_seconds() / 60))

                    if bstart:
                        await session.execute(text("""
                            INSERT INTO attendance_breaks (id, attendance_id, type, start_time, end_time, duration_minutes)
                            VALUES (:id, :aid, :btype, :bstart, :bend, :bdur)
                        """), {
                            'id': uuid.uuid4(),
                            'aid': rec_id,
                            'btype': btype.name,
                            'bstart': bstart,
                            'bend': bend,
                            'bdur': bdur
                        })

        await session.commit()
        print(f"Sync complete: {updated_count} records updated, {inserted_count} records inserted.")

if __name__ == '__main__':
    asyncio.run(sync())
