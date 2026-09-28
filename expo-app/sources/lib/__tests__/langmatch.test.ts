import { describe, expect, it } from 'vitest';
import { matchBaseLang } from '../langmatch';

const SUPPORTED = ['en', 'zh', 'de', 'fr', 'es', 'ja', 'hi', 'ar', 'pt', 'id', 'ru', 'ko'];

describe('matchBaseLang', () => {
  it('returns the first supported tag in preference order', () => {
    expect(matchBaseLang(['de-DE', 'en-US'], SUPPORTED)).toBe('de');
    expect(matchBaseLang(['fr-FR', 'de-DE'], SUPPORTED)).toBe('fr');
  });

  it('strips region/script suffixes (zh-CN → zh, de-AT → de)', () => {
    expect(matchBaseLang(['zh-CN'], SUPPORTED)).toBe('zh');
    expect(matchBaseLang(['de-AT'], SUPPORTED)).toBe('de');
    expect(matchBaseLang(['pt-BR'], SUPPORTED)).toBe('pt');
  });

  it('is case-insensitive', () => {
    expect(matchBaseLang(['EN', 'de'], SUPPORTED)).toBe('en');
    expect(matchBaseLang(['De-DE'], SUPPORTED)).toBe('de');
  });

  it('falls through unsupported tags and returns null when none ship', () => {
    expect(matchBaseLang(['sv-SE', 'nl-NL', 'de-DE'], SUPPORTED)).toBe('de');
    expect(matchBaseLang(['sv-SE', 'nl-NL'], SUPPORTED)).toBeNull();
    expect(matchBaseLang([], SUPPORTED)).toBeNull();
  });

  it('prefers navigator.languages over navigator.language order', () => {
    expect(matchBaseLang(['zh-TW', 'en-US', 'en'], SUPPORTED)).toBe('zh');
  });
});
