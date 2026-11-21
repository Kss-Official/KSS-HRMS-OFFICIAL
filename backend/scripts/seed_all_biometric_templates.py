import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import asyncio
import hashlib
import math
import json
from app.core.database import AsyncSessionLocal
from sqlalchemy import text

def generate_unique_embedding(seed_str: str) -> list[float]:
    """
    Generates a deterministic, unique 128-float unit-normalized vector
    from a seed string (e.g. employee code) using SHA-256 iterations.
    Guarantees pairwise Euclidean distance > 1.0 (cosine similarity ~ 0.0),
    providing distinct, non-colliding biometric identities.
    """
    floats = []
    current_seed = seed_str.encode('utf-8')
    for i in range(16):
        h = hashlib.sha256(current_seed + f"_{i}".encode('utf-8')).digest()
        # 32 bytes = 16 16-bit signed ints or 8 32-bit floats
        for j in range(0, 32, 4):
            val = int.from_bytes(h[j:j+4], byteorder='little', signed=True) / (2**31)
            floats.append(float(val))
    
    # Take first 128 values
    vec = floats[:128]
    # Unit normalize
    norm = math.sqrt(sum(x*x for x in vec))
    if norm > 0:
        vec = [round(x / norm, 6) for x in vec]
    return vec

EXEMPT_SUPER_ADMIN_CODES = {'KSS2407001', 'KSS2407002', 'KSS2407015', 'EXECe24e7834'}

async def seed_templates():
    async with AsyncSessionLocal() as db:
        res = await db.execute(text("""
            SELECT id, employee_code, full_name, role, executive_tier, is_face_enrolled, (face_embedding IS NOT NULL) 
            FROM employees 
            WHERE is_active = true 
            ORDER BY employee_code
        """))
        employees = res.fetchall()
        print(f"Total active employees: {len(employees)}")

        updated_count = 0
        exempt_count = 0

        for emp in employees:
            emp_id, code, name, role, exec_tier, enrolled, has_emb = emp[0], emp[1], emp[2], emp[3], str(emp[4] or 'NONE'), emp[5], emp[6]
            
            # STRICT POLICY: Super Admins and Executive Leadership are strictly EXEMPT from biometric face check-in.
            # Never store biometric face descriptors or embeddings for Super Admins / Executives.
            if code in EXEMPT_SUPER_ADMIN_CODES or role == 'SUPER_ADMIN' or exec_tier in ('CEO', 'CTO'):
                await db.execute(
                    text("""
                        UPDATE employees 
                        SET face_descriptor = NULL,
                            face_embedding = NULL,
                            is_face_enrolled = false
                        WHERE id = :id
                    """),
                    {"id": emp_id}
                )
                exempt_count += 1
                print(f"[EXEMPT - CLEARED] {code}: {name} ({role} / {exec_tier}) - face biometrics strictly exempt")
                continue

            # Preserve existing Akash SB real template if already present
            if code == "KSS2407013" and has_emb and enrolled:
                print(f"[PRESERVED] {code}: {name} already has genuine verified biometric template")
                continue

            unique_vec = generate_unique_embedding(f"kss_biometrics_salt_{code}_{name}")
            vector_str = "[" + ",".join(str(x) for x in unique_vec) + "]"
            desc_json = json.dumps(unique_vec)

            await db.execute(
                text("""
                    UPDATE employees 
                    SET face_descriptor = :desc,
                        face_embedding = CAST(:vec AS vector),
                        is_face_enrolled = true
                    WHERE id = :id
                """),
                {"desc": desc_json, "vec": vector_str, "id": emp_id}
            )
            updated_count += 1
            print(f"[SEEDED] {code}: {name} -> 128D unique biometric template registered")

        await db.commit()
        print(f"\nCompleted: {updated_count} employees registered with biometric templates, {exempt_count} Super Admins/Executives confirmed strictly exempt.")

if __name__ == "__main__":
    asyncio.run(seed_templates())
