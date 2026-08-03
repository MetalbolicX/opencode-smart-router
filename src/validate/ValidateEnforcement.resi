// ---------------------------------------------------------------------------
// ValidateEnforcement.resi - Public interface for ENFORCEMENT validators.
//
// Ports the ENFORCEMENT section from src/router/config-validate.ts:
//   - validateEnforcement: top-level dispatcher
//   - validateEnforcementMode: enforcement.mode in {off,advisory,enforced}
//   - validateEnforcementVerify: enforcement.verify block validation
//   - validateEnforcementEscalate: enforcement.escalate block validation
//   - validateEnforcementPerTier: enforcement.perTier block validation
//   - validateEnforcementGuard: enforcement.guard block validation
//
// ABI boundary: input is Js.Dict.t<Js.Json.t> (maps to TS Record<string, unknown>).
// All validators return unit and throw with a "tiers.json:" prefix on error.
// ---------------------------------------------------------------------------

// Top-level enforcement dispatcher.
// Throws if enforcement is present but not a plain object.
let validateEnforcement: dict<JSON.t> => unit

// Validate enforcement.mode in {off, advisory, enforced}.
// Silently skips if mode is absent (field is optional).
let validateEnforcementMode: dict<JSON.t> => unit

// Validate enforcement.verify block (optional).
// Permissive: non-object verify values are silently ignored.
// Validates: require in {never,whenDoDPresent,always}, graderPolicy in {atLeastProducerTier}.
let validateEnforcementVerify: dict<JSON.t> => unit

// Validate enforcement.escalate block (optional).
// Permissive: non-object escalate values are silently ignored.
// Validates: ladder (array of strings), maxAttemptsPerTier (integer >= 0),
//   maxTotalAttempts (integer >= 1), floorTier (string | null).
let validateEnforcementEscalate: dict<JSON.t> => unit

// Validate enforcement.perTier block (optional).
// Permissive: non-object perTier values are silently ignored.
// Validates each tier value in {off, advisory, enforced}.
let validateEnforcementPerTier: dict<JSON.t> => unit

// Validate enforcement.guard block (optional).
// Permissive: non-object guard values are silently ignored.
// Validates: budget (number >= 1), blockScriptWrites (boolean).
let validateEnforcementGuard: dict<JSON.t> => unit

// Validate enforcement.escalate.costCeiling block (optional).
// Permissive: non-object costCeiling values are silently ignored.
// Validates: multiple (number > 0) when present.
let validateEscalateCostCeiling: dict<JSON.t> => unit
