const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('../database');
const { authenticateToken, logAudit, JWT_SECRET } = require('../middleware');

// POST /api/auth/login
router.post('/login', (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Username and password are required.' });
        }

        const db = getDb();
        const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
        if (!user) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        if (!user.is_active) {
            return res.status(403).json({ error: 'Account is deactivated. Contact admin.' });
        }

        const validPassword = bcrypt.compareSync(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid username or password.' });
        }

        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, full_name: user.full_name },
            JWT_SECRET,
            { expiresIn: '8h' }
        );

        logAudit(db, user.id, user.username, 'LOGIN', 'User logged in', req.ip);

        res.json({
            token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role,
                full_name: user.full_name,
                email: user.email,
                must_change_password: user.must_change_password
            }
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error during login.' });
    }
});

// POST /api/auth/change-password
router.post('/change-password', authenticateToken, (req, res) => {
    try {
        const { current_password, new_password } = req.body;
        if (!current_password || !new_password) {
            return res.status(400).json({ error: 'Current and new passwords are required.' });
        }

        if (new_password.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters.' });
        }

        const db = getDb();
        const row = db.prepare("SELECT password FROM users WHERE id = ?").get(req.user.id);
        if (!row) {
            return res.status(404).json({ error: 'User not found.' });
        }

        if (!bcrypt.compareSync(current_password, row.password)) {
            return res.status(401).json({ error: 'Current password is incorrect.' });
        }

        const newHash = bcrypt.hashSync(new_password, 10);
        db.prepare("UPDATE users SET password = ?, must_change_password = 0, updated_at = datetime('now') WHERE id = ?")
          .run(newHash, req.user.id);

        logAudit(db, req.user.id, req.user.username, 'CHANGE_PASSWORD', 'Password changed', req.ip);

        res.json({ message: 'Password changed successfully.' });
    } catch (err) {
        console.error('Change password error:', err);
        res.status(500).json({ error: 'Server error.' });
    }
});

module.exports = router;
