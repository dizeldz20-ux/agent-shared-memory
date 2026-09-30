// A negative status: work described as built but not shipped, or waiting on someone. These
// are the status snapshots that outlive the work once a later record reports it done.
// Hebrew uses explicit letter boundaries: `\b` is ASCII-only in JavaScript and silently
// never matches between Hebrew letters. One optional prefix letter (ו/ש/ה/כ/ל/מ/ב) may be
// attached, as in "שלא נפרס".

const ENGLISH: readonly RegExp[] = [
  /\bnot (?:yet )?(?:deployed|pushed|merged|committed|live|released)\b/i,
  /\b(?:awaiting|pending|waiting (?:for|on)|needs?)\s+(?:\w+(?:'s)?\s+)?(?:approval|go-ahead|decision)\b/i,
  /\bplan only\b/i,
  /\buncommitted\b/i,
  /\bnothing (?:was )?(?:pushed|deployed|committed|built)\b/i,
];

const hebrew = (phrase: string): RegExp => new RegExp(`(?<![א-ת])[ושהכלמב]?${phrase}(?![א-ת])`, 'u');

const HEBREW: readonly RegExp[] = [
  hebrew('(?:לא|טרם) (?:נפרס|נדחף|מוזג|בוצע|נבנה)(?:ה|ו)?'),
  hebrew('(?:ממתין|ממתינה|ממתינים|מחכה|מחכים) (?:ל)?(?:אישור|הכרעה)'),
  hebrew('רק תוכנית'),
];

export function isNegativeStatus(text: string): boolean {
  return ENGLISH.some((pattern) => pattern.test(text)) || HEBREW.some((pattern) => pattern.test(text));
}
