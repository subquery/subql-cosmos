// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import type {
  tendermint34,
  tendermint37,
  comet38,
} from '@cosmjs/tendermint-rpc';
import {
  CosmosBlock,
  CosmosEvent,
  CosmosTransaction,
  CosmosMessage,
} from '@subql/types-cosmos';

export type BlockResponse =
  | tendermint34.BlockResponse
  | tendermint37.BlockResponse
  | comet38.BlockResponse;
export type BlockResultsResponse =
  | tendermint34.BlockResultsResponse
  | tendermint37.BlockResultsResponse
  | comet38.BlockResultsResponse;

export interface BlockContent {
  block: CosmosBlock;
  transactions: CosmosTransaction[];
  messages: CosmosMessage[];
  events: CosmosEvent[];
  // Tendermint34,37
  beginBlockEvents?: CosmosEvent[];
  endBlockEvents?: CosmosEvent[];

  // Comet38
  finalizeBlockEvents?: CosmosEvent[];
}

export type BestBlocks = Record<number, string>;

export function getBlockSize(block: BlockContent): number {
  return (
    block.messages.length +
    block.transactions.length +
    block.events.length +
    (block.beginBlockEvents?.length ?? 0) +
    (block.endBlockEvents?.length ?? 0) +
    (block.finalizeBlockEvents?.length ?? 0)
  );
}
