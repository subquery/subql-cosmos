// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Injectable } from '@nestjs/common';
import {
  CosmosHandlerKind,
  CosmosRuntimeHandlerInputMap,
  isBatchEventHandlerProcessor,
  isBatchMessageHandlerProcessor,
  isBatchTransactionHandlerProcessor,
  isBlockHandlerProcessor,
  isCustomCosmosDs,
  isEventHandlerProcessor,
  isMessageHandlerProcessor,
  isPostIndexHandlerProcessor,
  isRuntimeCosmosDs,
  isTransactionHandlerProcessor,
} from '@subql/common-cosmos';
import {
  BaseIndexerManager,
  IBlock,
  IndexerSandbox,
  NodeConfig,
  ProcessBlockResponse,
  profiler,
  SandboxService,
} from '@subql/node-core';
import {
  CosmosBlock,
  CosmosCustomDatasource,
  CosmosDatasource,
  CosmosEvent,
  CosmosEventKind,
  CosmosMessage,
  CosmosTransaction,
} from '@subql/types-cosmos';
import * as CosmosUtil from '../utils/cosmos';
import {
  ApiService as CosmosApiService,
  CosmosClient,
  CosmosSafeClient,
} from './api.service';
import { DsProcessorService } from './ds-processor.service';
import { DynamicDsService } from './dynamic-ds.service';
import { BlockContent } from './types';
import { UnfinalizedBlocksService } from './unfinalizedBlocks.service';

@Injectable()
export class IndexerManager extends BaseIndexerManager<
  CosmosClient,
  CosmosSafeClient,
  BlockContent,
  CosmosApiService,
  CosmosDatasource,
  CosmosCustomDatasource,
  typeof FilterTypeMap,
  typeof ProcessorTypeMap,
  CosmosRuntimeHandlerInputMap
