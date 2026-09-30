import { describe, expect, it } from 'vitest';
import { isNegativeStatus } from './status-phrases.js';
import { normalizeStatus } from '../store/status.js';

describe('isNegativeStatus', () => {
  it.each([
    ['T7 is built and not deployed', true],
    ['Awaiting approval from the owner before the push', true],
    ['Plan only, nothing built', true],
    ['Deployed and verified live', false],
    ['V3 שלא נפרס עדיין', true],
    ['ממתין לאישור לפני הפריסה', true],
    ['לא נפרסה בגלל התקלה', true],
    ['נפרסה בהצלחה', false],
    ['אלא נפרס מחדש אתמול', false],
    ['רק תוכנית, בלי קוד', true],
  ])('%s → %s', (text, expected) => {
    expect(isNegativeStatus(text)).toBe(expected);
  });
});

describe('normalizeStatus', () => {
  it.each([
    ['done — all ten items shipped on 22/09', 'done'],
    ['complete', 'done'],
    ['Archived', 'retired'],
    ['ready-for-review', 'ready-for-review'],
    ['', ''],
  ])('%s → %s', (raw, expected) => {
    expect(normalizeStatus(raw)).toBe(expected);
  });
});
