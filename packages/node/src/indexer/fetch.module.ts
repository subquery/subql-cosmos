// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import path from 'node:path';
import { Module } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CoreModule,
  StoreService,
  PoiSyncService,
  NodeConfig,
  IStoreModelProvider,
  ConnectionPoolStateManager,
  IProjectUpgradeService,
  InMemoryCacheService,
  MonitorService,
  ConnectionPoolService,
  ProjectService,
  DynamicDsService,
  UnfinalizedBlocksService,
  FetchService,
  DsProcessorService,
  DictionaryService,
  WorkerBlockDispatcher,
  BlockDispatcher,
} from '@subql/node-core';
import { CosmosDatasource } from '@subql/types-cosmos';
import { BlockchainService } from '../blockchain.service';
import { SubqueryProject } from '../configure/SubqueryProject';
import { ApiService } from './api.service';
import { CosmosClientConnection } from './cosmosClient.connection';
import { DictionaryService as CosmosDictionaryService } from './dictionary/dictionary.service';
import { IndexerManager } from './indexer.manager';

@Module({
  imports: [CoreModule],
  providers: [
    {
      provide: 'APIService',
      useFactory: ApiService.create.bind(ApiService),
      inject: [
        'ISubqueryProject',
        ConnectionPoolService,
        EventEmitter2,
        NodeConfig,
      ],
    },
    {
      provide: 'IBlockchainService',
      useClass: BlockchainService,
    },
    IndexerManager,
    {
      provide: 'IBlockDispatcher',
      useFactory: (
        nodeConfig: NodeConfig,
        eventEmitter: EventEmitter2,
        projectService: ProjectService<CosmosDatasource>,
        projectUpgradeService: IProjectUpgradeService,
        cacheService: InMemoryCacheService,
        storeService: StoreService,
        storeModelProvider: IStoreModelProvider,
        poiSyncService: PoiSyncService,
        project: SubqueryProject,
        dynamicDsService: DynamicDsService<CosmosDatasource>,
        unfinalizedBlocks: UnfinalizedBlocksService,
        connectionPoolState: ConnectionPoolStateManager<CosmosClientConnection>,
        blockchainService: BlockchainService,
        indexerManager: IndexerManager,
        monitorService?: MonitorService,
      ) =>
        nodeConfig.workers
          ? new WorkerBlockDispatcher(
              nodeConfig,
              eventEmitter,
              projectService,
              projectUpgradeService,
              storeService,
              storeModelProvider,
              cacheService,
              poiSyncService,
              dynamicDsService,
              unfinalizedBlocks,
              connectionPoolState,
              project,
              blockchainService,
              path.resolve(__dirname, '../../dist/indexer/worker/worker.js'),
              [],
              monitorService,
              // {
              //   // Needed for kyve
              //   tempDir: project.tempDir,
              // }
            )
          : new BlockDispatcher(
              nodeConfig,
              eventEmitter,
              projectService,
              projectUpgradeService,
              storeService,
              storeModelProvider,
              poiSyncService,
              project,
              blockchainService,
              indexerManager,
            ),
      inject: [
        NodeConfig,
        EventEmitter2,
        'IProjectService',
        'IProjectUpgradeService',
        InMemoryCacheService,
        StoreService,
        'IStoreModelProvider',
        PoiSyncService,
        'ISubqueryProject',
        DynamicDsService,
        'IUnfinalizedBlocksService',
        ConnectionPoolStateManager,
        'IBlockchainService',
        IndexerManager,
        MonitorService,
      ],
    },
    FetchService,
    {
      provide: DictionaryService,
      useClass: CosmosDictionaryService,
    },
    DsProcessorService,
    DynamicDsService,
    {
      useClass: ProjectService,
      provide: 'IProjectService',
    },
    {
      provide: 'IUnfinalizedBlocksService',
      useClass: UnfinalizedBlocksService,
    },
  ],
})
export class FetchModule {}
