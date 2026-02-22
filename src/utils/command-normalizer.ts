export const normalizeBotCommandEntity = (
  text: string,
  entityLength: number
): string => {
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text[0] !== "/" ||
    !Number.isInteger(entityLength) ||
    entityLength <= 1 ||
    entityLength > text.length
  ) {
    return text;
  }

  const commandToken = text.slice(1, entityLength);
  const atIndex = commandToken.indexOf("@");
  const commandName = atIndex === -1 ? commandToken : commandToken.slice(0, atIndex);

  if (!commandName || !/^[A-Za-z0-9_]+$/.test(commandName)) {
    return text;
  }

  const normalizedCommandName = commandName.toLowerCase();
  if (normalizedCommandName === commandName) {
    return text;
  }

  const suffix = atIndex === -1 ? "" : commandToken.slice(atIndex);
  return `/${normalizedCommandName}${suffix}${text.slice(entityLength)}`;
};
