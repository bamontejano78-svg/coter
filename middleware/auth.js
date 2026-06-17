const jwt = require('jsonwebtoken');
const config = require('../config/env');
const logger = require('../config/logger');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Token requerido' });
  }

  const token = authHeader.split(' ')[1];
  jwt.verify(token, config.JWT_SECRET, (err, user) => {
    if (err) {
      logger.warn('Token invalido', { error: err.message });
      return res.status(403).json({ success: false, error: 'Token invalido o expirado' });
    }
    req.user = user;
    next();
  });
};

module.exports = { authenticateToken };
