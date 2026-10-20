# command-expansion Specification

## Purpose
TBD - created by archiving change agent-commands. Update Purpose after archive.
## Requirements
### Requirement: Positional parameter substitution
`expandTemplate(template, args)` SHALL replace `$N` placeholders (where `N` is one or more digits) with the Nth positional argument (1-indexed). When the Nth argument is missing, the placeholder SHALL be replaced with the empty string.

#### Scenario: First argument substitutes
- **WHEN** `expandTemplate('Review $1', ['tools.ts'])` is called
- **THEN** it SHALL return `Review tools.ts`

#### Scenario: Multiple positionals substitute in order
- **WHEN** `expandTemplate('$1 -> $2', ['a', 'b'])` is called
- **THEN** it SHALL return `a -> b`

#### Scenario: Missing argument becomes empty string
- **WHEN** `expandTemplate('Review $2', ['tools.ts'])` is called
- **THEN** it SHALL return `Review `

#### Scenario: Placeholder with multiple digits
- **WHEN** `expandTemplate('$10', [...ten args...])` is called with at least ten arguments
- **THEN** `$10` SHALL be replaced with the tenth argument

### Requirement: Default-value substitution
`expandTemplate` SHALL replace `${N:-default}` placeholders with the Nth positional argument when it is present and non-empty; otherwise it SHALL replace the placeholder with `default`.

#### Scenario: Present argument wins over default
- **WHEN** `expandTemplate('Focus on ${2:-style}', ['tools.ts', 'security'])` is called
- **THEN** it SHALL return `Focus on security`

#### Scenario: Missing argument uses default
- **WHEN** `expandTemplate('Focus on ${2:-style}', ['tools.ts'])` is called
- **THEN** it SHALL return `Focus on style`

#### Scenario: Empty argument uses default
- **WHEN** `expandTemplate('Focus on ${2:-style}', ['tools.ts', ''])` is called
- **THEN** it SHALL return `Focus on style`

#### Scenario: Empty default is allowed
- **WHEN** `expandTemplate('x${1:-}y', [])` is called
- **THEN** it SHALL return `xy`

### Requirement: Default placeholders resolve before plain placeholders
Substitution SHALL process `${N:-default}` placeholders before `$N` placeholders, so that a default value containing `$M` is itself subject to the later `$N` pass.

#### Scenario: Default referencing another argument
- **WHEN** `expandTemplate('${1:-$2}', ['', 'fallback'])` is called
- **THEN** it SHALL return `fallback`

### Requirement: No other shell syntax is interpreted
Only `$N` and `${N:-default}` SHALL be substituted. Other constructs such as `$@`, `$*`, `$0`, `${N-default}`, and `${N/pattern/replacement}` SHALL be left as literal text.

#### Scenario: Unsupported syntax passes through
- **WHEN** `expandTemplate('use $@ and ${1-default}', [])` is called
- **THEN** it SHALL return `use $@ and ${1-default}` unchanged

