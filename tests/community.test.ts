// The parts of the community layer that are worth testing without a network:
// the validation that mirrors the database's CHECK constraints, and the
// presentation rules that decide what about a member becomes public.
import { describe, expect, it } from 'vitest';
import {
  LICENSE, LICENSE_NAME, HANDLE_RE, MIN_AGE, PASSWORD_MIN, TERMS_VERSION,
  ageOn, byline, checkAge, configured, flag,
  isRecoveryLink, validateDesign, validatePassword, validateProfile,
} from '../src/community';

const ok = { handle: 'ada_k', display_name: 'Ada K.', country: 'GH', school: null, show_school: false };
// Local midday, matching how checkAge builds a date of birth (local midnight).
// Mixing the two is how an off-by-one hides: '2011-08-02' parses as UTC
// midnight, which is the day before in any timezone west of Greenwich.
const NOW = new Date('2026-08-01T12:00:00');
const dob = (iso: string) => new Date(iso + 'T00:00:00');

describe('configuration', () => {
  it('is off when no credentials are built in, which is a supported state', () => {
    // The test build has no VITE_SUPABASE_* set. Nothing here should throw —
    // an unconfigured Volta is a working offline editor, not a broken app.
    expect(configured).toBe(false);
  });
});

describe('profile validation', () => {
  it('accepts a well-formed profile', () => {
    expect(validateProfile(ok)).toBeNull();
  });

  it('mirrors the handle constraint in schema.sql', () => {
    for (const good of ['ada_k', 'abc', 'a_1', 'x'.repeat(20)]) {
      expect(HANDLE_RE.test(good), good).toBe(true);
    }
    for (const bad of ['ab', 'x'.repeat(21), 'Ada', 'ada k', 'ada-k', 'adá', '']) {
      expect(HANDLE_RE.test(bad), bad).toBe(false);
      expect(validateProfile({ ...ok, handle: bad })).toMatch(/handle/i);
    }
  });

  it('rejects an empty or over-long display name', () => {
    expect(validateProfile({ ...ok, display_name: '   ' })).toMatch(/display name/i);
    expect(validateProfile({ ...ok, display_name: 'x'.repeat(41) })).toMatch(/display name/i);
    expect(validateProfile({ ...ok, display_name: 'x'.repeat(40) })).toBeNull();
  });

  it('requires a two-letter country code, but not a country', () => {
    expect(validateProfile({ ...ok, country: null })).toBeNull();
    expect(validateProfile({ ...ok, country: 'Ghana' })).toMatch(/country/i);
    expect(validateProfile({ ...ok, country: 'gh' })).toMatch(/country/i);
  });

  it('will not publish an empty school label', () => {
    // Ticking "show my school" with nothing in the box would put a blank
    // separator on every card the member publishes.
    expect(validateProfile({ ...ok, show_school: true, school: null })).toMatch(/school/i);
    expect(validateProfile({ ...ok, show_school: true, school: '  ' })).toMatch(/school/i);
    expect(validateProfile({ ...ok, show_school: true, school: 'Accra Academy' })).toBeNull();
  });
});

describe('design validation', () => {
  it('requires a title within the column limit', () => {
    expect(validateDesign({ title: 'RC low-pass' })).toBeNull();
    expect(validateDesign({ title: '   ' })).toMatch(/title/i);
    expect(validateDesign({ title: 'x'.repeat(81) })).toMatch(/title/i);
    expect(validateDesign({ title: 'x'.repeat(80) })).toBeNull();
  });

  it('caps the description', () => {
    expect(validateDesign({ title: 'ok', description: 'x'.repeat(2000) })).toBeNull();
    expect(validateDesign({ title: 'ok', description: 'x'.repeat(2001) })).toMatch(/description/i);
  });
});

describe('password rules', () => {
  it('holds the floor above Supabase\'s own', () => {
    // Supabase accepts 6. Telling a member "at least 8" before they type is
    // kinder than a server error after they have chosen something they liked.
    expect(PASSWORD_MIN).toBeGreaterThanOrEqual(8);
    expect(validatePassword('x'.repeat(PASSWORD_MIN))).toBeNull();
    expect(validatePassword('x'.repeat(PASSWORD_MIN - 1))).toMatch(/8 characters/);
    expect(validatePassword('')).toMatch(/password/i);
  });
});

