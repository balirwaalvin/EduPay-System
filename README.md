# EduPay — School Payroll System

A full-stack payroll management system for schools, built with Node.js, Express, and SQLite.

## Features

### 3 User Roles
- **Admin** — User & teacher management, salary structure setup, system configuration, audit logs, security control
- **Accountant** — Process payroll, generate payslips, export reports (PDF/Excel), manage payment status
- **Teacher** — View profile, payslips, salary history, notifications, change password

### Key Capabilities
- Automatic salary calculation (basic + allowances − tax − NSSF − deductions)
- PDF payslip generation
- Excel & PDF report export
- Notification system
- Audit logging
- Database backup & restore
- Role-based access control with JWT authentication

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js + Express |
| Database | SQLite (via sql.js) |
| Auth | JWT + bcrypt |
| PDF | PDFKit |
| Excel | ExcelJS |
| Frontend | Vanilla HTML/CSS/JS |

## Getting Started

### Prerequisites
- Node.js v16 or higher

### Installation

```bash
# Clone the repository
git clone https://github.com/balirwaalvin/EduPay-System.git
cd EduPay-System

# Install dependencies
npm install

# (Optional) Copy and configure environment variables
cp .env.example .env

# Start the server
npm start
```

Open **http://localhost:3000** in your browser.

### Default Login

| Role | Username | Password |
|------|----------|----------|
| Admin | `admin` | `admin123` |

> **Note:** When you add teachers via the Admin panel, they automatically get a login account with a default password of `teacher123`. Teachers should change this after first login.

## Project Structure

```
├── server/
│   ├── server.js           # Express entry point
│   ├── database.js         # SQLite schema & seeding
│   ├── middleware.js        # JWT auth & role middleware
│   └── routes/
│       ├── auth.js          # Login & password change
│       ├── admin.js         # Admin API endpoints
│       ├── accountant.js    # Accountant API endpoints
│       └── teacher.js       # Teacher API endpoints
├── public/
│   ├── index.html           # Login page
│   ├── admin.html           # Admin dashboard
│   ├── accountant.html      # Accountant dashboard
│   ├── teacher.html         # Teacher portal
│   ├── css/styles.css       # Design system
│   └── js/                  # Frontend logic
├── data/                    # SQLite database (auto-created, gitignored)
└── package.json
```

## License

ISC
