import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const studioSource = readFileSync(resolve(__dirname, '../AIStrategyStudio.jsx'), 'utf8');
const backendSource = readFileSync(resolve(__dirname, '../../../../backend/main.py'), 'utf8');

test('failed Studio generations remain recoverable with the original objective', () => {
    assert.match(studioSource, /setGenerationError\(error\)/);
    assert.match(studioSource, /> Generate Again\s*</);
    assert.match(studioSource, /onClick=\{startForge\}/);
    assert.match(studioSource, /Review &amp; Edit Candidate/);
    assert.match(studioSource, /choose a stronger coding model in Setup/);
    assert.match(studioSource, /Fix validation errors before saving/);
    assert.match(backendSource, /invalid_candidates=invalid_candidates/);
    assert.equal(
        studioSource.includes("setStep(1);\n        }\n    }, [activeTaskId, generationStream]"),
        false,
        'stream failures should not discard the Forge failure screen',
    );
});

test('generation prompt asks the model to reuse valid structure and check syntax', () => {
    assert.match(backendSource, /Reuse the standard module\/class\/params\/__init__\/next structure/);
    assert.match(backendSource, /final syntax review equivalent to `ast\.parse\(code\)`/);
    assert.match(backendSource, /Return ONLY a strict JSON object/);
});

test('Studio normalizes dataset bar counts and caps learning depth to available bars', () => {
    assert.match(studioSource, /res\.data\.total_bars \?\? res\.data\.rows \?\? 0/);
    assert.match(studioSource, /const maxLookback = availableBars >= 20 \? Math\.min\(500, availableBars\) : 20/);
    assert.match(studioSource, /\{lookback\} of \{availableBars \|\| '\?'\} Bars/);
    assert.match(backendSource, /"total_bars": total_bars/);
});

test('pattern analysis reports session and volume coverage to the model', () => {
    assert.match(backendSource, /Session Coverage: \{session_context\}/);
    assert.match(backendSource, /non-zero coverage=\{volume_coverage_pct:\.1f\}%/);
    assert.match(backendSource, /true_range = pd\.concat/);
});

test('running Studio generation can be cancelled without losing the objective', () => {
    assert.match(studioSource, /Stop Generation/);
    assert.match(studioSource, /\/ai\/generate\/\$\{taskId\}\/cancel/);
    assert.match(studioSource, /request already in flight may still incur token usage/);
    assert.match(backendSource, /@app\.post\("\/api\/backtest\/ai\/generate\/\{task_id\}\/cancel"\)/);
    assert.match(backendSource, /ensure_strategy_generation_active\(task_id\)/);
    assert.match(backendSource, /status="cancelled"/);
});

test('Studio supports backward navigation, new jobs, and one-click result backtests', () => {
    assert.match(studioSource, /Back to Objective/);
    assert.match(studioSource, /> New Job\s*</);
    assert.match(studioSource, /const startNewJob = async/);
    assert.match(studioSource, /const runQuickBacktest = async/);
    assert.match(studioSource, /strategies: \[strat\.name\]/);
    assert.match(studioSource, /Quick Backtest:/);
    assert.match(studioSource, /onClick=\{\(\) => runQuickBacktest\(strat, idx\)\}/);
    assert.match(studioSource, /if \(!await saveStrategy\(strat, idx, true\)\)/);
});

test('Web Research mode uses bounded untrusted public research with attribution', () => {
    assert.match(studioSource, /setMode\('web_research'\)/);
    assert.match(studioSource, /Research Web/);
    assert.match(studioSource, /Public Research Sources/);
    assert.match(studioSource, /rel="noreferrer"/);
    assert.match(backendSource, /async def research_public_strategy_ideas/);
    assert.match(backendSource, /UNTRUSTED PUBLIC WEB RESEARCH/);
    assert.match(backendSource, /Do not copy source code or repeat unsupported performance claims/);
    assert.match(backendSource, /research_max_sources/);
    assert.match(backendSource, /sources\[:read_pages\]/);
    assert.match(backendSource, /paper_domains/);
    assert.match(backendSource, /data\["research_sources"\] = web_research_sources/);
});

test('Studio can compare all strategies and revise zero-trade trials', () => {
    assert.match(studioSource, /const runComparisonBacktest = async/);
    assert.match(studioSource, /Backtest All/);
    assert.match(studioSource, /Strategy Comparison/);
    assert.match(studioSource, /Trial found 0 trades/);
    assert.match(studioSource, /Improve with AI/);
    assert.match(backendSource, /\/api\/backtest\/strategies\/improve-code/);
});
