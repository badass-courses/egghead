import { getEggheadRuntime } from "./runtime";

export function register() {
  // Validate at Next startup, not on the first side-effecting request.
  getEggheadRuntime();
}
