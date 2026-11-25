import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// The page loads public/voice.js as a plain script. Here the same file is run
// the CommonJS way, so the tests and the page share one copy of the rule.
const mod = { exports: {} };
new Function("module", "exports", fs.readFileSync(new URL("../public/voice.js", import.meta.url), "utf8"))(mod, mod.exports);
const { MIN_CONFIDENCE, digits, matchCode } = mod.exports;

// The rule behind voice approval, run without a browser or a microphone.
// These are transcripts in the forms browsers actually return.

const heard = (text, confidence = 0.9) => ({ text, confidence });

test("digits as heard, in the forms recognizers return", () => {
  assert.equal(digits("approve 4729"), "4729");
  assert.equal(digits("approve 4 7 2 9"), "4729");
  assert.equal(digits("approve 47 29"), "4729");
  assert.equal(digits("approve four seven two nine"), "4729");
  assert.equal(digits("approve forty seven twenty nine"), "4729");
  assert.equal(digits("four thousand seven hundred and twenty-nine"), "4729");
  assert.equal(digits("approve, code four seven two nine"), "4729");
  assert.equal(digits("double four seven"), "447");
  assert.equal(digits("approve"), "");
  assert.equal(digits(""), "");
});

test("the exact code, heard clearly, is an approval", () => {
  const m = matchCode([heard("approve four seven two nine", 0.92)], "4-7-2-9");
  assert.deepEqual(m, { matched: true, clear: true, heard: "approve four seven two nine" });
  assert.equal(matchCode([heard("4729", MIN_CONFIDENCE)], "4729").clear, true);
});

test("a misheard, missing or extra digit is never an approval", () => {
  const code = "4729";
  for (const text of ["approve", "yes", "approve it", "approve 4728", "approve 472", "approve 47290", "approve seven two nine", "4729 0"]) {
    assert.equal(matchCode([heard(text)], code).matched, false, `"${text}" matched ${code}`);
  }
  assert.equal(matchCode([heard("approve 4729")], "").matched, false, "an empty code was matched");
  assert.equal(matchCode([], code).matched, false);
});

test("the word approve alone is never an approval, however clear", () => {
  assert.equal(matchCode([heard("approve", 0.99), heard("yes approve it", 0.98)], "4729").matched, false);
});

test("the right digits heard unclearly are a match the owner must confirm", () => {
  const m = matchCode([heard("approve four seven two nine", 0.45)], "4729");
  assert.equal(m.matched, true);
  assert.equal(m.clear, false);
});

test("any confident candidate that carries the code counts", () => {
  const m = matchCode([heard("approve for seven to nine", 0.5), heard("approve 4729", 0.88)], "4729");
  assert.equal(m.clear, true);
  assert.equal(m.heard, "approve 4729");
});

test("a different pending action's code does not match", () => {
  assert.equal(matchCode([heard("approve 4729")], "1083").matched, false);
});
