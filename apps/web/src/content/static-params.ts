export const EMPTY_STATIC_PARAM = "__empty__";

export function withStaticParamFallback<T>(params: T[], fallback: T) {
  return params.length > 0 ? params : [fallback];
}
