## ADDED Requirements

### Requirement: Register and retrieve commands
The `CommandRegistry` SHALL provide `register(command)` to add a command and `get(name)` to retrieve it by name, returning `undefined` when the name is not registered.

#### Scenario: Registered command is retrievable
- **WHEN** a command with name `review` is registered
- **THEN** `get('review')` SHALL return that command

#### Scenario: Unknown name returns undefined
- **WHEN** `get('does-not-exist')` is called
- **THEN** it SHALL return `undefined`

### Requirement: Register overwrites same-name command
Registering a command whose `name` matches an existing command SHALL replace the existing entry.

#### Scenario: Same name overwrites
- **WHEN** command A (name `review`) is registered, then command B (name `review`) is registered
- **THEN** `get('review')` SHALL return command B

### Requirement: List registered commands
The registry SHALL provide `list()` returning all commands in registration order, `names()` returning their names in registration order, and `has(name)` returning whether a name is registered.

#### Scenario: List preserves registration order
- **WHEN** commands `review` and `commit` are registered in that order
- **THEN** `list()` SHALL return them in that order and `names()` SHALL return `['review', 'commit']`

#### Scenario: Has reports membership
- **WHEN** `review` is registered
- **THEN** `has('review')` SHALL return `true` and `has('other')` SHALL return `false`

### Requirement: Remove and clear commands
The registry SHALL provide `remove(name)` to delete one command (returning `true` if it existed) and `clear()` to delete all commands.

#### Scenario: Remove an existing command
- **WHEN** `review` is registered and then `remove('review')` is called
- **THEN** `remove` SHALL return `true` and `get('review')` SHALL return `undefined`

#### Scenario: Remove a missing command
- **WHEN** `remove('does-not-exist')` is called
- **THEN** it SHALL return `false`

#### Scenario: Clear empties the registry
- **WHEN** two commands are registered and then `clear()` is called
- **THEN** `list()` SHALL return an empty array
