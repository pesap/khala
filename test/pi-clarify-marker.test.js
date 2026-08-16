import assert from "node:assert/strict";
import test from "node:test";
import { hasClarifyMarker, stripClarifyMarker } from "../dist/extensions/pi-clarify/marker.js";

test("detects clarify markers at the start, middle, and end", () => {
	assert.equal(hasClarifyMarker("-clarify make cards smooth"), true);
	assert.equal(hasClarifyMarker("make cards smooth -clarify"), true);
	assert.equal(hasClarifyMarker("please -clarify this request"), true);
	assert.equal(hasClarifyMarker("-clarify"), true);
});

test("ignores lookalike words and normal text", () => {
	assert.equal(hasClarifyMarker("pre-clarify this later"), false);
	assert.equal(hasClarifyMarker("please clarify this request"), false);
	assert.equal(hasClarifyMarker("make cards smooth"), false);
	assert.equal(hasClarifyMarker(""), false);
});

test("strips markers and preserves the remaining prompt", () => {
	assert.equal(stripClarifyMarker("make cards smooth -clarify"), "make cards smooth");
	assert.equal(stripClarifyMarker("-clarify make cards smooth"), "make cards smooth");
	assert.equal(stripClarifyMarker("please -clarify this now"), "please this now");
	assert.equal(stripClarifyMarker("make cards smooth -clarify."), "make cards smooth.");
	assert.equal(stripClarifyMarker("-clarify"), "");
	assert.equal(stripClarifyMarker("-clarify make cards smooth -clarify"), "make cards smooth");
});
