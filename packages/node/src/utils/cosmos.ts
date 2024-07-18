// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import assert from 'assert';
import { TextDecoder } from 'util';
import { sha256 } from '@cosmjs/crypto';
import { toHex } from '@cosmjs/encoding';
import { DecodeObject, decodeTxRaw, Registry } from '@cosmjs/proto-signing';
import { fromTendermintEvent } from '@cosmjs/stargate';
import { Log, parseRawLog } from '@cosmjs/stargate/build/logs';
import {
  toRfc3339WithNanoseconds,
  tendermint34,
  tendermint37,
  comet38,
} from '@cosmjs/tendermint-rpc';
import {
  IBlock,
  getLogger,
  Header,
  filterBlockTimestamp,
} from '@subql/node-core';
import {
  TxData,
  TxEvent,
  Header as CosmosHeader,
  CosmosEventFilter,
  CosmosMessageFilter,
  CosmosBlock,
  CosmosEvent,
  CosmosTransaction,
  CosmosMessage,
  CosmosBlockFilter,
  CosmosTxFilter,
} from '@subql/types-cosmos';
import { isObjectLike } from 'lodash';
import { isLong } from 'long';
import { SubqlProjectBlockFilter } from '../configure/SubqueryProject';
import { CosmosClient } from '../indexer/api.service';
import {
  BlockContent,
  BlockResponse,
  BlockResultsResponse,
} from '../indexer/types';

const logger = getLogger('fetch');

export function decodeMsg<T = unknown>(
  msg: DecodeObject,
  registry: Registry,
): T {
  try {
    const decodedMsg = registry.decode(msg);
    if (
      [
        '/cosmwasm.wasm.v1.MsgExecuteContract',
        '/cosmwasm.wasm.v1.MsgMigrateContract',
        '/cosmwasm.wasm.v1.MsgInstantiateContract',
      ].includes(msg.typeUrl)
    ) {
      decodedMsg.msg = JSON.parse(new TextDecoder().decode(decodedMsg.msg));
    }
    return decodedMsg;
  } catch (e) {
    logger.error(e, 'Failed to decode message');
    throw e;
  }
}

export function filterBlock(
  data: CosmosBlock,
  filter?: CosmosBlockFilter,
): boolean {
  if (!filter) {
    return true;
  }
  if (
    !filterBlockTimestamp(
      getBlockTimestamp(data.header).getTime(),
      filter as SubqlProjectBlockFilter,
    )
  ) {
    return false;
  }
  if (filter.modulo && data.block.header.height % filter.modulo !== 0) {
    return false;
  }
  return true;
}

export function getBlockTimestamp(blockHeader: CosmosHeader): Date {
  return new Date(toRfc3339WithNanoseconds(blockHeader.time));
}

export function filterTx(
  data: CosmosTransaction,
  filter?: CosmosTxFilter,
): boolean {
  if ((!filter || !filter.includeFailedTx) && data.tx.code !== 0) {
    logger.debug(`filtered out failed tx {${data.hash}}`);
    return false;
  }
  if (filter?.includeFailedTx) {
    return true;
  }
  return true;
}

export function filterMessageData(
  data: CosmosMessage,
  filter?: CosmosMessageFilter,
): boolean {
  if (!filter) return true;
  if (!filterTx(data.tx, filter)) {
    return false;
  }
  if (filter.type !== data.msg.typeUrl) {
    return false;
  }
  if (filter.values) {
    for (const key in filter.values) {
      let decodedMsgData: unknown;
      try {
        decodedMsgData = key
          .split('.')
          .reduce((acc, curr) => acc[curr], data.msg.decodedMsg);
      } catch (e) {
        // This message is assuming an error where acc[curr] is undefined and tries to access a further nested property
        logger.warn(`Message doesn't contain data at value with path ${key}`);
        return false;
      }

      //stringify Long for equality check
      if (isLong(decodedMsgData)) {
        decodedMsgData =
          typeof filter.values[key] === 'number'
            ? decodedMsgData.toNumber()
            : decodedMsgData.toString();
      }
      if (filter.values[key] !== decodedMsgData) {
        return false;
      }
    }
  }
  if (
    filter.type === '/cosmwasm.wasm.v1.MsgExecuteContract' &&
    filter.contractCall &&
    !(
      filter.contractCall === data.msg.decodedMsg.msg ||
      (isObjectLike(data.msg.decodedMsg.msg) &&
        filter.contractCall in data.msg.decodedMsg.msg)
    )
  ) {
    return false;
  }
  return true;
}

export function filterMessages(
  messages: CosmosMessage[],
  filterOrFilters?: CosmosMessageFilter | CosmosMessageFilter[] | undefined,
): CosmosMessage[] {
  if (messages === null) {
    return [];
  }

  if (
    !filterOrFilters ||
    (filterOrFilters instanceof Array && filterOrFilters.length === 0)
  ) {
    return messages;
  }

  const filters =
    filterOrFilters instanceof Array ? filterOrFilters : [filterOrFilters];

  const filteredMessages = messages.filter((message) =>
    filters.find((filter) => filterMessageData(message, filter)),
  );
  return filteredMessages;
}