> {
  protected isRuntimeDs = isRuntimeCosmosDs;
  protected isCustomDs = isCustomCosmosDs;

  constructor(
    apiService: CosmosApiService,
    nodeConfig: NodeConfig,
    sandboxService: SandboxService<CosmosSafeClient, CosmosClient>,
    dsProcessorService: DsProcessorService,
    dynamicDsService: DynamicDsService,
    unfinalizedBlocksService: UnfinalizedBlocksService,
  ) {
    super(
      apiService,
      nodeConfig,
      sandboxService,
      dsProcessorService,
      dynamicDsService,
      unfinalizedBlocksService,
      FilterTypeMap,
      ProcessorTypeMap,
    );
  }

  protected getDsProcessor(
    ds: CosmosDatasource,
    safeApi: CosmosSafeClient,
  ): IndexerSandbox {
    // SandboxService is private, this is a temp workaround
    const sandbox = (this as any).sandboxService as SandboxService<
      CosmosSafeClient,
      CosmosClient
    >;
    return sandbox.getDsProcessor(ds, safeApi, this.apiService.unsafeApi, {
      registry: this.apiService.registry,
    });
  }

  @profiler()
  async indexBlock(
    block: IBlock<BlockContent>,
    dataSources: CosmosDatasource[],
  ): Promise<ProcessBlockResponse> {
    return super.internalIndexBlock(block, dataSources, () =>
      this.getApi(block.block),
    );
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async getApi(block: BlockContent): Promise<CosmosSafeClient> {
    return this.apiService.getSafeApi(block.block.header.height);
  }

  protected async indexBlockData(
    blockContent: BlockContent,
    dataSources: CosmosDatasource[],
    getVM: (d: CosmosDatasource) => Promise<IndexerSandbox>,
  ): Promise<void> {
    await this.indexBlockContent(blockContent, dataSources, getVM);

    const msgsTxMap = {};
    const evntsTxMap = {};

    blockContent.messages.forEach((msg) => {
      if (!msgsTxMap[msg.tx.hash]) msgsTxMap[msg.tx.hash] = [];
      msgsTxMap[msg.tx.hash].push(msg);
    });

    blockContent.events.forEach((event) => {
      const key = `${event.tx?.hash}`;
      if (!evntsTxMap[key]) {
        evntsTxMap[key] = { msg: [], nonMsg: [] };
      }
      // if we get any number, is a right value.
      if (typeof event.msg?.idx === 'number') evntsTxMap[key].msg.push(event);
      else evntsTxMap[key].nonMsg.push(event);
    });

    await this.indexBatchEvents(
      blockContent.beginBlockEvents ?? [],
      dataSources,
      getVM,
    );

    for (const evt of blockContent.beginBlockEvents ?? []) {
      await this.indexEvent(evt, dataSources, getVM);
    }

    // this will pass all the finalizeBlockEvents at once to all the datasource handlers of kind CosmosHandlerKind.BatchTransaction
    await this.indexBatchTransactions(
      blockContent.transactions,
      dataSources,
      getVM,
    );

    for (const tx of blockContent.transactions) {
      await this.indexTransaction(tx, dataSources, getVM);
      // not efficient at all because for every transaction it iterates over the whole list of messages again.
      // const msgs = blockContent.messages.filter(
      //   (msg) => msg.tx.hash === tx.hash,
      // );
      const msgs = msgsTxMap[tx.hash] ?? [];
      for (const msg of msgs) {
        await this.indexMessage(msg, dataSources, getVM);
        // Not efficient at all because for every transaction it iterates over the whole list of events again.
        // Also, miss the non-msg related events.
        // const events = blockContent.events.filter(
        //   (event) => event.tx.hash === tx.hash && event.msg?.idx === msg.idx,
        // );
        const eventMap = evntsTxMap[tx.hash] ?? { msg: [], nonMsg: [] };

        for (const evt of eventMap.msg) {
          await this.indexEvent(evt, dataSources, getVM);
        }

        for (const evt of eventMap.nonMsg) {
          await this.indexEvent(evt, dataSources, getVM);
        }
      }
    }

    // this will pass all the messages at once to all the datasource handlers of kind CosmosHandlerKind.BatchMessages
    await this.indexBatchMessages(blockContent.messages, dataSources, getVM);

    // this will pass all the message events at once to all the datasource handlers of kind CosmosHandlerKind.BatchEvent
    await this.indexBatchEvents(
      blockContent.events.filter((evt) => evt.kind === CosmosEventKind.Message),
      dataSources,
      getVM,
    );

    // this will pass all the transaction events at once to all the datasource handlers of kind CosmosHandlerKind.BatchEvent
    await this.indexBatchEvents(
      blockContent.events.filter(
        (evt) => evt.kind === CosmosEventKind.Transaction,
      ),
      dataSources,
      getVM,
    );

    // this will pass all the endBlockEvents at once to all the datasource handlers of kind CosmosHandlerKind.BatchEvent
    await this.indexBatchEvents(
      blockContent.endBlockEvents ?? [],
      dataSources,
      getVM,
    );

    for (const evt of blockContent.endBlockEvents ?? []) {
      await this.indexEvent(evt, dataSources, getVM);
    }

    // this will pass all the finalizeBlockEvents at once to all the datasource handlers of kind CosmosHandlerKind.BatchEvent
    await this.indexBatchEvents(
      blockContent.finalizeBlockEvents ?? [],
      dataSources,
      getVM,
    );

    for (const evt of blockContent.finalizeBlockEvents ?? []) {
      await this.indexEvent(evt, dataSources, getVM);
    }

    await this.postIndexHook(blockContent, dataSources, getVM);
  }

  private async indexBlockContent(
    block: BlockContent,
    dataSources: CosmosDatasource[],
    getVM: (d: CosmosDatasource) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexData(CosmosHandlerKind.Block, block.block, ds, getVM);
    }
  }

  private async indexTransaction(
    tx: CosmosTransaction,
    dataSources: CosmosDatasource[],
    getVM: (d: CosmosDatasource) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexData(CosmosHandlerKind.Transaction, tx, ds, getVM);
    }
  }

  private async indexBatchTransactions(
    txs: CosmosTransaction[],
    dataSources: CosmosDatasource[],
    getVM: (d: CosmosDatasource) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexBatchData(
        CosmosHandlerKind.BatchTransaction,
        txs,
        ds,
        getVM,
      );
    }
  }

  private async indexMessage(
    message: CosmosMessage,
    dataSources: CosmosDatasource[],
    getVM: (d: CosmosDatasource) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexData(CosmosHandlerKind.Message, message, ds, getVM);
    }
  }

  private async indexBatchMessages(
    messages: CosmosMessage[],
    dataSources: CosmosDatasource[],
    getVM: (d: CosmosDatasource) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexBatchData(
        CosmosHandlerKind.BatchMessage,
        messages,
        ds,
        getVM,
      );
    }
  }

  private async indexEvent(
    event: CosmosEvent,
    dataSources: CosmosDatasource[],
    getVM: (d: CosmosDatasource) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexData(CosmosHandlerKind.Event, event, ds, getVM);
    }
  }

  private async indexBatchEvents(
    events: CosmosEvent[],
    dataSources: CosmosDatasource[],
    getVM: (d: CosmosDatasource) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexBatchData(
        CosmosHandlerKind.BatchEvent,
        events,
        ds,
        getVM,
      );
    }
  }

  private async postIndexHook(
    block: BlockContent,
    dataSources: CosmosDatasource[],
    getVM: (d: CosmosDatasource) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexData(CosmosHandlerKind.PostIndex, block.block, ds, getVM);
    }
  }

  protected async prepareFilteredData<T = any>(
    kind: CosmosHandlerKind,
    data: T,
  ): Promise<T> {
    // Substrate doesn't need to do anything here
    return Promise.resolve(data);
  }

  protected baseCustomHandlerFilter(
    kind: CosmosHandlerKind,
    data: any,
    baseFilter: any,
  ): boolean {
    switch (kind) {
      case CosmosHandlerKind.Block:
        return !!CosmosUtil.filterBlock(data as CosmosBlock, baseFilter);
      case CosmosHandlerKind.Transaction:
        return !!CosmosUtil.filterTx(data as CosmosTransaction, baseFilter);
      case CosmosHandlerKind.BatchTransaction:
        return !!CosmosUtil.filterBatchTxs(
          data as CosmosTransaction[],
          baseFilter,
        );
      case CosmosHandlerKind.Message:
        return !!CosmosUtil.filterMessages([data as CosmosMessage], baseFilter)
          .length;
      case CosmosHandlerKind.BatchMessage:
        return !!CosmosUtil.filterBatchMessages(
          data as CosmosMessage[],
          baseFilter,
        );
      case CosmosHandlerKind.Event:
        return !!CosmosUtil.filterEvents([data as CosmosEvent], baseFilter)
          .length;
      case CosmosHandlerKind.BatchEvent:
        return !!CosmosUtil.filterBatchEvents(
          data as CosmosEvent[],
          baseFilter,
        );
      default:
        throw new Error('Unsupported handler kind');
    }
  }
}

