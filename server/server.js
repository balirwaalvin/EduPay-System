const express = require('express');
const path = require('path');
const cors = require('cors');
const { initDatabase } = require('./database');

const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const accountantRoutes = require('./routes/accountant');
const teacherRoutes = require('./routes/teacher');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/accountant', accountantRoutes);
app.use('/api/teacher', teacherRoutes);

// SPA-style fallback — serve HTML files
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'admin.html')));
app.get('/accountant', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'accountant.html')));
app.get('/teacher-portal', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'teacher.html')));

// Start server
function start() {
    try {
        initDatabase();
        app.listen(PORT, () => {
            console.log(`\n  ╔══════════════════════════════════════════╗`);
            console.log(`  ║   EduPay - School Payroll System          ║`);
            console.log(`  ║   Running on http://localhost:${PORT}        ║`);
            console.log(`  ║   Default login: admin / admin123         ║`);
            console.log(`  ╚══════════════════════════════════════════╝\n`);
        });
    } catch (err) {
        console.error('Failed to start server:', err);
        process.exit(1);
    }
}

start();
