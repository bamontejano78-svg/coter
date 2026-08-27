process.env.ENCRYPTION_KEY = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';

const {
  encrypt,
  decrypt,
  decryptCheckIns,
  decryptMessages,
  decryptAssignments,
  decryptClinicalNotes,
  decryptClinicalSessions,
} = require('../utils/encryption');

describe('Encryption', () => {
  test('encrypts and decrypts text', () => {
    const text = 'This is a secret message';
    const encrypted = encrypt(text);
    expect(encrypted).not.toBe(text);
    expect(encrypted).toContain(':');

    const decrypted = decrypt(encrypted);
    expect(decrypted).toBe(text);
  });

  test('decrypts legacy unencrypted text', () => {
    const text = 'Plain text from old DB';
    const result = decrypt(text);
    expect(result).toBe(text);
  });

  test('handles empty text', () => {
    expect(encrypt('')).toBe('');
    expect(decrypt('')).toBe('');
  });

  test('decryptCheckIns handles array', () => {
    const checkIns = [
      { id: '1', thoughts: 'test thought', mood: 5 },
    ];
    const encrypted = checkIns.map(c => ({ ...c, thoughts: encrypt(c.thoughts) }));
    const decrypted = decryptCheckIns(encrypted);
    expect(decrypted[0].thoughts).toBe('test thought');
  });

  test('decryptCheckIns handles empty array', () => {
    expect(decryptCheckIns([])).toEqual([]);
    expect(decryptCheckIns(null)).toBe(null);
  });

  test('decryptMessages handles array', () => {
    const msgs = [{ id: '1', message: 'hello' }];
    const encrypted = msgs.map(m => ({ ...m, message: encrypt(m.message) }));
    const decrypted = decryptMessages(encrypted);
    expect(decrypted[0].message).toBe('hello');
  });

  test('decryptAssignments handles array', () => {
    const assignments = [{ id: '1', instructions: 'do this' }];
    const encrypted = assignments.map(a => ({ ...a, instructions: encrypt(a.instructions) }));
    const decrypted = decryptAssignments(encrypted);
    expect(decrypted[0].instructions).toBe('do this');
  });

  test('decryptClinicalNotes handles SOAP fields', () => {
    const notes = [{
      id: '1',
      subjective: encrypt('Paciente refiere ansiedad intensa'),
      objective: encrypt('Respiracion agitada'),
      assessment: encrypt('Crisis de panico probable'),
      plan: encrypt('Practicar respiracion diafragmatica'),
    }];
    const decrypted = decryptClinicalNotes(notes);
    expect(decrypted[0].subjective).toBe('Paciente refiere ansiedad intensa');
    expect(decrypted[0].objective).toBe('Respiracion agitada');
    expect(decrypted[0].assessment).toBe('Crisis de panico probable');
    expect(decrypted[0].plan).toBe('Practicar respiracion diafragmatica');
  });

  test('decryptClinicalSessions handles notes_summary and embedded notes', () => {
    const sessions = [{
      id: '1',
      notes_summary: encrypt('Resumen clinico sensible'),
      notes: [{ id: 'n1', subjective: encrypt('Subjetivo sensible') }],
    }];
    const decrypted = decryptClinicalSessions(sessions);
    expect(decrypted[0].notes_summary).toBe('Resumen clinico sensible');
    expect(decrypted[0].notes[0].subjective).toBe('Subjetivo sensible');
  });
});
