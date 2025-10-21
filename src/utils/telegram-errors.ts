const getErrorString = (value: unknown): string => {
  if (typeof value === "string") {
    return value;
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const description = (value as any).description ?? (value as any).message;
  return typeof description === "string" ? description : "";
};

const normalize = (value: unknown): string => getErrorString(value).toLowerCase();

export const getErrorDescription = (error: unknown): string => getErrorString(error);

export const isMessageNotModified = (error: unknown): boolean => {
  const description = normalize(error);
  return description.includes("message is not modified");
};

export const isMessageMissing = (error: unknown): boolean => {
  const description = normalize(error);
  if (!description) {
    return false;
  }

  return (
    description.includes("message to edit not found") ||
    description.includes("message to delete not found") ||
    description.includes("message not found")
  );
};

export const isEditProhibited = (error: unknown): boolean => {
  const description = normalize(error);
  if (!description) {
    return false;
  }

  return (
    description.includes("message can't be edited") ||
    description.includes("message cant be edited")
  );
};

export const isChatInaccessible = (error: unknown): boolean => {
  const description = normalize(error);
  if (!description) {
    return false;
  }

  return (
    description.includes("have no access to the chat") ||
    description.includes("bot was blocked by the user")
  );
};

export const isMissingEditableContent = (error: unknown): boolean => {
  const description = normalize(error);
  if (!description) {
    return false;
  }

  return (
    description.includes("there is no text in the message to edit") ||
    description.includes("there is no caption in the message to edit")
  );
};

export const isDuplicateContent = (error: unknown): boolean => {
  const description = normalize(error);
  if (!description) {
    return false;
  }

  return description.includes("message with the same content already exists");
};

export const shouldFallbackToReply = (error: unknown): boolean =>
  isMessageMissing(error) ||
  isEditProhibited(error) ||
  isChatInaccessible(error) ||
  isDuplicateContent(error) ||
  isMissingEditableContent(error);
