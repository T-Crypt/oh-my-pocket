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
