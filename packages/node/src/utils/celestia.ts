// Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { DecodedTxRaw, decodeTxRaw } from '@cosmjs/proto-signing';
import { BlobTx, IndexWrapper, MalleatedTx } from './protos/celestia';

export function unwrapCelestiaTx(tx: Uint8Array): Uint8Array {
  try {
    return BlobTx.decode(tx).tx;
  } catch (error) {
    try {
      return IndexWrapper.decode(tx).tx;
    } catch (error2) {
      return MalleatedTx.decode(tx).tx;
    }
  }
}

export function decodeCelestiaTx(tx: Uint8Array): DecodedTxRaw {
  return decodeTxRaw(unwrapCelestiaTx(tx));
}
