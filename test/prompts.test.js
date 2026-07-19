const { test, describe } = require('node:test');
const assert = require('node:assert');

const { getSystemPrompt, profilePrompts } = require('../src/utils/prompts');

// Regression guard: each profile's question-type routing is what makes answers
// land in the right format (code -> bullets+complexity+code block, behavioral
// -> STAR prose, etc). A future edit that silently drops one of these headers
// would degrade answer quality without any test failing elsewhere.
const EXPECTED_HEADERS = {
    interview: ['Coding / DSA', 'System design', 'Behavioral', 'Conceptual / definition', 'About-you / fit'],
    sales: ['Objection', 'Product / feature question', 'Pricing / commercial', 'Competitive comparison', 'Closing / next steps'],
    meeting: ['Status update', 'Decision / approval request', 'Technical / detail question', 'Action items / next steps'],
    presentation: ['Slide / data clarification', 'Strategic / vision question', 'Pushback / objection', 'Detail / technical question'],
    negotiation: ['Price objection', 'Terms / scope pushback', 'Competitive leverage', 'Closing / urgency'],
};

describe('profilePrompts question-type routing', () => {
    for (const [profile, headers] of Object.entries(EXPECTED_HEADERS)) {
        test(`${profile} prompt includes all its question-type headers`, () => {
            const prompt = getSystemPrompt(profile, 'sample context', true);
            for (const header of headers) {
                assert.ok(prompt.includes(header), `Expected "${profile}" prompt to mention question type "${header}"`);
            }
        });
    }

    test('exam profile keeps its answer/justification structure', () => {
        const prompt = getSystemPrompt('exam', 'sample context', true);
        assert.ok(prompt.includes('Answer'));
        assert.ok(prompt.includes('Why'));
    });

    test('unknown profile falls back to interview', () => {
        const prompt = getSystemPrompt('not-a-real-profile', 'ctx', true);
        assert.strictEqual(prompt, getSystemPrompt('interview', 'ctx', true));
    });
});

describe('buildSystemPrompt assembly', () => {
    test('includes user-provided context verbatim', () => {
        const prompt = getSystemPrompt('interview', 'I have 5 years of Rust experience.', true);
        assert.ok(prompt.includes('I have 5 years of Rust experience.'));
    });

    test('omits search usage section when Google Search is disabled', () => {
        const withSearch = getSystemPrompt('interview', 'ctx', true);
        const withoutSearch = getSystemPrompt('interview', 'ctx', false);
        assert.ok(withSearch.includes('SEARCH TOOL USAGE'));
        assert.ok(!withoutSearch.includes('SEARCH TOOL USAGE'));
        assert.ok(withoutSearch.length < withSearch.length);
    });

    test('every profile is present in profilePrompts', () => {
        for (const profile of ['interview', 'sales', 'meeting', 'presentation', 'negotiation', 'exam']) {
            assert.ok(profilePrompts[profile], `Missing profilePrompts entry for "${profile}"`);
            assert.ok(profilePrompts[profile].intro);
            assert.ok(profilePrompts[profile].formatRequirements);
            assert.ok(profilePrompts[profile].outputInstructions);
        }
    });
});
