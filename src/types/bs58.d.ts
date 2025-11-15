declare module "bs58" {
  export interface Base58 {
    encode(input: Uint8Array | number[] | Buffer): string;
    decode(input: string): Uint8Array;
  }
  const bs58: Base58;
  export default bs58;
}
