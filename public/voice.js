// Voice-approval matching. Loaded by the page (/voice.js) and by the tests,
// so the rule that decides whether a spoken sentence counts as an approval
// runs outside the browser too.
//
// The rule: the digits heard must equal the one-time code exactly, and the
// recognition must be confident. The word "approve" is not required and never
// enough. Anything else — a misheard digit, extra digits, no digits — is not
// an approval.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VoiceApproval = factory();
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // A transcript is considered clear at or above this confidence.
  const MIN_CONFIDENCE = 0.7;

  const NUMBER = {
    zero: 0, oh: 0, o: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
    eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
    eighty: 80, ninety: 90,
  };

  // Digits as heard: "four seven two nine", "forty seven twenty nine", "47 29"
  // and "4729" all read as 4729. Words that are not numbers ("approve",
  // "code", "hundred") are ignored.
  function digits(s) {
    const tokens = String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (/^\d+$/.test(t)) {
        out.push(...t);
        continue;
      }
      if (t === "double") {
        // "double four" is 4, 4.
        const next = tokens[i + 1];
        const d = /^\d$/.test(next) ? Number(next) : NUMBER[next];
        if (d >= 0 && d <= 9) {
          out.push(String(d), String(d));
          i += 1;
        }
        continue;
      }
      const n = NUMBER[t];
      if (n === undefined) continue;
      if (n >= 20 && n % 10 === 0) {
        // "forty seven" is 47.
        out.push(String(n)[0]);
        const unit = NUMBER[tokens[i + 1]];
        if (unit >= 1 && unit <= 9) {
          out.push(String(unit));
          i += 1;
        }
        continue;
      }
      out.push(...String(n));
    }
    return out.join("");
  }

  // alternatives: the recognizer's candidates, [{ text, confidence }].
  // Returns { matched: false } or { matched: true, clear, heard }.
  function matchCode(alternatives, code) {
    const want = String(code ?? "").replace(/\D/g, "");
    if (!want) return { matched: false };
    const hit = alternatives.find((a) => digits(a.text) === want);
    if (!hit) return { matched: false };
    return { matched: true, clear: (hit.confidence || 0) >= MIN_CONFIDENCE, heard: String(hit.text).trim() };
  }

  return { MIN_CONFIDENCE, digits, matchCode };
});
