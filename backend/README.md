# Kalpanaaa HRMS — FastAPI Backend

Modern, high-throughput asynchronous backend powered by **FastAPI**, **SQLAlchemy (Async)**, and **Neon Serverless PostgreSQL**.

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
python test_db_connection.py
```

### 4. Run Development Server
```bash
uvicorn app.main:app --reload --port 8000
```
API Documentation will be live at:
- Swagger UI: `http://localhost:8000/api/v1/docs`
- ReDoc: `http://localhost:8000/api/v1/redoc`
