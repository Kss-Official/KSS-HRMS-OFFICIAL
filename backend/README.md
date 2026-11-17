# Kalpanaaa HRMS — FastAPI Backend

Modern, high-throughput asynchronous backend powered by **FastAPI**, **SQLAlchemy (Async)**, and **Neon Serverless PostgreSQL**.

## Project Structure

```
backend/
├── app/                  # Application source code
│   ├── api/v1/           # REST endpoints (auth, attendance, employees, leaves, etc.)
│   ├── core/             # Configuration, security, database session management
│   ├── models/           # SQLAlchemy ORM models & database schemas
│   └── schemas/          # Pydantic schemas for request/response validation
├── scripts/              # Operational & migration scripts
│   ├── init_db.py        # Neon PostgreSQL DDL & pgvector HNSW indexing
│   ├── sync_live_attendance.py # Attendance synchronization utility
│   ├── check_face.py     # Biometric verification diagnosis
│   └── reset_face_biometrics.py # Biometric enrollment reset utility
├── tests/                # Automated test suites
│   ├── performance/      # Apache JMeter load and stress test plans
│   ├── test_api_endpoints.py # Core FastAPI endpoint integration tests
│   ├── test_biometrics_workflow.py # Biometric registration & verification audit
│   ├── test_comprehensive_workflows.py # End-to-end business logic & RBAC audit
│   └── test_db_connection.py # Direct Neon DB & pgvector connectivity test
├── uploads/              # Local media & employee profile photos
├── .env                  # Environment configuration (secrets & database URLs)
├── requirements.txt      # Python dependencies
└── README.md             # Backend documentation
```

## Features
- **Neon PostgreSQL**: Connection pooling (`asyncpg`) with ACID compliance.
- **Biometric Search**: `pgvector(128)` support with HNSW indexing for sub-2ms facial verification.
- **Real-Time Radar**: Server-Sent Events (SSE) replacing costly client-side listeners.
- **Role-based JWT**: Access & refresh token rotation.
- **Multi-Tier Approvals**: Sequential PM -> HR -> CEO -> CTO pipeline.

## Getting Started

### 1. Setup Virtual Environment
```bash
python -m venv .venv
# Windows:
.venv\Scripts\activate
# Linux/macOS:
source .venv/bin/activate
```

### 2. Install Dependencies
```bash
pip install -r requirements.txt
```

### 3. Verify Database Connection
```bash
python tests/test_db_connection.py
```

### 4. Run Test Suites
```bash
python tests/test_api_endpoints.py
python tests/test_comprehensive_workflows.py
```

### 5. Run Development Server
```bash
uvicorn app.main:app --reload --port 8000
```
API Documentation will be live at:
- Swagger UI: `http://localhost:8000/api/v1/docs`
- ReDoc: `http://localhost:8000/api/v1/redoc`
