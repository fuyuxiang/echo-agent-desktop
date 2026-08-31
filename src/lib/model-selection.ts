interface ModelWithId {
  id: string;
}

/** True only when an id exists in the user's configured model catalog. */
export function isConfiguredModelId(
  models: readonly ModelWithId[],
  modelId?: string,
): modelId is string {
  return !!modelId && models.some((model) => model.id === modelId);
}

/**
 * Resolve a persisted session model without falling back to another model.
 * Falling back would make the picker claim one model while the runtime session
 * is still bound to another one.
 */
export function resolveSessionModelId(
  models: readonly ModelWithId[],
  sessionModelId?: string,
): string | undefined {
  return isConfiguredModelId(models, sessionModelId)
    ? sessionModelId
    : undefined;
}

/**
 * Resolve the model shown by EchoAgent from the user's configured catalog.
 * Runtime defaults are only accepted when the same id is explicitly present
 * in that catalog, so an internal runtime fallback cannot leak into
 * an unconfigured UI or be sent to an unavailable provider.
 */
export function resolveConfiguredModelId(
  models: readonly ModelWithId[],
  currentModelId?: string,
  runtimeDefaultModelId?: string,
): string | undefined {
  if (isConfiguredModelId(models, currentModelId)) {
    return currentModelId;
  }
  if (isConfiguredModelId(models, runtimeDefaultModelId)) {
    return runtimeDefaultModelId;
  }
  return models[0]?.id;
}