describe('recovery links', () => {
  it('recognises the fragment a reset email comes back with', () => {
    expect(isRecoveryLink('#access_token=abc&type=recovery&expires_in=3600')).toBe(true);
    expect(isRecoveryLink('#type=recovery')).toBe(true);
    expect(isRecoveryLink('#refresh_token=x&type=recovery')).toBe(true);
  });

  it('does not mistake a shared circuit for one', () => {
    // Both live in the fragment. A share link that was ever read as a recovery
    // link would put a password box in front of someone opening a circuit.
    expect(isRecoveryLink('#c=N4IgLgngDgpiBcIYFsCGBrABAZgSwDYCmAtAMYD2ARgE4CuA')).toBe(false);
    expect(isRecoveryLink('')).toBe(false);
    expect(isRecoveryLink('#')).toBe(false);
    expect(isRecoveryLink('#type=signup')).toBe(false);
    // The token name has to be the whole parameter, not a substring of one.
    expect(isRecoveryLink('#c=xxtype=recoveryxx')).toBe(false);
  });
});

describe('the licence every design carries', () => {
  it('is CC BY-SA 4.0, matching the schema default and its CHECK', () => {
    expect(LICENSE).toBe('CC-BY-SA-4.0');
    expect(LICENSE_NAME).toBe('CC BY-SA 4.0');
  });
});

describe('byline', () => {
  it('credits the member and shows their country as a flag', () => {
    expect(byline({ display_name: 'Ada K.', country: 'GH', school: null }))
      .toBe('Ada K. · 🇬🇭');
  });

  it('omits a school the member has not chosen to show', () => {
    // The gallery view nulls `school` unless show_school is set, so a card can
    // only ever render what its author opted into.
    expect(byline({ display_name: 'Ada K.', country: 'GH', school: null }))
      .not.toMatch(/academy/i);
    expect(byline({ display_name: 'Ada K.', country: 'GH', school: 'Accra Academy' }))
      .toBe('Ada K. · Accra Academy · 🇬🇭');
  });

  it('degrades to just a name when nothing else is set', () => {
    expect(byline({ display_name: 'Ada K.', country: null, school: null })).toBe('Ada K.');
  });
});

describe('flag', () => {
  it('maps ISO codes to regional-indicator pairs', () => {
    expect(flag('GH')).toBe('🇬🇭');
    expect(flag('BR')).toBe('🇧🇷');
    expect(flag('JP')).toBe('🇯🇵');
  });

  it('returns nothing for anything that is not a code', () => {
    for (const bad of ['', 'g', 'gh', 'GHA', '12']) expect(flag(bad)).toBe('');
  });
});

describe('the age screen', () => {
  it('counts whole years, and does not round a birthday up', () => {
    // Fifteen tomorrow is fourteen today. Off-by-one here is the difference
    // between a gate and a formality.
    expect(ageOn(dob('2011-08-01'), NOW)).toBe(15);
    expect(ageOn(dob('2011-08-02'), NOW)).toBe(14);
    expect(ageOn(dob('2011-07-31'), NOW)).toBe(15);
    // Across a year boundary, where the month arithmetic is easiest to get wrong.
    expect(ageOn(dob('2011-12-31'), new Date('2026-01-01T12:00:00'))).toBe(14);
  });

  it(`lets ${MIN_AGE} and over through`, () => {
    expect(checkAge('2011-08-01', NOW)).toBeNull();      // exactly 15 today
    expect(checkAge('1990-01-01', NOW)).toBeNull();
  });

  it('turns younger members away, and says the editor is still theirs', () => {
    const why = checkAge('2011-08-02', NOW);             // 15 tomorrow
    expect(why).toMatch(new RegExp(`${MIN_AGE} and over`));
    expect(why, 'refusing an account must not read as refusing the app')
      .toMatch(/editor.*without an account/i);
  });

  it('rejects nonsense rather than guessing', () => {
    expect(checkAge('', NOW)).toMatch(/date of birth/i);
    expect(checkAge('not-a-date', NOW)).toMatch(/does not look right/i);
    expect(checkAge('2030-01-01', NOW)).toMatch(/future/i);
    expect(checkAge('1850-01-01', NOW)).toMatch(/does not look right/i);
  });
});

describe('consent', () => {
  it('records which terms were accepted, not merely that some were', () => {
    // A boolean cannot answer "did they agree to THESE terms", which is the
    // only question worth being able to answer later.
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('will not save a profile that has not been through both gates', () => {
    expect(validateProfile({ ...ok, age_confirmed: false })).toMatch(/date of birth/i);
    expect(validateProfile({ ...ok, terms_version: null })).toMatch(/terms/i);
    expect(validateProfile({ ...ok, age_confirmed: true, terms_version: TERMS_VERSION }))
      .toBeNull();
  });
});