export function filterEvent(
  event: CosmosEvent,
  filter?: CosmosEventFilter,
): boolean {
  if (!filter) return true;
  if (filter.type !== event.event.type) {
    return false;
  }

  if (
    filter.messageFilter &&
    (!event.msg || !filterMessageData(event.msg, filter.messageFilter))
  ) {
    return false;
  }

  for (const filterKey in filter.attributes) {
    if (
      !event.event.attributes.find(
        ({ key, value }) =>
          key === filterKey && value === filter.attributes[filterKey],
      )
    ) {
      return false;
    }
  }

  return true;
}

export function filterEvents(
  events: CosmosEvent[],
  filterOrFilters?: CosmosEventFilter | CosmosEventFilter[] | undefined,
): CosmosEvent[] {
  if (
    !filterOrFilters ||
    (filterOrFilters instanceof Array && filterOrFilters.length === 0)
  ) {
    return events;
  }

  const filters =
    filterOrFilters instanceof Array ? filterOrFilters : [filterOrFilters];
  const filteredEvents = events.filter((event) =>
    filters.find((filter) => filterEvent(event, filter)),
  );
  return filteredEvents;
}

async function getBlockByHeightByRpc(
  api: CosmosClient,
  height: number,
): Promise<[BlockResponse, BlockResultsResponse]> {
  return Promise.all([
    api.blockInfo(height).catch((e) => {
      throw CosmosClient.handleError(e);
    }),
    api.blockResults(height).catch((e) => {
      throw CosmosClient.handleError(e);
    }),
  ]);
}

export async function fetchCosmosBlocksArray(
  getBlockByHeight: (
    height: number,
  ) => Promise<[BlockResponse, BlockResultsResponse]>,
  blockArray: number[],
): Promise<[BlockResponse, BlockResultsResponse][]> {
  return Promise.all(
    blockArray.map(async (height) => getBlockByHeight(height)),
  );
}

export function wrapBlock(block: BlockResponse, txs: TxData[]): CosmosBlock {
  return {
    blockId: block.blockId,
    block: { id: toHex(block.blockId.hash).toUpperCase(), ...block.block },
    header: block.block.header,
    txs: txs,
  };
}

export function wrapTx(
  block: CosmosBlock,
  txResults: TxData[],
): CosmosTransaction[] {
  return txResults.map((tx, idx) => ({
    idx,
    block: block,
    tx,
    hash: toHex(sha256(block.block.txs[idx])).toUpperCase(),
    get decodedTx() {
      delete (this as any).decodedTx;
      return ((this.decodedTx as any) = decodeTxRaw(block.block.txs[idx]));
    },
  }));
}

export function wrapCosmosMsg(
  block: CosmosBlock,
  tx: CosmosTransaction,
  idx: number,
  registry: Registry,
): CosmosMessage {
  const rawMessage = tx.decodedTx.body.messages[idx];
  return {
    idx,
    tx: tx,
    block: block,
    msg: {
      typeUrl: rawMessage.typeUrl,
      get decodedMsg() {
        delete this.decodedMsg;
        return (this.decodedMsg = decodeMsg(rawMessage, registry));
      },
    },
  };
}

function wrapMsg(
  block: CosmosBlock,
  txs: CosmosTransaction[],
  registry: Registry,
): CosmosMessage[] {
  const msgs: CosmosMessage[] = [];
  for (const tx of txs) {
    for (let i = 0; i < tx.decodedTx.body.messages.length; i++) {
      msgs.push(wrapCosmosMsg(block, tx, i, registry));
    }
  }
  return msgs;
}

export function wrapBlockBeginAndEndEvents(
  block: CosmosBlock,
  events: TxEvent[],
  idxOffset: number,
): CosmosEvent[] {
  return events.map(
    (event) =>
      <CosmosEvent>{
        idx: idxOffset++,
        event: fromTendermintEvent(event),
        block: block,
        msg: null,
        tx: null,
        log: null,
      },
  );
}

// With tendermint34 the Attrbutes type key and value were Uint8Arrays
function attrToString(value: string | Uint8Array): string {
  return typeof value === 'string'
    ? value
    : Buffer.from(value).toString('utf8');
}

