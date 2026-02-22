export const normalizeLeadingCommand = (text: string): string => {
  if (typeof text !== "string" || text.length === 0 || text[0] !== "/") {
    return text;
  }

  const firstWhitespaceIndex = text.search(/\s/);
  const commandEnd = firstWhitespaceIndex === -1 ? text.length : firstWhitespaceIndex;
  const commandToken = text.slice(1, commandEnd);

  if (commandToken.length === 0) {
    return text;
  }

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
  return `/${normalizedCommandName}${suffix}${text.slice(commandEnd)}`;
};
