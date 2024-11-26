// Copyright 2020-2024 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import path from 'path';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CosmosDataSource } from '@subql/common-cosmos';
import {
  NodeConfig,
  StoreService,
  PoiSyncService,
  IStoreModelProvider,
  IProjectService,
  WorkerBlockDispatcher,
  ConnectionPoolStateManager,
  IProjectUpgradeService,
  InMemoryCacheService,
  createIndexerWorker,
  MonitorServiceInterface,
} from '@subql/node-core';
import { SubqueryProject } from '../../configure/SubqueryProject';
import { CosmosClientConnection } from '../cosmosClient.connection';
import { DynamicDsService } from '../dynamic-ds.service';
import { BlockContent } from '../types';
import { UnfinalizedBlocksService } from '../unfinalizedBlocks.service';
import { IIndexerWorker } from '../worker/worker';
import { FetchBlockResponse } from '../worker/worker.service';

type IndexerWorker = IIndexerWorker & {
  terminate: () => Promise<number>;
};

@Injectable()
export class WorkerBlockDispatcherService
  extends WorkerBlockDispatcher<CosmosDataSource, IndexerWorker, BlockContent>
  implements OnApplicationShutdown
{
  constructor(
    nodeConfig: NodeConfig,
    eventEmitter: EventEmitter2,
    @Inject('IProjectService')
    projectService: IProjectService<CosmosDataSource>,
    @Inject('IProjectUpgradeService')
    projectUpgadeService: IProjectUpgradeService,
    cacheService: InMemoryCacheService,
    storeService: StoreService,
    @Inject('IStoreModelProvider') storeModelProvider: IStoreModelProvider,
    poiSyncService: PoiSyncService,
    @Inject('ISubqueryProject') project: SubqueryProject,
    dynamicDsService: DynamicDsService,
    unfinalizedBlocksSevice: UnfinalizedBlocksService,
    connectionPoolState: ConnectionPoolStateManager<CosmosClientConnection>,
    monitorService?: MonitorServiceInterface,
  ) {
    super(
      nodeConfig,
      eventEmitter,
      projectService,
      projectUpgadeService,
      storeService,
      storeModelProvider,
      poiSyncService,
      project,
      () =>
        createIndexerWorker<
          IIndexerWorker,
          CosmosClientConnection,
          BlockContent,
          CosmosDataSource
        >(
          path.resolve(__dirname, '../../../dist/indexer/worker/worker.js'),
          [],
          storeService.getStore(),
          cacheService.getCache(),
          dynamicDsService,
          unfinalizedBlocksSevice,
          connectionPoolState,
          project.root,
          projectService.startHeight,
          monitorService,
          {
            tempDir: project.tempDir,
          },
        ),
      monitorService,
    );
  }

  async init(onDynamicDsCreated: (height: number) => void): Promise<void> {
    await super.init(onDynamicDsCreated);
  }

  protected async fetchBlock(
    worker: IndexerWorker,
    height: number,
  ): Promise<FetchBlockResponse> {
    // const start = new Date();
    return worker.fetchBlock(height, 0 /* Value is not used with cosmos*/);
    // const end = new Date();

    // const waitTime = end.getTime() - start.getTime();
    // if (waitTime > 1000) {
    //   logger.info(
    //     `Waiting to fetch block ${height}: ${chalk.red(`${waitTime}ms`)}`,
    //   );
    // } else if (waitTime > 200) {
    //   logger.info(
    //     `Waiting to fetch block ${height}: ${chalk.yellow(`${waitTime}ms`)}`,
    //   );
    // }
  }
}