type ProcessorTypeMap = {
  [CosmosHandlerKind.Block]: typeof isBlockHandlerProcessor;
  [CosmosHandlerKind.Event]: typeof isEventHandlerProcessor;
  [CosmosHandlerKind.Transaction]: typeof isTransactionHandlerProcessor;
  [CosmosHandlerKind.Message]: typeof isMessageHandlerProcessor;
  [CosmosHandlerKind.PostIndex]: typeof isPostIndexHandlerProcessor;
  // Batch handlers
  [CosmosHandlerKind.BatchTransaction]: typeof isBatchTransactionHandlerProcessor;
  [CosmosHandlerKind.BatchEvent]: typeof isBatchEventHandlerProcessor;
  [CosmosHandlerKind.BatchMessage]: typeof isBatchMessageHandlerProcessor;
};

const ProcessorTypeMap = {
  [CosmosHandlerKind.Block]: isBlockHandlerProcessor,
  [CosmosHandlerKind.Event]: isEventHandlerProcessor,
  [CosmosHandlerKind.Transaction]: isTransactionHandlerProcessor,
  [CosmosHandlerKind.Message]: isMessageHandlerProcessor,
  [CosmosHandlerKind.PostIndex]: isPostIndexHandlerProcessor,
  // Batch handlers
  [CosmosHandlerKind.BatchEvent]: isBatchEventHandlerProcessor,
  [CosmosHandlerKind.BatchTransaction]: isBatchTransactionHandlerProcessor,
  [CosmosHandlerKind.BatchMessage]: isBatchMessageHandlerProcessor,
};

const FilterTypeMap = {
  [CosmosHandlerKind.Block]: CosmosUtil.filterBlock,
  [CosmosHandlerKind.Transaction]: CosmosUtil.filterTx,
  [CosmosHandlerKind.Event]: CosmosUtil.filterEvent,
  [CosmosHandlerKind.Message]: CosmosUtil.filterMessageData,
  [CosmosHandlerKind.PostIndex]: CosmosUtil.filterBlock,
  // Batch handlers
  [CosmosHandlerKind.BatchTransaction]: CosmosUtil.filterTx,
  [CosmosHandlerKind.BatchEvent]: CosmosUtil.filterEvent,
  [CosmosHandlerKind.BatchMessage]: CosmosUtil.filterMessageData,
};
