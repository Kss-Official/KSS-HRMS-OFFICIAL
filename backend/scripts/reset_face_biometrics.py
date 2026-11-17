import asyncio
import json
import urllib.request
from app.core.database import AsyncSessionLocal
from sqlalchemy import text

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

async def reset_postgres():
    print('1. Resetting face biometrics in Neon PostgreSQL...')
    async with AsyncSessionLocal() as session:
        res = await session.execute(text('''
            UPDATE employees
            SET face_descriptor = NULL,
                face_embedding = NULL,
                is_face_enrolled = false;
        '''))
        await session.commit()
        print(f'   Cleared face biometrics for {res.rowcount} employees in PostgreSQL.')

def reset_firestore():
    print('2. Resetting face biometrics in Google Firestore...')
    token = http_request(
        f'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key={API_KEY}',
        method='POST',
        body={'email': ADMIN_EMAIL, 'password': ADMIN_PASS, 'returnSecureToken': True}
    )['idToken']

    res = http_request(f'{FIRESTORE_BASE}/employees?pageSize=100', token=token)
    docs = res.get('documents', [])
    updated = 0
    for doc in docs:
        doc_path = doc['name']
        fields = doc.get('fields', {})
        if fields.get('isFaceEnrolled') or fields.get('faceDescriptor'):
            # Clear face biometric fields
            patch_url = f'https://firestore.googleapis.com/v1/{doc_path}?updateMask.fieldPaths=isFaceEnrolled&updateMask.fieldPaths=faceDescriptor'
            patch_body = {
                'fields': {
                    'isFaceEnrolled': {'booleanValue': False}
                }
            }
            try:
                http_request(patch_url, method='PATCH', body=patch_body, token=token)
                updated += 1
            except Exception as e:
                print(f'   Error updating {doc_path}: {e}')
    print(f'   Cleared face biometrics for {updated} employee documents in Firestore.')

async def main():
    await reset_postgres()
    reset_firestore()
    print('✓ Face biometric registration system successfully reset across all stores!')

if __name__ == '__main__':
    asyncio.run(main())
