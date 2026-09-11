import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CalculatorError, evaluateExpression } from '../src/tools/calculator.ts';

test('evaluates the four basic operations with precedence', () => {
  assert.equal(evaluateExpression('2 + 3 * 4'), 14);
  assert.equal(evaluateExpression('(2 + 3) * 4'), 20);
  assert.equal(evaluateExpression('10 - 4 - 3'), 3);
  assert.equal(evaluateExpression('(17 * 3 + 4) / 5'), 11);
});

test('supports unary minus and plus', () => {
  assert.equal(evaluateExpression('-5 + 3'), -2);
  assert.equal(evaluateExpression('--5'), 5);
  assert.equal(evaluateExpression('+7'), 7);
  assert.equal(evaluateExpression('3 * -2'), -6);
});

test('treats ^ and ** as right-associative power', () => {
  assert.equal(evaluateExpression('2 ^ 10'), 1024);
  assert.equal(evaluateExpression('2 ** 10'), 1024);
  assert.equal(evaluateExpression('2 ^ 3 ^ 2'), 512);
  assert.equal(evaluateExpression('2 ^ -1'), 0.5);
});

test('supports modulo', () => {
  assert.equal(evaluateExpression('10 % 3'), 1);
});

test('supports constants', () => {
  assert.equal(evaluateExpression('pi'), Math.PI);
  assert.equal(evaluateExpression('tau'), Math.PI * 2);
  assert.equal(evaluateExpression('e'), Math.E);
});

test('supports functions including variadic and nested calls', () => {
  assert.equal(evaluateExpression('sqrt(16)'), 4);
  assert.equal(evaluateExpression('abs(-3)'), 3);
  assert.equal(evaluateExpression('round(2.6)'), 3);
  assert.equal(evaluateExpression('floor(2.9)'), 2);
  assert.equal(evaluateExpression('ceil(2.1)'), 3);
  assert.equal(evaluateExpression('min(3, 1, 2)'), 1);
  assert.equal(evaluateExpression('max(3, 1, 2)'), 3);
  assert.equal(evaluateExpression('pow(2, 8)'), 256);
  assert.equal(evaluateExpression('hypot(3, 4)'), 5);
  assert.equal(evaluateExpression('sqrt(9) + abs(-1)'), 4);
  assert.equal(evaluateExpression('log(8, 2)'), 3);
});

test('parses scientific notation and bare decimal points', () => {
  assert.equal(evaluateExpression('1e3'), 1000);
  assert.equal(evaluateExpression('1.5e-2'), 0.015);
  assert.equal(evaluateExpression('.5 + .5'), 1);
});

test('ignores surrounding whitespace', () => {
  assert.equal(evaluateExpression('  1 +\t2 \n'), 3);
});

test('rejects division by zero with a clear message', () => {
  assert.throws(() => evaluateExpression('1 / 0'), CalculatorError);
  assert.throws(() => evaluateExpression('1 % 0'), /Modulo by zero/);
});

test('rejects unknown identifiers and functions', () => {
  assert.throws(() => evaluateExpression('foo'), /Unknown identifier "foo"/);
  assert.throws(() => evaluateExpression('nope(1)'), /Unknown function "nope"/);
});

test('rejects malformed expressions', () => {
  assert.throws(() => evaluateExpression(''), /Empty expression/);
  assert.throws(() => evaluateExpression('1 +'), /Unexpected end of expression/);
  assert.throws(() => evaluateExpression('(1 + 2'), /Expected "\)"/);
  assert.throws(() => evaluateExpression('1 2'), /Unexpected "2"/);
  assert.throws(() => evaluateExpression('1 + * 2'), /Unexpected "\*"/);
});

test('rejects wrong argument counts', () => {
  assert.throws(() => evaluateExpression('pow(2)'), /expects 2 argument\(s\), received 1/);
  assert.throws(() => evaluateExpression('min()'), /expects at least 1/);
});

test('refuses characters that could form code', () => {
  // The evaluator must never be a code-execution primitive.
  for (const hostile of [
    'process.exit(1)',
    'a; b',
    '1 + "x"',
    'globalThis',
    'require("fs")',
    '[]',
    '{a:1}',
    '1 === 1',
  ]) {
    assert.throws(
      () => evaluateExpression(hostile),
      CalculatorError,
      `expected "${hostile}" to be rejected`,
    );
  }
});

test('rejects an expression that is too long', () => {
  assert.throws(() => evaluateExpression('1+'.repeat(6000) + '1'), /Expression too long/);
});
