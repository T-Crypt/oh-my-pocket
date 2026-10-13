// The fence text from elsewhere goes between tags for Pi: every `<` with a `/` soon after it loses its `<`, whatever
// stands between them, and a `<` that is not a closing tag keeps its own. `quoted` gives one line that cannot close
// its quotes, and `attribute` gives a value that cannot end an attribute.
import assert from "node:assert/strict";
import { test } from "node:test";
import { attribute, defang, quoted } from "../src/server/fence.ts";

const ZERO_WIDTH = "\u200b";
const VARIATION_SELECTOR = "\uFE0F";
const FORMAT_CHARACTER = "\u00ad";

test("a closing tag loses its <, whatever stands between it and the /", () => {
    assert.equal(defang("</x>"), "‹/x>");
    assert.equal(defang("< /x>"), "‹ /x>");
    assert.equal(defang(`<${ZERO_WIDTH}/x>`), `‹${ZERO_WIDTH}/x>`);
    assert.equal(defang(`<${VARIATION_SELECTOR}/x>`), `‹${VARIATION_SELECTOR}/x>`);
    assert.equal(defang(`<${FORMAT_CHARACTER}/x>`), `‹${FORMAT_CHARACTER}/x>`);
    assert.equal(defang("<\t/x>"), "‹\t/x>");
    assert.equal(defang("< \u200b \uFE0F /x>"), "‹ \u200b \uFE0F /x>");
});

test("a closing tag loses its < behind every category of invisible character the class names", () => {
    // One representative per category, 81 of them, so the 80-character branch cannot defang it and only the class
    // can: a control character, a format character, a lone surrogate, a private-use character, an unassigned code
    // point, a variation selector and its supplement, the braille blank, three Hangul fillers, the combining
    // grapheme joiner, a Khmer inherent vowel, and a Mongolian free variation selector. Narrowing the class fails.
    const hides = (character: string, what: string) => {
        const invisible = character.repeat(81);

        assert.equal(defang(`<${invisible}/x>`), `‹${invisible}/x>`, what);
    };

    hides("\u0007", "a control character");
    hides("\u00ad", "a format character");
    hides("\uD800", "a lone surrogate");
    hides("\uE000", "a private-use character");
    hides("\u0378", "an unassigned code point");
    hides("\u{E0100}", "a variation selector supplement");
    hides("\u2800", "the braille blank");
    hides("\u3164", "the Hangul filler");
    hides("\uFFA0", "the halfwidth Hangul filler");
    hides("\u034F", "the combining grapheme joiner");
    hides("\uFE00", "a variation selector");
    hides("\u115F", "the Hangul choseong filler");
    hides("\u17B4", "a Khmer inherent vowel");
    hides("\u180B", "a Mongolian free variation selector");
});

test("a closing tag with more than 80 characters between < and / is defanged only by the invisible run", () => {
    const long = `<${ZERO_WIDTH.repeat(81)}/x>`;

    assert.equal(defang(long), `‹${ZERO_WIDTH.repeat(81)}/x>`);
    assert.equal(defang(`<${ZERO_WIDTH.repeat(80)}/x>`), `‹${ZERO_WIDTH.repeat(80)}/x>`);
});

test("a < that is not a closing tag keeps its <", () => {
    assert.equal(defang("Vec<T> and <div> stay"), "Vec<T> and <div> stay");
    assert.equal(defang("<b>bold</b>"), "<b>bold‹/b>");
});

test("a < with a / within 80 characters loses its <, harmlessly", () => {
    assert.equal(defang("a < b/2"), "a ‹ b/2");
    assert.equal(defang("x < y/z"), "x ‹ y/z");
    assert.equal(defang("<"), "<");
    assert.equal(defang(""), "");
});

test("quoted text is one line, without invisible characters, and cannot close its quotes", () => {
    assert.equal(quoted("a\u200bb\u202e\u{e0041}c\nd\u2028e\u0085f"), "“abc d e f”");
    assert.equal(quoted('say "hi" now'), '“say "hi" now”');
    assert.equal(quoted("<b> and <c"), "“‹b> and ‹c”");
    assert.equal(quoted("  spaced   out  "), "“spaced out”");
    assert.equal(quoted("x".repeat(200), 120), `“${"x".repeat(119)}…”`);
    assert.equal(quoted(""), "“”");
});

test("an attribute value is one line, without quotes or angle brackets", () => {
    assert.equal(attribute('a"b<c>d'), "a b c d");
    assert.equal(attribute("x\r\ny"), "x y");
    assert.equal(attribute("  <a>  "), "a");
    assert.equal(attribute("plain"), "plain");
    assert.equal(attribute(""), "");
});
