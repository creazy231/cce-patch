// Text the screens show that comes from the Mac or a pairing link: what could make it render as something it isn't.

/** Control characters, bidi overrides and invisible marks. */
export const INVISIBLE = /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁯﻿]/g;

/** Whether `text` holds any of them (`search` ignores the regex's `lastIndex`, so this is safe to call again). */
export const hasInvisible = (text: string): boolean => text.search(INVISIBLE) !== -1;
