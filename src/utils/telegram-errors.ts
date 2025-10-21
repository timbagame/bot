export const getErrorDescription = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  }

  if (!error || typeof error !== "object") {
    return "";
  }

  const description =
    (error as any).description !== undefined
      ? (error as any).description
      : (error as any).message;

  return typeof description === "string" ? description : "";
};

export const getErrorDescriptionLowerCase = (error: unknown): string => {
  const description = getErrorDescription(error);
  return description ? description.toLowerCase() : "";
};

export const isMessageMissing = (error: unknown): boolean => {
  const normalized = getErrorDescriptionLowerCase(error);
  if (!normalized) {
    return false;
  }

  return (
    normalized.includes("message to edit not found") ||
    normalized.includes("message to delete not found")
  );
};

export const isMessageNotModified = (error: unknown): boolean => {
  const normalized = getErrorDescriptionLowerCase(error);
  if (!normalized) {
    return false;
  }

  return normalized.includes("message is not modified");
};
