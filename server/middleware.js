const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'edupay_secret_key_2024';

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Access denied. No token provided.' });

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(403).json({ error: 'Invalid or expired token.' });
    }
}

function authorizeRoles(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ error: 'Access denied. Insufficient permissions.' });
        }
        next();
    };
}

function logAudit(db, userId, username, action, details, ip) {
    db.query(
        "INSERT INTO audit_log (user_id, username, action, details, ip_address) VALUES ($1, $2, $3, $4, $5)",
        [userId, username, action, details, ip || '']
    ).catch(err => console.error('Audit log error:', err));
}

module.exports = { authenticateToken, authorizeRoles, logAudit, JWT_SECRET };
