import { ECKey } from "bigtangle-ts";
import { settlementParams } from "../src/escrow.js";

/** A real base58 destination on the engine's settlement network. */
export function testAddress(): string {
  return ECKey.createNewKey().toAddress(settlementParams()).toBase58();
}

export const RECEIVE_ADDRESS = testAddress();
