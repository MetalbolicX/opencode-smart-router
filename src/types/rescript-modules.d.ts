// Hand-maintained ambient TypeScript types for ReScript-compiled modules.
// genType is out of scope; these are written by hand to match the .resi contracts.
// ReScript emits .res.mjs files; TypeScript sees them via these ambient declarations.

// ---------------------------------------------------------------------------
// Pilot (bootstrap verification module)
// ---------------------------------------------------------------------------
declare module "./Pilot.res.mjs" {
  export const add: (a: number, b: number) => number;
}

// Test smoke imports from test/smoke/pilot-smoke.ts
declare module "../../src/Pilot.res.mjs" {
  export const add: (a: number, b: number) => number;
}
