export type ReadBigIntEnvOptions = {
  key: string;
  fallback?: bigint;
  allowUndefined?: boolean;
  min?: bigint;
  description?: string;
};

const formatDescription = (key: string, description?: string): string => {
  if (description && description.trim().length > 0) {
    return description;
  }
  return key;
};

export const readBigIntEnv = ({
  key,
  fallback,
  allowUndefined = false,
  min,
  description,
}: ReadBigIntEnvOptions): bigint | undefined => {
  const rawValue = process.env[key]?.trim();
  if (!rawValue) {
    if (fallback !== undefined) {
      return fallback;
    }
    if (allowUndefined) {
      return undefined;
    }
    throw new Error(
      `${formatDescription(key, description)} must be provided via environment variable ${key}`
    );
  }

  let parsed: bigint;
  try {
    parsed = BigInt(rawValue);
  } catch (error) {
    throw new Error(
      `${formatDescription(key, description)} must be a valid integer, received "${rawValue}": ${error}`
    );
  }

  if (min !== undefined && parsed < min) {
    throw new Error(
      `${formatDescription(key, description)} must be greater than or equal to ${min}, received ${parsed}`
    );
  }

  return parsed;
};
