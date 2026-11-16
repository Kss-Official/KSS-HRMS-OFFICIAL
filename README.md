# Kalpanaaa — Employee Management Platform (HRMS)

Full-stack enterprise HRMS featuring face recognition biometric check-in, geofence verification, automated attendance tracking, multi-tier leave approval pipelines, and payroll exports.

---

## Project Structure

```text
HRMS/
├── frontend/                  # React 19 + TypeScript + Vite + Tailwind CSS
│   ├── src/                  # App components, contexts, hooks, and services
│   ├── public/               # Public static assets & face-api models
│   ├── tests/                # Test suites & verification scripts
│   ├── package.json          # Node dependencies & frontend scripts
│   ├── vite.config.ts        # Vite configuration & PWA settings
│   └── .env.example          # Sample frontend environment flags
│
├── backend/                   # FastAPI + SQLAlchemy Async + Neon PostgreSQL
│   ├── app/                  # Application core, models, schemas, and API routers
│   │   ├── api/v1/           # Modular endpoints (auth, employees, attendance, leaves, realtime)
│   │   ├── core/             # Configuration, security (JWT), and database engine
│   │   ├── models/           # SQLAlchemy models with pgvector biometric support
│   │   └── schemas/          # Pydantic validation schemas
│   ├── requirements.txt      # Python dependencies
│   ├── test_db_connection.py # Interactive Neon DB verification script
│   └── .env                  # Neon DB credentials & server configurations (ignored by git)
│
├── functions/                 # Firebase Cloud Functions (legacy background tasks)
├── docs/                      # Product roadmap and architectural strategy
├── firestore.rules           # Security rules for Firestore
└── database.rules.json       # Security rules for Realtime Database
```

---

## Getting Started

### 1. Frontend
```bash
cd frontend
pnpm install # or npm install
pnpm dev     # starts Vite dev server at http://localhost:3000
```

### 2. Backend (FastAPI + Neon DB)
```bash
cd backend
python -m venv .venv
.venv\Scripts\activate   # On Windows
pip install -r requirements.txt
python test_db_connection.py
uvicorn app.main:app --reload --port 8000
```
Interactive API documentation: `http://localhost:8000/api/v1/docs`
