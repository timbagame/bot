import {
  getContractCapabilities,
  parseContractVersion,
  type ContractVersion,
} from "@timbagame/protocol/contracts";
import { timbaIdlV020 } from "@timbagame/protocol/contracts/v0.2.0";
import { timbaIdlV030 } from "@timbagame/protocol/contracts/v0.3.0";

const idls = {
  "0.2.0": timbaIdlV020,
  "0.3.0": timbaIdlV030,
} as const;

export const contractVersion = parseContractVersion(process.env["CONTRACT_VERSION"]);
export const contractCapabilities = getContractCapabilities(contractVersion);

export function getContractIdl(version: ContractVersion) {
  return idls[version];
}

export const contractIdl = getContractIdl(contractVersion);

export { parseContractVersion, type ContractVersion } from "@timbagame/protocol/contracts";
