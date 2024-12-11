// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  NodeConfig,
  IStoreModelProvider,
  StoreService,
  IProjectService,
  PoiSyncService,
  BlockDispatcher,
  ProcessBlockResponse,
  IProjectUpgradeService,
  IBlock,
} from '@subql/node-core';
import { CosmosDatasource } from '@subql/types-cosmos';
import { SubqueryProject } from '../../configure/SubqueryProject';
import { ApiService } from '../api.service';
import { IndexerManager } from '../indexer.manager';
import { BlockContent, getBlockSize } from '../types';

/**
 * @description Intended to behave the same as WorkerBlockDispatcherService but doesn't use worker threads or any parallel processing
 */
@Injectable()
export class BlockDispatcherService
  extends BlockDispatcher<BlockContent, CosmosDatasource>
  implements OnApplicationShutdown
{
  constructor(
    apiService: ApiService,
    nodeConfig: NodeConfig,
    private indexerManager: IndexerManager,
    eventEmitter: EventEmitter2,
    @Inject('IProjectService')
    projectService: IProjectService<CosmosDatasource>,
    @Inject('IProjectUpgradeService')
    projectUpgradeService: IProjectUpgradeService,
    storeService: StoreService,
    @Inject('IStoreModelProvider') storeModelProvider: IStoreModelProvider,
    poiSyncService: PoiSyncService,
    @Inject('ISubqueryProject') project: SubqueryProject,
  ) {
    super(
      nodeConfig,
      eventEmitter,
      projectService,
      projectUpgradeService,
      storeService,
      storeModelProvider,
      poiSyncService,
      project,
      apiService.fetchBlocks.bind(apiService),
    );
  }

  async init(onDynamicDsCreated: (height: number) => void): Promise<void> {
    await super.init(onDynamicDsCreated);
  }

  protected getBlockHeight(block: BlockContent): number {
    return block.block.block.header.height;
  }

  protected async indexBlock(
    block: IBlock<BlockContent>,
  ): Promise<ProcessBlockResponse> {
    return this.indexerManager.indexBlock(
      block,
      await this.projectService.getDataSources(block.getHeader().blockHeight),
    );
  }

  protected getBlockSize(block: IBlock<BlockContent>): number {
    return getBlockSize(block.block);
  }
}
