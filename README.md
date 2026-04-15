# EduPay - School Payroll System

EduPay is a payroll and workforce management system for schools, built with Node.js, Express, PostgreSQL, and vanilla frontend technologies.

## Features

### Role-Based Access

- Admin: User administration, HR/admin/accountant account management, config, audit, backup, MFA portal
- HR: Teacher management, salary structures, leave and advance approvals, payroll approval
- Accountant: Payroll processing, payment status updates, report exports, payslip generation
- Teacher: Profile management, payslips, salary history, leave and advance requests, notifications

### Key Capabilities

- Payroll calculations with allowances and deductions
- Payroll approval workflow (processed -> approved -> paid)
- Advance request deduction lifecycle (Pending -> Approved -> Deducted)
- Teacher payroll halt/resume controls
- PDF payslip generation
- PDF/Excel payroll exports
- JWT authentication with MFA challenge flow
- In-app notifications and audit logging
- JSON backup export endpoint

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Database | PostgreSQL (pg) |
| Auth | JWT + bcrypt + otplib |
| Email | Nodemailer |
| PDF | PDFKit |
| Excel | ExcelJS |
| Frontend | Vanilla HTML/CSS/JS |

## Prerequisites

- Node.js 20+
- PostgreSQL database

## Setup

```bash
git clone https://github.com/balirwaalvin/EduPay-System.git
cd EduPay-System
npm install
```

Create a .env file (or copy from .env.example) and configure at least:

- DATABASE_URL (or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD)
- JWT_SECRET
- PORT
- SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS (for email features)

Start the application:

```bash
npm start
```

Open http://localhost:3000

## Default Access

Seeded admin account on first startup:

- Username: admin
- Password: admin123

## Main Routes

UI pages:

- / (login)
- /admin
- /hr
- /accountant
- /teacher-portal

API namespaces:

- /api/auth
- /api/admin
- /api/hr
- /api/accountant
- /api/teacher

## Project Structure

```text
.
|- public/
|  |- index.html
|  |- admin.html
|  |- hr.html
|  |- accountant.html
|  |- teacher.html
|  |- css/styles.css
|  `- js/
|     |- app.js
|     |- admin.js
|     |- hr.js
|     |- accountant.js
|     `- teacher.js
|- server/
|  |- server.js
|  |- database.js
|  |- middleware.js
|  |- services/email.js
|  `- routes/
|     |- auth.js
|     |- admin.js
|     |- hr.js
|     |- accountant.js
|     `- teacher.js
|- .do/app.yaml
|- .env.example
|- package.json
`- TECHNICAL_DOCUMENTATION.md
```

## Documentation

Full implementation-level technical documentation is available in TECHNICAL_DOCUMENTATION.md.

## License

ISC
