import os
import sys
sys.path.insert(0, os.path.abspath('backend'))
import asyncio
from app.core.database import AsyncSessionLocal
from sqlalchemy import text
import urllib.request
import json
import uuid
from datetime import datetime

PROJECT_ID = 'kalpanaaa-employees-website'
API_KEY = 'AIzaSyB5sN1axynuVlmzK0k6lLrvL3PbsR7x0QA'
ADMIN_EMAIL = 'd.koushik@kalpanaaasoftwaresolutions.in'
ADMIN_PASS = 'Koushik@777'
FIRESTORE_BASE = f'https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents'

def get_firebase_token():
    auth_url = f"https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={API_KEY}"
    req = urllib.request.Request(
        auth_url,
        data=json.dumps({"email": ADMIN_EMAIL, "password": ADMIN_PASS, "returnSecureToken": True}).encode(),
        headers={'Content-Type': 'application/json'}
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read().decode())['idToken']

def get_all_firestore_leave_requests(token):
    docs = []
    page_token = None
    while True:
        url = f'{FIRESTORE_BASE}/leaveRequests?pageSize=300'
        if page_token:
            url += f'&pageToken={page_token}'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
        with urllib.request.urlopen(req) as resp:
            data = json.loads(resp.read().decode())
            docs.extend(data.get('documents', []))
            page_token = data.get('nextPageToken')
            if not page_token:
                break
    return docs

def extract_val(field_obj):
    if not field_obj:
        return None
    for k in ('stringValue', 'integerValue', 'doubleValue', 'booleanValue', 'timestampValue'):
        if k in field_obj:
            return field_obj[k]
    return list(field_obj.values())[0] if field_obj else None

def map_leave_type(t_str, category_str=None, reason=''):
    raw = (t_str or category_str or '').upper().strip()
    reason_lower = (reason or '').lower()
    if 'SICK' in raw or 'sick' in reason_lower:
        return 'SICK_LEAVE'
    if 'WFH' in raw or 'WORK FROM HOME' in raw or 'WORK_FROM_HOME' in raw:
        return 'WFH'
    if 'EARN' in raw or raw == 'LEAVE':
        return 'EARN_LEAVE'
    if 'CASUAL' in raw:
        return 'CASUAL_LEAVE'
    if 'LOSS' in raw or 'LOP' in raw:
        return 'LOSS_OF_PAY'
    return 'EARN_LEAVE'

def map_status(s_str):
    raw = (s_str or 'PENDING').upper().strip()
    if raw in ('APPROVED', 'REJECTED', 'CANCELLED', 'PENDING'):
        return raw
    return 'PENDING'

def map_approval_status(s_str):
    raw = (s_str or 'PENDING').upper().strip()
    if raw in ('APPROVED', 'REJECTED', 'WAITING_CEO', 'NA', 'PENDING'):
        return raw
    if raw == 'N/A':
        return 'NA'
    return 'PENDING'

async def migrate():
    token = get_firebase_token()
    all_docs = get_all_firestore_leave_requests(token)
    print(f"Fetched {len(all_docs)} raw leave documents from Firestore.")

    # Filter out fake demo documents (starting with 'leave-')
    real_docs = [d for d in all_docs if not d.get('name', '').split('/')[-1].startswith('leave-')]
    print(f"Legitimate authentic requests from Firestore: {len(real_docs)}")

    # 2. Get Employee ID map from Neon DB
    async with AsyncSessionLocal() as session:
        emp_res = await session.execute(text("SELECT id, employee_code, full_name, email FROM employees"))
        emp_rows = emp_res.fetchall()
        
        emp_by_code = {r.employee_code.upper().strip(): r.id for r in emp_rows}
        emp_by_name = {r.full_name.lower().strip(): r.id for r in emp_rows}

        # 3. Clean and wipe existing leave_requests table in Neon DB
        await session.execute(text("DELETE FROM leave_requests"))
        await session.commit()
        print("Wiped old leave_requests table in Neon DB.")

        # 4. Insert the 49 clean, authentic requests from Firestore
        inserted_count = 0
        for d in real_docs:
            doc_id = d.get('name', '').split('/')[-1]
            f = d.get('fields', {})
            
            raw_code = (extract_val(f.get('employeeId')) or extract_val(f.get('employeeCode')) or '').upper().strip()
            raw_name = (extract_val(f.get('employeeName')) or '').lower().strip()
            
            # Special case: Jason Kenneth N in doc LR_KSS2407014_2026-08-22_Leave has employeeName 'Jason Kenneth N' but employeeId was 'KSS2407014'
            if 'jason' in raw_name:
                raw_code = 'KSS2407011'
            elif 'jingyasha' in raw_name:
                raw_code = 'KSS2407016'

            # Resolve employee_id
            target_emp_id = None
            if raw_code in emp_by_code:
                target_emp_id = emp_by_code[raw_code]
            elif raw_name in emp_by_name:
                target_emp_id = emp_by_name[raw_name]
            else:
                for n, eid in emp_by_name.items():
                    if n in raw_name or raw_name in n:
                        target_emp_id = eid
                        break
            
            if not target_emp_id:
                print(f"Warning: Could not match employee for {raw_code} ({raw_name}), doc: {doc_id}")
                continue

            reason = extract_val(f.get('reason')) or 'Leave Request'
            t = map_leave_type(extract_val(f.get('type')), extract_val(f.get('leaveCategory')), reason)
            start_date_str = extract_val(f.get('startDate')) or '2026-08-01'
            end_date_str = extract_val(f.get('endDate')) or start_date_str
            
            start_date = datetime.strptime(start_date_str[:10], '%Y-%m-%d').date()
            end_date = datetime.strptime(end_date_str[:10], '%Y-%m-%d').date()

            status = map_status(extract_val(f.get('status')))
            ceo_status = map_approval_status(extract_val(f.get('ceoStatus')))
            cto_status = map_approval_status(extract_val(f.get('ctoStatus')))
            
            req_date_str = extract_val(f.get('requestDate')) or extract_val(f.get('createdAt'))
            created_at = datetime.utcnow()
            if req_date_str:
                try:
                    created_at = datetime.fromisoformat(req_date_str.replace('Z', '+00:00'))
                except Exception:
                    pass

            await session.execute(text("""
                INSERT INTO leave_requests (
                    id, request_code, employee_id, type, start_date, end_date,
                    reason, status, ceo_status, cto_status, deduction_applied, created_at, updated_at
                ) VALUES (
                    :id, :request_code, :employee_id, :type, :start_date, :end_date,
                    :reason, :status, :ceo_status, :cto_status, :deduction_applied, :created_at, :updated_at
                )
            """), {
                "id": uuid.uuid4(),
                "request_code": doc_id,
                "employee_id": target_emp_id,
                "type": t,
                "start_date": start_date,
                "end_date": end_date,
                "reason": reason,
                "status": status,
                "ceo_status": ceo_status,
                "cto_status": cto_status,
                "deduction_applied": False,
                "created_at": created_at,
                "updated_at": created_at
            })
            inserted_count += 1

        await session.commit()
        print(f"\nSuccessfully migrated {inserted_count} clean leave requests into Neon DB!")

if __name__ == '__main__':
    asyncio.run(migrate())
