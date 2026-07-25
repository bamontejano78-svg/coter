'use strict';

const config = require('../config/env');

const COOKIE_NAMES = Object.freeze({
  therapistAccess: 'coter_access',
  therapistRefresh: 'coter_refresh',
  patientAuth: 'coter_patient_auth',
});

function parseCookies(req) {
  const header = req.headers.cookie;
  if (!header) return {};
  return header.split(';').reduce((acc, part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    if (!key) return acc;
    const value = part.slice(idx + 1).trim();
    try {
      acc[key] = decodeURIComponent(value);
    } catch (e) {
      acc[key] = value;
    }
    return acc;
  }, {});
}

function cookieBaseOptions(maxAge) {
  return {
    httpOnly: true,
    secure: config.isProd,
    sameSite: 'lax',
    path: '/',
    maxAge,
  };
}

function setTherapistCookies(res, accessToken, refreshToken) {
  res.cookie(COOKIE_NAMES.therapistAccess, accessToken, cookieBaseOptions(15 * 60 * 1000));
  res.cookie(COOKIE_NAMES.therapistRefresh, refreshToken, cookieBaseOptions(config.REFRESH_TOKEN_DAYS * 86400000));
}

function clearTherapistCookies(res) {
  const opts = cookieBaseOptions(0);
  res.clearCookie(COOKIE_NAMES.therapistAccess, opts);
  res.clearCookie(COOKIE_NAMES.therapistRefresh, opts);
}

function setPatientCookie(res, authToken) {
  res.cookie(COOKIE_NAMES.patientAuth, authToken, cookieBaseOptions(config.REFRESH_TOKEN_DAYS * 86400000));
}

function clearPatientCookie(res) {
  res.clearCookie(COOKIE_NAMES.patientAuth, cookieBaseOptions(0));
}

function getCookie(req, name) {
  return parseCookies(req)[name] || null;
}

module.exports = {
  COOKIE_NAMES,
  parseCookies,
  getCookie,
  setTherapistCookies,
  clearTherapistCookies,
  setPatientCookie,
  clearPatientCookie,
};
