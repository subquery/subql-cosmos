// // Copyright 2020-2025 SubQuery Pte Ltd authors & contributors
// SPDX-License-Identifier: GPL-3.0

import { Module } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ConnectionPoolService,
  NodeConfig,
  TestRunner,
  TestingCoreModule,
  ProjectService,
  UnfinalizedBlocksService,
  DsProcessorService,
  DynamicDsService,
  MultiChainRewindService,
} from '@subql/node-core';
import { BlockchainService } from '../blockchain.service';
import { ApiService } from '../indexer/api.service';
import { IndexerManager } from '../indexer/indexer.manager';

@Module({
  imports: [TestingCoreModule],
  providers: [
    {
      provide: 'IProjectService',
      useClass: ProjectService,
    },
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
      provide: 'IUnfinalizedBlocksService',
      useClass: UnfinalizedBlocksService,
    },
    {
      provide: 'IBlockchainService',
      useClass: BlockchainService,
    },
    TestRunner,
    {
      provide: 'IIndexerManager',
      useClass: IndexerManager,
    },
    DsProcessorService,
    DynamicDsService,
    MultiChainRewindService,
  ],

  controllers: [],
})
export class TestingFeatureModule {}
