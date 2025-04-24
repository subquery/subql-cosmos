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
  ConnectionPoolStateManager,
  InMemoryCacheService,
  MonitorService,
  ConnectionPoolService,
  ProjectService,
  DynamicDsService,
  UnfinalizedBlocksService,
  FetchService,
  DsProcessorService,
  DictionaryService,
  MultiChainRewindService,
  blockDispatcherFactory,
} from '@subql/node-core';
import { BlockchainService } from '../blockchain.service';
import { SubqueryProject } from '../configure/SubqueryProject';
import { ApiService } from './api.service';
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
    MultiChainRewindService,
    {
      provide: 'IBlockDispatcher',
      useFactory: (
        ...args: Parameters<ReturnType<typeof blockDispatcherFactory>>
      ) => {
        const project = args[8] as SubqueryProject;
        return blockDispatcherFactory(
          path.resolve(__dirname, '../../dist/indexer/worker/worker.js'),
          [],
          {
            // Needed for kyve
            tempDir: project.tempDir,
          },
        )(...args);
      },
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
        MultiChainRewindService,
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