export function wrapEvent(
  block: CosmosBlock,
  txs: CosmosTransaction[],
  registry: Registry,
  idxOffset: number, //use this offset to avoid clash with idx of begin block events
): CosmosEvent[] {
  const cosmosEvents: CosmosEvent[] = [];

  for (const tx of txs) {
    let txEvents: readonly TxEvent[];
    try {
      txEvents = tx.tx.events;
    } catch (e) {
      //parsing fails if transaction had failed.
      logger.debug('Failed to parse raw log, most likely a failed transaction');
      return cosmosEvents;
    }
    for (const txEvent of txEvents) {
      let msg: CosmosMessage;
      try {
        const eventMsgIndex = txEvent.attributes.find(
          (attr) => attrToString(attr.key) === 'msg_index',
        )?.value;

        if (eventMsgIndex === undefined) {
          continue;
        }

        const msgNumber = parseInt(attrToString(eventMsgIndex), 10);
        msg = wrapCosmosMsg(block, tx, msgNumber, registry);
      } catch (e) {
        // Example where this can happen https://sei.explorers.guru/transaction/8D4CA68E917E15652E10CB960DE604AEEB1B183D6E94A85E9CD98403F15550B7
        logger.warn(`Unable to find message for event. tx=${tx.hash}`);
        continue;
      }
      const cosmosEvent: CosmosEvent = {
        idx: idxOffset++,
        msg,
        tx,
        block,
        log: {
          msg_index: msg.idx,
          log: txEvent.log,
          events: txEvent.events,
        },
        event: txEvent,
      };
      cosmosEvents.push(cosmosEvent);
    }
  }
  return cosmosEvents;
}

/*
 * Cosmos has instant finalization, there is also no rpc method to get a block by hash
 * To get around this we use blockHeights as hashes
 */
export function cosmosBlockToHeader(blockHeight: number): Header {
  return {
    blockHeight: blockHeight,
    blockHash: blockHeight.toString(),
    parentHash: (blockHeight - 1).toString(),
  };
}

export function formatBlockUtil<B extends BlockContent>(block: B): IBlock<B> {
  return {
    block,
    getHeader: () => cosmosBlockToHeader(block.block.header.height),
  };
}

export async function fetchBlocksBatches(
  api: CosmosClient,
  blockArray: number[],
): Promise<IBlock<BlockContent>[]> {
  const blocks = await fetchCosmosBlocksArray(
    (height: number) => getBlockByHeightByRpc(api, height),
    blockArray,
  );

  return blocks.map(([blockInfo, blockResults]) => {
    try {
      assert(
        blockResults.results.length === blockInfo.block.txs.length,
        `txInfos doesn't match up with block (${blockInfo.block.header.height}) transactions expected ${blockInfo.block.txs.length}, received: ${blockResults.results.length}`,
      );

      return formatBlockUtil(
        new LazyBlockContent(blockInfo, blockResults, api.registry),
      );
    } catch (e) {
      logger.error(
        e,
        `Failed to fetch and prepare block ${blockInfo.block.header.height}`,
      );
      throw e;
    }
  });
}

export class LazyBlockContent implements BlockContent {
  private _wrappedBlock: CosmosBlock;
  private _wrappedTransaction: CosmosTransaction[];
  private _wrappedMessage: CosmosMessage[];
  private _wrappedEvent: CosmosEvent[];
  private _wrappedBeginBlockEvents: CosmosEvent[];
  private _wrappedEndBlockEvents: CosmosEvent[];
  private _eventIdx = 0; //To maintain a valid count over begin block events, tx events and end block events

  constructor(
    private _blockInfo: BlockResponse,
    private _results: BlockResultsResponse,
    private _registry: Registry,
  ) {}

  get block() {
    if (!this._wrappedBlock) {
      this._wrappedBlock = wrapBlock(this._blockInfo, [
        ...this._results.results,
      ]);
    }
    return this._wrappedBlock;
  }

  get transactions() {
    if (!this._wrappedTransaction) {
      this._wrappedTransaction = wrapTx(this.block, [...this._results.results]);
    }
    return this._wrappedTransaction;
  }

  get messages() {
    if (!this._wrappedMessage) {
      this._wrappedMessage = wrapMsg(
        this.block,
        this.transactions,
        this._registry,
      );
    }
    return this._wrappedMessage;
  }

  get events() {
    if (!this._wrappedEvent) {
      this._wrappedEvent = wrapEvent(
        this.block,
        this.transactions,
        this._registry,
        this._eventIdx,
      );
      this._eventIdx += this._wrappedEvent.length;
    }
    return this._wrappedEvent;
  }

  get beginBlockEvents() {
    if (!this._wrappedBeginBlockEvents) {
      this._wrappedBeginBlockEvents = wrapBlockBeginAndEndEvents(
        this.block,
        [...this._results.beginBlockEvents],
        this._eventIdx,
      );
      this._eventIdx += this._wrappedBeginBlockEvents.length;
    }

    return this._wrappedBeginBlockEvents;
  }

  get endBlockEvents() {
    if (!this._wrappedEndBlockEvents) {
      this._wrappedEndBlockEvents = wrapBlockBeginAndEndEvents(
        this.block,
        [...this._results.endBlockEvents],
        this._eventIdx,
      );
      this._eventIdx += this._wrappedEndBlockEvents.length;
    }

    return this._wrappedEndBlockEvents;
  }
}

export function calcInterval(api: CosmosClient): number {
  // TODO find a way to get this from the blockchain
  return 6000;
}
