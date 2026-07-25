const {
  COOKIE_NAMES,
  getCookie,
  parseCookies,
  setTherapistCookies,
  clearTherapistCookies,
  setPatientCookie,
  clearPatientCookie,
} = require('../utils/cookies');

function mockRes() {
  return {
    cookies: [],
    cleared: [],
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
    },
    clearCookie(name, options) {
      this.cleared.push({ name, options });
    },
  };
}

describe('Cookie helpers', () => {
  test('parseCookies decodes simple cookie header', () => {
    const req = { headers: { cookie: 'coter_access=abc%20123; theme=light' } };
    expect(parseCookies(req)).toEqual({ coter_access: 'abc 123', theme: 'light' });
    expect(getCookie(req, COOKIE_NAMES.therapistAccess)).toBe('abc 123');
  });

  test('setTherapistCookies writes HttpOnly access and refresh cookies', () => {
    const res = mockRes();
    setTherapistCookies(res, 'access-token', 'refresh-token');

    expect(res.cookies.map(c => c.name)).toEqual([
      COOKIE_NAMES.therapistAccess,
      COOKIE_NAMES.therapistRefresh,
    ]);
    expect(res.cookies[0].value).toBe('access-token');
    expect(res.cookies[1].value).toBe('refresh-token');
    expect(res.cookies[0].options.httpOnly).toBe(true);
    expect(res.cookies[0].options.sameSite).toBe('lax');
  });

  test('clearTherapistCookies clears both therapist cookies', () => {
    const res = mockRes();
    clearTherapistCookies(res);
    expect(res.cleared.map(c => c.name)).toEqual([
      COOKIE_NAMES.therapistAccess,
      COOKIE_NAMES.therapistRefresh,
    ]);
  });

  test('patient cookie can be set and cleared', () => {
    const res = mockRes();
    setPatientCookie(res, 'patient-token');
    clearPatientCookie(res);

    expect(res.cookies[0].name).toBe(COOKIE_NAMES.patientAuth);
    expect(res.cookies[0].value).toBe('patient-token');
    expect(res.cookies[0].options.httpOnly).toBe(true);
    expect(res.cleared[0].name).toBe(COOKIE_NAMES.patientAuth);
  });
});
