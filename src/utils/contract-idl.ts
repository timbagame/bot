import { getContractCapabilities, parseContractVersion } from "@timbagame/protocol/contracts";
export const contractVersion = parseContractVersion(process.env["CONTRACT_VERSION"]);
export const contractCapabilities = getContractCapabilities(contractVersion);

export { getContractIdl } from "@timbagame/protocol/contracts/idl";

export { parseContractVersion, type ContractVersion } from "@timbagame/protocol/contracts";
