# What DATUM contains, counted

<!--
  GENERATED. Do not edit by hand.
  Run `npm --prefix ui run facts` to regenerate; CI fails if this file is out of date.

  Every figure any document in this repository states about the product is derived here, from
  the code itself. Nothing in this file is maintained by a person.
-->

Counted on 2026-08-21, from the source as committed.

## The product

| | Count |
|---|---|
| Parametric archetypes | 27 |
| Assembly recipes | 8 |
| Sketch constraint types | 17 |
| Modelling features | 24 |
| TypeScript files | 263 |
| Lines of product code | 63,299 |

## The evidence

| | Count |
|---|---|
| Tests | 2,248 |
| Test files | 111 |
| Lines of test code | 25,154 |
| Benchmark cases | 22 |

Tests are counted by the runner, not by grepping for `it(` — `it.each` is one call and many
tests, and a skipped test is a line that never runs.

The benchmark is separate from the test suite on purpose. A test asserts that a function does
what it was written to do; a benchmark case asserts that a *request* produces the right object,
against a figure defensible without running the product — a physical invariant, or a published
standard. Cases that assert a **refusal** are counted here too: declining a request nothing can
build correctly is a result, and it is measured like any other.
