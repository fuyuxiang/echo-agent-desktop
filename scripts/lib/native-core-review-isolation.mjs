// Compatibility catalogs live in the owned review compat-home. Do not inspect
// real user settings to manufacture a revocation list. Ordinary app launches
// retain compatibility discovery; acceptance isolation is enforced by Runtime.
export function readonlyCompatibilitySourceRevocations() { return []; }
