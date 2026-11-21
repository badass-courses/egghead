/** Newly issued tokens expire after 30 days. Legacy NULL expiries remain unbounded. */
export const DEVICE_ACCESS_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** Device grants have ten minutes to be approved and exchanged, including after approval. */
export const DEVICE_GRANT_TTL_SECONDS = 10 * 60;
/** Retains the flow's existing advertised scope; content authorization still uses DB roles/CASL. */
export const DEVICE_TOKEN_SCOPE = "content:read progress";
