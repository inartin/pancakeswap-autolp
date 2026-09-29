import { PublicKey } from '@solana/web3.js';
import fs from 'node:fs';

export const METEORA_IDL = JSON.parse(fs.readFileSync(new URL('./idl.json', import.meta.url), 'utf8'));
export const METEORA_PROGRAM_ID = new PublicKey(METEORA_IDL.address);
