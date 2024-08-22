// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Injectable } from '@nestjs/common';
import {
  isBlockHandlerProcessor,
  isTransactionHandlerProcessor,
  isMessageHandlerProcessor,
  isEventHandlerProcessor,
  isCustomCosmosDs,
  isRuntimeCosmosDs,
  CosmosHandlerKind,
  CosmosRuntimeHandlerInputMap,
} from '@subql/common-cosmos';
import {
  NodeConfig,
  profiler,
  IndexerSandbox,
  ProcessBlockResponse,
  BaseIndexerManager,
  IBlock,
  SandboxService,
} from '@subql/node-core';
import {
  CosmosBlock,
  CosmosEvent,
  CosmosMessage,
  CosmosTransaction,
  CosmosCustomDatasource,
  CosmosDatasource,
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

    for (const evt of blockContent.beginBlockEvents ?? []) {
      await this.indexEvent(evt, dataSources, getVM);
    }

    for (const tx of blockContent.transactions) {
      await this.indexTransaction(tx, dataSources, getVM);
      const msgs = blockContent.messages.filter(
        (msg) => msg.tx.hash === tx.hash,
      );
      for (const msg of msgs) {
        await this.indexMessage(msg, dataSources, getVM);
        const events = blockContent.events.filter(
          (event) => event.tx.hash === tx.hash && event.msg?.idx === msg.idx,
        );

        for (const evt of events) {
          await this.indexEvent(evt, dataSources, getVM);
        }
      }
    }

    for (const evt of blockContent.endBlockEvents ?? []) {
      await this.indexEvent(evt, dataSources, getVM);
    }
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

  private async indexMessage(
    message: CosmosMessage,
    dataSources: CosmosDatasource[],
    getVM: (d: CosmosDatasource) => Promise<IndexerSandbox>,
  ): Promise<void> {
    for (const ds of dataSources) {
      await this.indexData(CosmosHandlerKind.Message, message, ds, getVM);
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
      case CosmosHandlerKind.Message:
        return !!CosmosUtil.filterMessages([data as CosmosMessage], baseFilter)
          .length;
      case CosmosHandlerKind.Event:
        return !!CosmosUtil.filterEvents([data as CosmosEvent], baseFilter)
          .length;
      default:
        throw new Error('Unsuported handler kind');
    }
  }
}

type ProcessorTypeMap = {
  [CosmosHandlerKind.Block]: typeof isBlockHandlerProcessor;
  [CosmosHandlerKind.Event]: typeof isEventHandlerProcessor;
  [CosmosHandlerKind.Transaction]: typeof isTransactionHandlerProcessor;
  [CosmosHandlerKind.Message]: typeof isMessageHandlerProcessor;
};

const ProcessorTypeMap = {
  [CosmosHandlerKind.Block]: isBlockHandlerProcessor,
  [CosmosHandlerKind.Event]: isEventHandlerProcessor,
  [CosmosHandlerKind.Transaction]: isTransactionHandlerProcessor,
  [CosmosHandlerKind.Message]: isMessageHandlerProcessor,
};

const FilterTypeMap = {
  [CosmosHandlerKind.Block]: CosmosUtil.filterBlock,
  [CosmosHandlerKind.Transaction]: CosmosUtil.filterTx,
  [CosmosHandlerKind.Event]: CosmosUtil.filterEvent,
  [CosmosHandlerKind.Message]: CosmosUtil.filterMessageData,
};
